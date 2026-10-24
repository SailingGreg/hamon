#!/usr/bin/env python3
#
# knxdesc.py - read-only KNXnet/IP DESCRIPTION probe of the sites in hamon.yml
#
# Sends a DESCRIPTION_REQUEST (0x0203) to each site's gateway and prints what
# the DESCRIPTION_RESPONSE (0x0204) says: individual address, serial, friendly
# name and the supported service families (tunnelling, routing, ...).
#
# The request carries the NAT HPAI 0.0.0.0:0 ("reply to the packet's source"),
# so it works over the internet as well as on a LAN or VPN. An HPAI with the
# sender's own private IP gets its reply sent to that address and is lost
# behind NAT. A description takes no tunnel slot, so it is safe to run against
# live sites alongside hamon.
#
# usage: knxdesc.py [-f hamon.yml] [-a] [site|host:port ...]
#        knxdesc.py --sweep CIDR [--port 3671]
#   no arguments  every enabled site in hamon.yml
#   site          only the named site(s)
#   host:port     probe a gateway that isn't in hamon.yml
#   -a            include disabled sites
#   --sweep CIDR  probe every address in CIDR (e.g. 192.168.1.0/24) and list
#                 the KNXnet/IP devices that reply: finds a site's interface
#                 over a routed VPN, where multicast SEARCH doesn't reach.
#                 Run it where the CIDR is routed (utils/vpn-discover.sh runs
#                 it inside a site's VPN container)
#
# Exit status is 1 if any probed site did not reply (--sweep: if none did).
#

import argparse
import ipaddress
import select
import socket
import struct
import sys
import time

FAMILIES = {2: "core", 3: "devmgmt", 4: "tunnel", 5: "routing", 6: "remlog",
            7: "remconf", 8: "objsrv", 9: "security"}

# header (06 10, service 0x0203, length 14) + HPAI (8 bytes, UDP, 0.0.0.0:0)
REQUEST = bytes.fromhex("06100203000e" "0801" "00000000" "0000")


def describe(ip, port, timeout=2.5, tries=2):
    """DESCRIPTION_REQUEST to ip:port; returns the parsed DIBs, or None."""
    for _ in range(tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.bind(("0.0.0.0", 0))
            s.sendto(REQUEST, (ip, int(port)))
            data, _ = s.recvfrom(1024)
        except socket.timeout:
            continue
        finally:
            s.close()
        if len(data) < 8 or struct.unpack(">H", data[2:4])[0] != 0x0204:
            continue
        return parse_dibs(data[6:])
    return None


def sweep(cidr, port, timeout=2.5, rounds=2):
    """DESCRIPTION_REQUEST to every host in cidr from one socket; returns
    {ip: parsed DIBs} for the ones that replied."""
    hosts = [str(h) for h in ipaddress.ip_network(cidr, strict=False).hosts()]
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", 0))
    try:
        for _ in range(rounds):
            for h in hosts:
                if h not in found:
                    try:
                        s.sendto(REQUEST, (h, port))
                    except OSError:
                        pass            # e.g. no route: the reply never comes
                    time.sleep(0.002)   # a /24 in half a second, no burst
            end = time.time() + timeout
            while time.time() < end:
                ready, _, _ = select.select([s], [], [], max(0, end - time.time()))
                if not ready:
                    break
                data, (src, _) = s.recvfrom(1024)
                if len(data) >= 8 and struct.unpack(">H", data[2:4])[0] == 0x0204:
                    found[src] = parse_dibs(data[6:])
    finally:
        s.close()
    return found


def line(label, r):
    return (f"{label:14} OK        ia={r.get('ia', ''):9} sn={r.get('serial', ''):12} "
            f"{r.get('name', '')[:30]:30} [{r.get('families', '')}]")


def parse_dibs(body):
    """Device info (0x01) and supported service families (0x02) DIBs."""
    out = {}
    p = 0
    while p + 2 <= len(body):
        length, dib = body[p], body[p + 1]
        if length < 2:
            break
        b = body[p:p + length]
        if dib == 0x01 and length >= 54:
            out["ia"] = f"{b[4] >> 4}.{b[4] & 15}.{b[5]}"
            out["serial"] = b[8:14].hex()
            out["name"] = b[24:54].split(b"\0")[0].decode(errors="replace").strip()
        elif dib == 0x02:
            out["families"] = ",".join(f"{FAMILIES.get(b[i], b[i])}v{b[i + 1]}"
                                       for i in range(2, length - 1, 2))
        p += length
    return out


def targets(args):
    """(label, host, port) for each site or host:port to probe."""
    sites = []
    if not args.sites or any(":" not in a for a in args.sites):
        import yaml         # only needed for hamon.yml, not for --sweep
        with open(args.file) as f:
            doc = yaml.safe_load(f)
        sites = [l for l in (doc.get("locations") or {}).values() if l]
    wanted = [a for a in args.sites if ":" not in a]
    for loc in sites:
        if wanted and loc.get("name") not in wanted:
            continue
        if not wanted and not args.all and loc.get("enabled") is not True:
            continue
        yield loc.get("name"), str(loc.get("dns")), loc.get("port") or 3671
    for name in set(wanted) - {l.get("name") for l in sites}:
        print(f"{name:14} not in {args.file}", file=sys.stderr)
    for a in args.sites:
        if ":" in a:
            host, port = a.rsplit(":", 1)
            yield a, host, port


def main():
    ap = argparse.ArgumentParser(description="read-only KNXnet/IP DESCRIPTION probe")
    ap.add_argument("-f", "--file", default="hamon.yml", help="hamon.yml to read (default ./hamon.yml)")
    ap.add_argument("-a", "--all", action="store_true", help="include disabled sites")
    ap.add_argument("--sweep", metavar="CIDR", help="probe every address in CIDR and list the KNXnet/IP devices")
    ap.add_argument("--port", type=int, default=3671, help="UDP port for --sweep (default 3671)")
    ap.add_argument("sites", nargs="*", help="site names or host:port (default: every enabled site)")
    args = ap.parse_args()

    if args.sweep:
        found = sweep(args.sweep, args.port)
        for ip in sorted(found, key=ipaddress.ip_address):
            print(line(f"{ip}", found[ip]))
        print(f"\n{len(found)} KNXnet/IP device(s) in {args.sweep}")
        return 0 if found else 1

    ok = total = 0
    for label, host, port in targets(args):
        total += 1
        try:
            ip = socket.gethostbyname(host)
        except OSError:
            print(f"{label:14} DNS-FAIL  {host}")
            continue
        r = describe(ip, port)
        if r is None:
            print(f"{label:14} NO-REPLY  {ip}:{port}")
            continue
        ok += 1
        print(line(label, r))

    print(f"\n{ok}/{total} replied")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
