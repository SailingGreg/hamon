#! /usr/bin/env python3
#
# hapi-agent.py  -  KNX gateway discovery, forwarding and self-test for a site Pi.
# Installed on the Pi as /usr/local/sbin/hapi-agent (the command used below).
#
# The Pi forwards <tunnel IP>:3671 to the site's KNX/IP gateway so hamon can
# reach it over the VPN.  This finds the gateway itself (KNXnet/IP search on
# 224.0.23.12:3671), keeps the forwarding rules pointing at it if its address
# changes, and reports what it sees.  Python 3 standard library only.
#
#   hapi-agent discover        list KNX/IP devices answering a search
#   hapi-agent test [IP]       full tunnelling test: connect, state, disconnect
#                              (uses a tunnel slot for a moment; install time)
#   hapi-agent run             discover/select, apply forwarding, light probe,
#                              write the status file (+ MQTT if configured);
#                              what the timer runs - it never takes a slot
#   hapi-agent status          print the last status file
#
# Gateway choice, in order: gateway_ip in the config (manual), a pinned
# gateway_serial/gateway_mac, the gateway chosen last time (followed if its IP
# changes), else the only tunnelling-capable device found.  Several candidates
# and nothing to choose by is an error: pin one by serial.
#
# Config: /etc/hapi/agent.conf ([agent] section, all keys optional; see
# hapi-agent.conf.example).  State: /var/lib/hapi/state.json.
# Status: /run/hapi/status.json.  Needs root for iptables.

import configparser
import ipaddress
import json
import os
import socket
import struct
import subprocess
import sys
import time

CONF_FILE = os.environ.get("HAPI_CONF", "/etc/hapi/agent.conf")
STATE_FILE = os.environ.get("HAPI_STATE", "/var/lib/hapi/state.json")
STATUS_FILE = os.environ.get("HAPI_STATUS", "/run/hapi/status.json")

KNX_MCAST = "224.0.23.12"
KNX_PORT = 3671

# KNXnet/IP service types
SEARCH_REQ, SEARCH_RES = 0x0201, 0x0202
DESCR_REQ, DESCR_RES = 0x0203, 0x0204
CONNECT_REQ, CONNECT_RES = 0x0205, 0x0206
CSTATE_REQ, CSTATE_RES = 0x0207, 0x0208
DISCONNECT_REQ, DISCONNECT_RES = 0x0209, 0x020A

FAMILY_TUNNELLING = 0x04
CONNECT_STATUS = {
    0x00: "ok",
    0x22: "connection type not supported",
    0x23: "connection option not supported",
    0x24: "no free tunnel slot",
    0x29: "tunnelling layer not supported",
}

DEFAULTS = {
    "gateway_ip": "",
    "gateway_serial": "",
    "gateway_mac": "",
    "tun_if": "tun0",
    "vpn_server": "10.8.0.1",
    "search_timeout": "3",
    "mqtt_host": "",
    "mqtt_port": "1883",
    "mqtt_user": "",
    "mqtt_password": "",
    "mqtt_topic": "hapi/{host}/status",
}

DNAT_CHAIN, SNAT_CHAIN = "HAPI-DNAT", "HAPI-SNAT"


# ---------------------------------------------------------------- KNXnet/IP

def frame(service, body):
    return struct.pack("!BBHH", 0x06, 0x10, service, 6 + len(body)) + body


def hpai(ip, port):
    return struct.pack("!BB4sH", 8, 1, socket.inet_aton(ip), port)


def parse_frame(data):
    if len(data) < 6 or data[0] != 0x06 or data[1] != 0x10:
        return None, b""
    service, length = struct.unpack("!HH", data[2:6])
    return service, data[6:length]


def parse_hpai(b):
    return socket.inet_ntoa(b[2:6]), struct.unpack("!H", b[6:8])[0]


def parse_dibs(b):
    """Device-info and service-family DIBs into a dict."""
    dev = {"families": []}
    while len(b) >= 2 and b[0] >= 2:
        size, kind, body = b[0], b[1], b[2:b[0]]
        if kind == 0x01 and len(body) >= 52:
            dev["individual_address"] = "%d.%d.%d" % (
                body[2] >> 4, body[2] & 0x0F, body[3])
            dev["serial"] = body[6:12].hex()
            dev["mac"] = ":".join("%02x" % x for x in body[16:22])
            dev["name"] = body[22:52].split(b"\0", 1)[0].decode(
                "latin-1").strip()
        elif kind == 0x02:
            dev["families"] = [body[i] for i in range(0, len(body) - 1, 2)]
        b = b[size:]
    dev["tunnelling"] = FAMILY_TUNNELLING in dev["families"]
    return dev


