#!/usr/bin/env python3
#
# netprobe.py - second-by-second packet loss on the server's own uplink
#
# Since 2026-10-26 hamon has logged bursts of heartbeat timeouts where every
# site misses its CONNECTIONSTATE reply within the same minute, then recovers
# (docs/backlog.md, local). The warnings are spread over each site's own
# heartbeat phase and telegrams keep arriving at a reduced rate, so it is
# packet loss, not a stalled event loop. This probe runs beside hamon,
# independent of it, to show where the loss is:
#
#   icmp  one ping a second to the provider gateway and public anchors
#         (loss here = the server's uplink / provider)
#   knx   a KNXnet/IP DESCRIPTION_REQUEST every KNX_EVERY s to a few site
#         gateways (site routers drop ICMP; the gateways answer this, see
#         utils/knxdesc.py) - loss only here = the path to the sites
#
# Each second with any loss is logged as one LOSS line, and every minute one
# summary line per target plus the eth0 RX drop and UdpRcvbufErrors deltas,
# into LOGDIR/netprobe-YYYY-MM-DD.log (kept KEEP_DAYS days). Report only.
#
# Targets come from TARGETS, one per line (site names stay out of git):
#   icmp <label> <host>
#   knx  <label> <host>[:port]
# Without the file: the default gateway, 1.1.1.1, 8.8.8.8 and 9.9.9.9 (some
# providers' gateways drop ICMP - leave it out of TARGETS then).
#
# Usage: netprobe.py             from systemd (netprobe.service)
# Env overrides: TARGETS, LOGDIR, KEEP_DAYS (30), KNX_EVERY (5), KNX_WAIT (2)
#

import os
import select
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta

HAMON = os.environ.get("HAMON", "/home/greg/hamon")
TARGETS = os.environ.get("TARGETS", os.path.join(HAMON, "netprobe.targets"))
LOGDIR = os.environ.get("LOGDIR", os.path.join(HAMON, "alerts", "netprobe"))
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "30"))
KNX_EVERY = int(os.environ.get("KNX_EVERY", "5"))    # seconds between probes
KNX_WAIT = float(os.environ.get("KNX_WAIT", "2"))    # seconds before "lost"

# header (06 10, service 0x0203, length 14) + HPAI (8 bytes, UDP, 0.0.0.0:0)
REQUEST = bytes.fromhex("06100203000e" "0801" "00000000" "0000")


def default_gateway():
    try:
        out = subprocess.run(["ip", "route", "show", "default"],
                             capture_output=True, text=True).stdout.split()
        return out[out.index("via") + 1]
    except (ValueError, IndexError, OSError):
        return None


def load_targets():
    icmp, knx = [], []
    if os.path.exists(TARGETS):
        with open(TARGETS) as f:
            for raw in f:
                parts = raw.split("#")[0].split()
                if len(parts) != 3:
                    continue
                kind, label, host = parts
                if kind == "icmp":
                    icmp.append((label, host))
                elif kind == "knx":
                    h, _, p = host.partition(":")
                    knx.append((label, h, int(p or 3671)))
    else:
        gw = default_gateway()
        if gw:
            icmp.append(("gateway", gw))
        icmp += [("cloudflare", "1.1.1.1"), ("google", "8.8.8.8"),
                 ("quad9", "9.9.9.9")]
    return icmp, knx


def counters():
    """eth0-style RX drops of the default interface + UdpRcvbufErrors."""
    rx = None
    try:
        dev = subprocess.run(["ip", "route", "show", "default"],
                             capture_output=True, text=True).stdout.split()
        dev = dev[dev.index("dev") + 1]
        with open("/sys/class/net/%s/statistics/rx_dropped" % dev) as f:
            rx = int(f.read())
    except (ValueError, IndexError, OSError):
        pass
    udp = None
    try:
        with open("/proc/net/snmp") as f:
            rows = [l.split() for l in f if l.startswith("Udp:")]
        udp = int(rows[1][rows[0].index("RcvbufErrors")])
    except (ValueError, IndexError, OSError):
        pass
    return rx, udp


