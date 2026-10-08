#! /usr/bin/env python3
#
# fake-gateway.py  -  minimal KNXnet/IP gateway for testing hapi-agent (and
# the VPN forward) without hardware.  Answers SEARCH (multicast 224.0.23.12),
# DESCRIPTION and tunnelling CONNECT / CONNECTIONSTATE / DISCONNECT; it does
# not carry any KNX telegrams.
#
#   ./fake-gateway.py [--name NAME] [--serial HEX12] [--slots N] [--no-tunnel]
#
# Run it on a host on the Pi's LAN; Ctrl-C to stop.

import argparse
import socket
import struct

p = argparse.ArgumentParser()
p.add_argument("--name", default="fake KNX IP gateway")
p.add_argument("--serial", default="00fa4e000001")
p.add_argument("--mac", default="02:00:00:00:00:01")
p.add_argument("--ia", default="1.1.250")
p.add_argument("--slots", type=int, default=1)
p.add_argument("--no-tunnel", action="store_true",
               help="advertise routing only (not a tunnelling gateway)")
a = p.parse_args()

families = [(0x02, 1), (0x03, 1), (0x05, 1)]   # core, mgmt, routing
if not a.no_tunnel:
    families.append((0x04, 1))                 # tunnelling


def frame(service, body):
    return struct.pack("!BBHH", 6, 0x10, service, 6 + len(body)) + body


def hpai(ip, port):
    return struct.pack("!BB4sH", 8, 1, socket.inet_aton(ip), port)


def ia(s):
    x, y, z = map(int, s.split("."))
    return bytes([(x << 4) | y, z])


def dibs():
    name = a.name.encode()[:29].ljust(30, b"\0")
    dev = bytes([0x36, 0x01, 0x02, 0x00]) + ia(a.ia) + b"\0\0" + \
        bytes.fromhex(a.serial) + socket.inet_aton("224.0.23.12") + \
        bytes.fromhex(a.mac.replace(":", "")) + name
    fam = b"".join(bytes(f) for f in families)
    return dev + bytes([2 + len(fam), 0x02]) + fam


def reply_to(body, src):
    ip, port = socket.inet_ntoa(body[2:6]), struct.unpack("!H", body[6:8])[0]
    return (src[0] if ip == "0.0.0.0" else ip, port or src[1])


s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 3671))
probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
probe.connect(("224.0.23.12", 3671))
my_ip = probe.getsockname()[0]
probe.close()
s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
             socket.inet_aton("224.0.23.12") + socket.inet_aton(my_ip))
print("fake gateway on %s:3671 (%s, serial %s, %d slot(s)%s)" % (
    my_ip, a.name, a.serial, a.slots, ", no tunnelling" if a.no_tunnel else ""))

channels, next_ch = {}, 1
while True:
    data, src = s.recvfrom(1024)
    if len(data) < 6 or data[:2] != b"\x06\x10":
        continue
    service = struct.unpack("!H", data[2:4])[0]
    body = data[6:]
    if service == 0x0201:                       # SEARCH
        s.sendto(frame(0x0202, hpai(my_ip, 3671) + dibs()),
                 reply_to(body, src))
        print("search from", src[0])
    elif service == 0x0203:                     # DESCRIPTION
        s.sendto(frame(0x0204, dibs()), reply_to(body, src))
        print("description from", src[0])
    elif service == 0x0205:                     # CONNECT
        dest = reply_to(body, src)
        if a.no_tunnel:
            s.sendto(frame(0x0206, bytes([0, 0x22])), dest)
        elif len(channels) >= a.slots:
            s.sendto(frame(0x0206, bytes([0, 0x24])), dest)
            print("connect from %s refused: no free slot" % src[0])
        else:
            ch, next_ch = next_ch, next_ch % 255 + 1
            channels[ch] = dest
            s.sendto(frame(0x0206, bytes([ch, 0]) + hpai(my_ip, 3671) +
                           bytes([4, 4]) + ia("1.1.251")), dest)
            print("connect from %s -> channel %d" % (src[0], ch))
    elif service == 0x0207:                     # CONNECTIONSTATE
        ch = body[0]
        s.sendto(frame(0x0208, bytes([ch, 0 if ch in channels else 0x21])),
                 reply_to(body[2:], src))
    elif service == 0x0209:                     # DISCONNECT
        ch = body[0]
        channels.pop(ch, None)
        s.sendto(frame(0x020A, bytes([ch, 0])), reply_to(body[2:], src))
        print("disconnect channel %d" % ch)