def local_ip_towards(dest):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((dest, KNX_PORT))
        return s.getsockname()[0]
    finally:
        s.close()


def discover(timeout):
    """Multicast SEARCH_REQUEST; return the devices that answer."""
    lan_ip = local_ip_towards(KNX_MCAST)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF,
                 socket.inet_aton(lan_ip))
    s.bind((lan_ip, 0))
    s.sendto(frame(SEARCH_REQ, hpai(lan_ip, s.getsockname()[1])),
             (KNX_MCAST, KNX_PORT))
    found, end = {}, time.time() + timeout
    while (left := end - time.time()) > 0:
        s.settimeout(left)
        try:
            data, src = s.recvfrom(1024)
        except socket.timeout:
            break
        service, body = parse_frame(data)
        if service != SEARCH_RES or len(body) < 8:
            continue
        ip, port = parse_hpai(body[:8])
        dev = parse_dibs(body[8:])
        # a zero HPAI means "use the sender's address" (NAT-ed gateways)
        dev["ip"] = src[0] if ip == "0.0.0.0" else ip
        dev["port"] = port or KNX_PORT
        found[dev.get("serial") or dev["ip"]] = dev
    s.close()
    return list(found.values())


def request(ip, service, body_fn, want, timeout=3, sock=None):
    """Send one request to ip:3671 and wait for the matching response."""
    own = sock is None
    if own:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind((local_ip_towards(ip), 0))
    me = sock.getsockname()
    sock.settimeout(timeout)
    try:
        sock.sendto(frame(service, body_fn(me)), (ip, KNX_PORT))
        end = time.time() + timeout
        while time.time() < end:
            data, _ = sock.recvfrom(1024)
            got, body = parse_frame(data)
            if got == want:
                return body
    except socket.timeout:
        pass
    finally:
        if own:
            sock.close()
    return None


def describe(ip):
    """DESCRIPTION_REQUEST: confirms the gateway answers, without a slot."""
    body = request(ip, DESCR_REQ, lambda me: hpai(*me), DESCR_RES)
    if body is None:
        return None
    dev = parse_dibs(body)
    dev["ip"], dev["port"] = ip, KNX_PORT
    return dev


NAT_HPAI = hpai("0.0.0.0", 0)


def tunnel_test(ip):
    """CONNECT, CONNECTIONSTATE, DISCONNECT; always releases the slot.

    Uses NAT mode (route-back HPAI 0.0.0.0:0) like hamon's knx library, which
    is what makes hamon work through the Pi's masquerade, so a pass here (on
    the Pi or from the server via the tunnel IP) is what hamon needs."""
    result = {"gateway": ip, "ok": False}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((local_ip_towards(ip), 0))
    t0 = time.time()
    body = request(ip, CONNECT_REQ,
                   lambda me: NAT_HPAI + NAT_HPAI + bytes([4, 4, 2, 0]),
                   CONNECT_RES, sock=s)
    if body is None or len(body) < 2:
        result["error"] = "no CONNECT_RESPONSE"
        s.close()
        return result
    channel, status = body[0], body[1]
    if status != 0:
        result["error"] = "connect refused: " + CONNECT_STATUS.get(
            status, "status 0x%02x" % status)
        s.close()
        return result
    result["connect_ms"] = round((time.time() - t0) * 1000)
    if len(body) >= 14 and body[11] == 0x04:
        crd = body[12:14]
        result["tunnel_address"] = "%d.%d.%d" % (
            crd[0] >> 4, crd[0] & 0x0F, crd[1])
    try:
        body = request(ip, CSTATE_REQ,
                       lambda me: bytes([channel, 0]) + NAT_HPAI,
                       CSTATE_RES, sock=s)
        if body is None or len(body) < 2 or body[1] != 0:
            result["error"] = "connection state check failed"
        else:
            result["ok"] = True
    finally:
        request(ip, DISCONNECT_REQ,
                lambda me: bytes([channel, 0]) + NAT_HPAI,
                DISCONNECT_RES, sock=s)
        s.close()
    return result


# ---------------------------------------------------------------- forwarding

def sh(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True,
                          text=True).stdout


def route_dev(ip):
    out = sh("ip", "-o", "route", "get", ip).split()
    return out[out.index("dev") + 1] if "dev" in out else None


def chain_rules(chain):
    out = sh("iptables", "-t", "nat", "-S", chain, check=False)
    return [l for l in out.splitlines() if l.startswith("-A ")]