class Log:
    def __init__(self):
        os.makedirs(LOGDIR, exist_ok=True)
        self.day, self.f = None, None

    def write(self, line):
        now = datetime.now()
        day = now.strftime("%Y-%m-%d")
        if day != self.day:
            if self.f:
                self.f.close()
            self.day = day
            self.f = open(os.path.join(LOGDIR, "netprobe-%s.log" % day), "a")
            self.prune(now)
        self.f.write("%s %s\n" % (now.strftime("%Y-%m-%d %H:%M:%S"), line))
        self.f.flush()

    def prune(self, now):
        cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
        for name in os.listdir(LOGDIR):
            if name.startswith("netprobe-") and name[9:19] < cutoff:
                os.remove(os.path.join(LOGDIR, name))


class Stats:
    def __init__(self):
        self.sent, self.lost, self.rtt = 0, 0, []

    def text(self, label):
        rtt = ("%.1f/%.1f" % (sorted(self.rtt)[len(self.rtt) // 2],
                              max(self.rtt))) if self.rtt else "-"
        return "%s %d/%d %s" % (label, self.lost, self.sent, rtt)


def knx_socket():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.setblocking(False)
    return sock


def main():
    icmp, knx = load_targets()
    if not icmp and not knx:
        sys.exit("netprobe: no targets")
    log = Log()
    log.write("start icmp=%s knx=%s" % (",".join(l for l, _ in icmp),
                                        ",".join(l for l, _, _ in knx)))

    sock = knx_socket()

    stats = {}
    for label, _ in icmp:
        stats[label] = Stats()
    for label, _, _ in knx:
        stats[label] = Stats()
    addr = {}          # knx label -> (ip, port), refreshed every minute
    pending = {}       # (ip, port) -> (label, sent at)
    pings = []         # (label, Popen) started last second
    lost_now = []
    last_counters = counters()
    minute = None
    tick = int(time.time())

    while True:
        # results of last second's pings (ping -W1 has finished by now)
        for label, p in pings:
            out = p.communicate()[0]
            stats[label].sent += 1
            if p.returncode == 0 and "time=" in out:
                stats[label].rtt.append(
                    float(out.split("time=")[1].split()[0]))
            else:
                stats[label].lost += 1
                lost_now.append(label)
        pings = []

        # KNX probes that have waited too long (replies are read below)
        for key, (label, t0) in list(pending.items()):
            if time.time() - t0 > KNX_WAIT:
                del pending[key]
                stats[label].sent += 1
                stats[label].lost += 1
                lost_now.append(label)

        if lost_now:
            log.write("LOSS " + " ".join(sorted(lost_now)))
            lost_now = []

        # minute summary (written once the minute has rolled over)
        m = time.strftime("%H:%M", time.localtime(tick))
        if m != minute:
            if minute is not None:
                c = counters()
                d = ["%+d" % (n - o) if n is not None and o is not None
                     else "?" for n, o in zip(c, last_counters)]
                last_counters = c
                log.write("SUMMARY %s | rx_dropped %s udp_rcvbuf %s" % (
                    " | ".join(s.text(l) for l, s in stats.items()),
                    d[0], d[1]))
                for s in stats.values():
                    s.__init__()
            minute = m
            # a fresh source port each minute: one socket for ever keeps its
            # conntrack entry alive, and after a VPN container restart that
            # entry can stay stuck un-forwarded - every probe "lost" while
            # the site is fine. Nothing is in flight here (KNX_WAIT < KNX_EVERY)
            if knx and not pending:
                sock.close()
                sock = knx_socket()
            for label, host, port in knx:
                try:
                    addr[label] = (socket.gethostbyname(host), port)
                except OSError:
                    addr.pop(label, None)

        # this second's probes
        for label, host in icmp:
            pings.append((label, subprocess.Popen(
                ["ping", "-n", "-c1", "-W1", host],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True)))
        if tick % KNX_EVERY == 0:
            for label, _, _ in knx:
                if label in addr and addr[label] not in pending:
                    pending[addr[label]] = (label, time.time())
                    try:
                        sock.sendto(REQUEST, addr[label])
                    except OSError:
                        pass

        # wait for the next second, reading KNX replies as they arrive
        tick += 1
        while True:
            left = tick - time.time()
            if left <= 0:
                break
            if not select.select([sock], [], [], left)[0]:
                continue
            try:
                data, src = sock.recvfrom(1024)
            except OSError:
                continue
            if src in pending and data[2:4] == b"\x02\x04":
                label, t0 = pending.pop(src)
                stats[label].sent += 1
                stats[label].rtt.append((time.time() - t0) * 1000)


if __name__ == "__main__":
    main()
