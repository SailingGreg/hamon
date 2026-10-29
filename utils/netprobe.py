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
#   trace an mtr report (per-hop loss and RTT, TRACE_CYCLES pings per hop) to
#         each trace target when an event starts - half or more of the icmp
#         targets lost in one second, or an icmp target's RTT jumping to 5x
#         its normal for 3 seconds (a path change) - at most once every
#         TRACE_COOLDOWN s, one when the RTT is back to normal, and one at
#         start and every TRACE_EVERY s as the normal path to compare with. Into LOGDIR/trace-YYYY-MM-DD.log; a
#         TRACE line in the main log says why and when.
#
# Targets come from TARGETS, one per line (site names stay out of git):
#   icmp  <label> <host>
#   knx   <label> <host>[:port]
#   trace <label> <host>
# Without the file: the default gateway, 1.1.1.1, 8.8.8.8 and 9.9.9.9 (some
# providers' gateways drop ICMP - leave it out of TARGETS then).
#
# Usage: netprobe.py             from systemd (netprobe.service)
# Env overrides: TARGETS, LOGDIR, KEEP_DAYS (30), KNX_EVERY (5), KNX_WAIT (2),
# TRACE_COOLDOWN (300), TRACE_EVERY (21600), TRACE_CYCLES (10)
#

import os
import select
import shutil
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
TRACE_COOLDOWN = int(os.environ.get("TRACE_COOLDOWN", "300"))
TRACE_EVERY = int(os.environ.get("TRACE_EVERY", "21600"))  # baseline, 6 h
TRACE_CYCLES = int(os.environ.get("TRACE_CYCLES", "10"))

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
    icmp, knx, trace = [], [], []
    if os.path.exists(TARGETS):
        with open(TARGETS) as f:
            for raw in f:
                parts = raw.split("#")[0].split()
                if len(parts) != 3:
                    continue
                kind, label, host = parts
                if kind == "icmp":
                    icmp.append((label, host))
                elif kind == "trace":
                    trace.append((label, host))
                elif kind == "knx":
                    h, _, p = host.partition(":")
                    knx.append((label, h, int(p or 3671)))
    else:
        gw = default_gateway()
        if gw:
            icmp.append(("gateway", gw))
        icmp += [("cloudflare", "1.1.1.1"), ("google", "8.8.8.8"),
                 ("quad9", "9.9.9.9")]
    return icmp, knx, trace


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
            if (name.startswith("netprobe-") and name[9:19] < cutoff or
                    name.startswith("trace-") and name[6:16] < cutoff):
                os.remove(os.path.join(LOGDIR, name))


class Tracer:
    """mtr reports to the trace targets, in the background, when asked."""

    def __init__(self, targets, log):
        self.targets, self.log = targets, log
        self.running = []        # (label, reason, started, Popen)
        self.last = 0            # last event trace
        self.last_base = 0

    def start(self, reason, baseline=False):
        now = time.time()
        if not self.targets or self.running:
            return
        if not baseline and now - self.last < TRACE_COOLDOWN:
            return
        if baseline:
            self.last_base = now
        else:
            self.last = now
        self.log.write("TRACE %s: %s" % (reason, ",".join(l for l, _ in self.targets)))
        for label, host in self.targets:
            try:
                cmd = (["mtr", "-n", "-r", "-w", "-c", str(TRACE_CYCLES), host]
                       if shutil.which("mtr") else ["tracepath", "-n", host])
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True)
            except OSError as e:
                self.log.write("TRACE %s: mtr failed (%s)" % (label, e))
                continue
            self.running.append((label, reason, datetime.now(), p))

    def poll(self):
        for item in list(self.running):
            label, reason, started, p = item
            if p.poll() is None:
                continue
            self.running.remove(item)
            out = p.communicate()[0]
            name = os.path.join(LOGDIR, "trace-%s.log" % started.strftime("%Y-%m-%d"))
            with open(name, "a") as f:
                f.write("=== %s %s (%s)\n%s\n" % (started.strftime("%Y-%m-%d %H:%M:%S"),
                                                label, reason, out.rstrip()))

    def due(self):
        return self.targets and time.time() - self.last_base >= TRACE_EVERY


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
    icmp, knx, trace = load_targets()
    if not icmp and not knx:
        sys.exit("netprobe: no targets")
    log = Log()
    log.write("start icmp=%s knx=%s trace=%s" % (",".join(l for l, _ in icmp),
                                                 ",".join(l for l, _, _ in knx),
                                                 ",".join(l for l, _ in trace)))
    tracer = Tracer(trace, log)
    normal = {}        # icmp label -> usual RTT (ms), learned from calm seconds
    high = {}          # icmp label -> consecutive seconds well above it

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
        icmp_lost, jumped, back = 0, [], []
        for label, p in pings:
            out = p.communicate()[0]
            stats[label].sent += 1
            if p.returncode == 0 and "time=" in out:
                rtt = float(out.split("time=")[1].split()[0])
                stats[label].rtt.append(rtt)
                base = normal.get(label)
                if base is None or rtt < base * 3:
                    normal[label] = rtt if base is None else base * 0.95 + rtt * 0.05
                    if high.get(label, 0) >= 3:
                        back.append("%s %.1f ms" % (label, rtt))
                    high[label] = 0
                elif rtt > max(base * 5, base + 20):
                    high[label] = high.get(label, 0) + 1
                    if high[label] == 3:
                        jumped.append("%s %.0f ms (normal %.1f)" % (label, rtt, base))
            else:
                stats[label].lost += 1
                lost_now.append(label)
                icmp_lost += 1
        if pings and icmp_lost * 2 >= len(pings) and len(pings) >= 2:
            tracer.start("loss: %d of %d icmp targets" % (icmp_lost, len(pings)))
        elif jumped:
            tracer.start("rtt jump: " + "; ".join(jumped))
        elif back:
            tracer.start("rtt back to normal: " + "; ".join(back), baseline=True)
        elif tracer.due():
            tracer.start("baseline", baseline=True)
        tracer.poll()
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