def ensure_chain(chain, parent):
    if subprocess.run(["iptables", "-t", "nat", "-n", "-L", chain],
                      capture_output=True).returncode != 0:
        sh("iptables", "-t", "nat", "-N", chain)
    if subprocess.run(["iptables", "-t", "nat", "-C", parent, "-j", chain],
                      capture_output=True).returncode != 0:
        sh("iptables", "-t", "nat", "-A", parent, "-j", chain)


def apply_forward(gw_ip, tun_if):
    """Point tun_if:3671 at the gateway; returns True when rules changed."""
    lan_if = route_dev(gw_ip)
    want = {
        DNAT_CHAIN: ["-A %s -i %s -p udp -m udp --dport %d -j DNAT "
                     "--to-destination %s:%d"
                     % (DNAT_CHAIN, tun_if, KNX_PORT, gw_ip, KNX_PORT)],
        SNAT_CHAIN: ["-A %s -d %s/32 -o %s -p udp -m udp --dport %d "
                     "-j MASQUERADE" % (SNAT_CHAIN, gw_ip, lan_if, KNX_PORT)],
    }
    ensure_chain(DNAT_CHAIN, "PREROUTING")
    ensure_chain(SNAT_CHAIN, "POSTROUTING")
    changed = False
    for chain, rules in want.items():
        if chain_rules(chain) != rules:
            sh("iptables", "-t", "nat", "-F", chain)
            for r in rules:
                sh("iptables", "-t", "nat", *r.split())
            changed = True
    if changed:
        with open("/proc/sys/net/ipv4/ip_forward", "w") as f:
            f.write("1\n")
        subprocess.run(["netfilter-persistent", "save"], capture_output=True)
        # existing conntrack entries keep the old target until they expire
        subprocess.run(["conntrack", "-D", "-p", "udp", "--dport",
                        str(KNX_PORT)], capture_output=True)
    return changed, lan_if


# ---------------------------------------------------------------- helpers

def load_conf():
    cp = configparser.ConfigParser()
    cp.read_dict({"agent": DEFAULTS})
    cp.read(CONF_FILE)
    return cp["agent"]


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def if_ip(ifname):
    out = sh("ip", "-o", "-4", "addr", "show", "dev", ifname, check=False)
    parts = out.split()
    return parts[3].split("/")[0] if "inet" in parts else None


def eth0_mac():
    try:
        with open("/sys/class/net/eth0/address") as f:
            return f.read().strip()
    except OSError:
        return None


def ping(ip):
    return subprocess.run(["ping", "-c", "1", "-W", "2", ip],
                          capture_output=True).returncode == 0


def norm_mac(m):
    return m.lower().replace("-", ":")


def select(conf, state, devices):
    """Choose the gateway; returns (device or None, how, error or None)."""
    if conf["gateway_ip"]:
        ipaddress.ip_address(conf["gateway_ip"])
        return ({"ip": conf["gateway_ip"]}, "manual (gateway_ip)", None)
    tunnelling = [d for d in devices if d.get("tunnelling")]
    for key, label in (("gateway_serial", "serial"), ("gateway_mac", "mac")):
        if conf[key]:
            want = conf[key].lower().replace(":", "") if label == "serial" \
                else norm_mac(conf[key])
            hit = [d for d in devices if d.get(label) == want]
            if hit:
                return hit[0], "pinned (%s)" % key, None
            return None, "pinned (%s)" % key, "pinned gateway %s not found" % (
                conf[key])
    last = state.get("serial")
    if last:
        hit = [d for d in tunnelling if d.get("serial") == last]
        if hit:
            return hit[0], "previous choice", None
    if len(tunnelling) == 1:
        return tunnelling[0], "only tunnelling device", None
    if not tunnelling:
        return None, None, "no tunnelling-capable KNX/IP gateway found"
    return None, None, "%d tunnelling gateways found - pin one with " \
        "gateway_serial: %s" % (len(tunnelling), ", ".join(
            "%s (%s, %s)" % (d.get("serial"), d.get("name"), d["ip"])
            for d in tunnelling))


# ---------------------------------------------------------------- MQTT

