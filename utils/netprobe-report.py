#!/usr/bin/env python3
#
# netprobe-report.py - outage minutes from the netprobe.py minute summaries
#
# A target is down for a minute when half or more of its probes that minute
# were lost; the minute is an outage when half or more of ALL targets (icmp
# and knx) were down. Counting every target, not only the public anchors,
# matters: on 2026-11-04 17:29-17:38 the uplink lost everything except one
# public anchor that kept answering (its sub-millisecond RTT suggests the
# provider answers it locally), so an "every anchor lost" rule saw nothing.
# A single site losing on its own (a VPN tunnel restart) is not an outage;
# those show in the per-target column.
#
# Times are the minute each summary covers (one minute before it was written).
#
# usage: netprobe-report.py [--days N] [--logdir DIR]
#   --days N      the last N days of logs (default 7, today included)
#   --logdir DIR  default $HAMON/alerts/netprobe
#

import argparse
import os
from datetime import datetime, timedelta

HAMON = os.environ.get("HAMON", "/home/greg/hamon")


def summaries(path):
    """(minute covered, {label: (lost, sent)}) per SUMMARY line."""
    with open(path) as f:
        for line in f:
            if " SUMMARY " not in line:
                continue
            stamp, _, rest = line.partition(" SUMMARY ")
            try:
                when = datetime.strptime(stamp[:16], "%Y-%m-%d %H:%M")
            except ValueError:
                continue
            targets = {}
            for part in rest.split(" | "):
                f = part.split()
                if len(f) >= 2 and "/" in f[1] and not f[0].startswith(("rx_", "udp_")):
                    lost, sent = f[1].split("/")
                    if sent.isdigit() and int(sent):
                        targets[f[0]] = (int(lost), int(sent))
            yield when - timedelta(minutes=1), targets


def report(path):
    minutes, outages, per_target = 0, [], {}
    for when, targets in summaries(path):
        minutes += 1
        down = [l for l, (lost, sent) in targets.items() if lost * 2 >= sent]
        for l in down:
            per_target[l] = per_target.get(l, 0) + 1
        if targets and len(down) * 2 >= len(targets):
            if outages and when - outages[-1][1] <= timedelta(minutes=1):
                # keep the worst minute's count (the target total can differ)
                o = outages[-1]
                worst = o[2:] if o[2] * len(targets) >= len(down) * o[3] else (len(down), len(targets))
                outages[-1] = (o[0], when) + worst
            else:
                outages.append((when, when, len(down), len(targets)))
    return minutes, outages, per_target


def main():
    ap = argparse.ArgumentParser(description="outage minutes from netprobe logs")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--logdir", default=os.path.join(HAMON, "alerts", "netprobe"))
    args = ap.parse_args()

    today = datetime.now().date()
    for n in range(args.days - 1, -1, -1):
        day = (today - timedelta(days=n)).isoformat()
        path = os.path.join(args.logdir, "netprobe-%s.log" % day)
        if not os.path.exists(path):
            continue
        minutes, outages, per_target = report(path)
        total = sum(int((b - a).total_seconds() // 60) + 1 for a, b, _, _ in outages)
        print("%s  %4d min  outage %3d min%s" % (
            day, minutes, total,
            "  " + ", ".join("%s-%s (%d/%d down)" % (a.strftime("%H:%M"), b.strftime("%H:%M"), d, t)
                             for a, b, d, t in outages) if outages else ""))
        if per_target:
            print("            down minutes: " + " ".join(
                "%s %d" % (l, c) for l, c in sorted(per_target.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