def mqtt_publish(host, port, topic, payload, user="", password="",
                 client_id="hapi"):
    """Minimal MQTT 3.1.1 publish, QoS 0, retained."""
    def s(x):
        x = x.encode()
        return struct.pack("!H", len(x)) + x

    def packet(kind, body):
        n, enc = len(body), b""
        while True:
            n, d = divmod(n, 128)
            enc += bytes([d | (0x80 if n else 0)])
            if not n:
                break
        return bytes([kind]) + enc + body

    flags = 0x02 | (0x80 if user else 0) | (0x40 if password else 0)
    connect = s("MQTT") + bytes([4, flags]) + struct.pack("!H", 30) + \
        s(client_id) + (s(user) if user else b"") + \
        (s(password) if password else b"")
    with socket.create_connection((host, int(port)), timeout=5) as c:
        c.sendall(packet(0x10, connect))
        ack = c.recv(4)
        if len(ack) < 4 or ack[0] != 0x20 or ack[3] != 0:
            raise RuntimeError("MQTT connect refused (%s)" % ack.hex())
        c.sendall(packet(0x31, s(topic) + payload))
        c.sendall(bytes([0xE0, 0]))


# ---------------------------------------------------------------- commands

def cmd_discover(conf):
    devices = discover(float(conf["search_timeout"]))
    if not devices:
        print("no KNX/IP devices answered")
        return 1
    for d in devices:
        print("%-15s %-30s serial %s mac %s ia %s tunnelling %s" % (
            d["ip"], d.get("name", "?"), d.get("serial"), d.get("mac"),
            d.get("individual_address"), "yes" if d["tunnelling"] else "no"))
    return 0


def cmd_test(conf, ip=None):
    if not ip:
        dev, how, err = select(conf, load_json(STATE_FILE),
                               discover(float(conf["search_timeout"])))
        if err:
            print(err)
            return 1
        ip = dev["ip"]
    r = tunnel_test(ip)
    print(json.dumps(r, indent=2))
    return 0 if r["ok"] else 1


def cmd_run(conf):
    host = socket.gethostname()
    st = {"host": host, "eth0_mac": eth0_mac(),
          "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "errors": []}
    tun_if = conf["tun_if"]
    st["vpn"] = {"if": tun_if, "ip": if_ip(tun_if),
                 "server_reachable": ping(conf["vpn_server"])}
    if not st["vpn"]["ip"]:
        st["errors"].append("VPN interface %s has no address" % tun_if)

    state = load_json(STATE_FILE)
    devices = [] if conf["gateway_ip"] else discover(
        float(conf["search_timeout"]))
    st["discovered"] = len(devices)
    dev, how, err = select(conf, state, devices)
    if err:
        st["errors"].append(err)
        # keep forwarding to the last known gateway rather than drop it
        if state.get("ip"):
            dev, how = {"ip": state["ip"], "serial": state.get("serial")}, \
                "last known (not found now)"
    if dev:
        probe = describe(dev["ip"])
        if probe:
            dev = {**probe, **{k: v for k, v in dev.items() if v}}
        st["gateway"] = {**dev, "selected_by": how,
                         "answers": probe is not None}
        if not probe:
            st["errors"].append("gateway %s does not answer" % dev["ip"])
        changed, lan_if = apply_forward(dev["ip"], tun_if)
        st["forward"] = {"from": "%s:%d" % (tun_if, KNX_PORT),
                         "to": "%s:%d" % (dev["ip"], KNX_PORT),
                         "lan_if": lan_if, "changed": changed}
        st["lan"] = {"if": lan_if, "ip": if_ip(lan_if) if lan_if else None}
        # remember a confirmed choice so a changed IP is followed next time
        if probe and not err:
            save_json(STATE_FILE, {"serial": dev.get("serial"),
                                   "ip": dev["ip"], "name": dev.get("name")})

    st["ok"] = not st["errors"]
    save_json(STATUS_FILE, st)
    if conf["mqtt_host"]:
        try:
            mqtt_publish(conf["mqtt_host"], conf["mqtt_port"],
                         conf["mqtt_topic"].format(host=host),
                         json.dumps(st).encode(), conf["mqtt_user"],
                         conf["mqtt_password"], client_id=host)
        except (OSError, RuntimeError) as e:
            print("mqtt: %s" % e, file=sys.stderr)
    print("%s: %s" % ("ok" if st["ok"] else "PROBLEM",
                      "; ".join(st["errors"]) or "gateway %s via %s" % (
                          st["gateway"]["ip"], st["gateway"]["selected_by"])))
    return 0 if st["ok"] else 1


def main(argv):
    conf = load_conf()
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd == "discover":
        return cmd_discover(conf)
    if cmd == "test":
        return cmd_test(conf, argv[2] if len(argv) > 2 else None)
    if cmd == "run":
        return cmd_run(conf)
    if cmd == "status":
        print(json.dumps(load_json(STATUS_FILE), indent=2))
        return 0
    print("usage: hapi-agent discover|test [IP]|run|status",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
