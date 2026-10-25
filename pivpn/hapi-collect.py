#! /usr/bin/env python3
#
# hapi-collect.py  -  gather site-Pi status over the VPN and publish it on MQTT.
#
# Every Pi-VPN client has a ccd file (~/pivpn/ccd/<name>) with its fixed tunnel
# IP.  For each one this fetches the Pi's /run/hapi/status.json (written by
# hapi-agent) over ssh and publishes, retained, on the local broker:
#
#   hapi/<name>/status   {"site", "box", "vpn_ip", "reachable", "collected",
#                         "ok", "error", "agent": <the Pi's status or null>}
#
# <name> is the VPN client: a site for boxes set up on the bench, the box
# (hapi-xxxxxx) for boxes from the HAMON image. For a box, "site" comes from the
# device register (~/pivpn/hapi-devices.md); empty while it is stock.
#
# A Pi that does not answer is published as reachable=false, which a Pi can't
# report about itself.  Pull, not push: no broker listener on the VPN and no
# MQTT credentials on the Pis.  Needs this user's ssh key on each Pi
# (pivpn@10.86.0.N).  Run by hapi-collect.timer; prints one line per Pi.
#
#   hapi-collect.py [-n]       # -n: print the messages, don't publish

import glob
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

CCD = os.environ.get("PIVPN_CCD", os.path.expanduser("~/pivpn/ccd"))
SSH_USER = os.environ.get("HAPI_SSH_USER", "pivpn")
MQTT_HOST = os.environ.get("HAPI_MQTT_HOST", "127.0.0.1")
TOPIC = "hapi/{name}/status"
STATUS = "/run/hapi/status.json"
REGISTER = os.environ.get("HAPI_REGISTER", os.path.expanduser("~/pivpn/hapi-devices.md"))


def sites():
    """box -> site from the register's device table (| Device | MAC | Site | ...)"""
    m = {}
    try:
        with open(REGISTER) as f:
            for line in f:
                cols = [c.strip() for c in line.split("|")]
                if len(cols) > 3 and cols[1].startswith("hapi-") and len(cols[1]) == 11:
                    m[cols[1]] = cols[3]
    except OSError:
        pass
    return m


def clients():
    for path in sorted(glob.glob(os.path.join(CCD, "*"))):
        with open(path) as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "ifconfig-push":
                    yield os.path.basename(path), parts[1]
                    break


def collect(name, ip, site_of={}):
    box = name if name.startswith("hapi-") else None
    msg = {"site": site_of.get(name, "") if box else name, "box": box, "vpn_ip": ip, "reachable": False,
           "collected": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "ok": False, "error": None, "agent": None}
    try:
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
             "-o", "StrictHostKeyChecking=accept-new",
             "%s@%s" % (SSH_USER, ip), "cat " + STATUS],
            capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        msg["error"] = "ssh timed out"
        return msg
    if r.returncode == 255:
        err = r.stderr.strip().splitlines()
        msg["error"] = "unreachable: " + (err[-1] if err else "ssh failed")
        return msg
    msg["reachable"] = True
    if r.returncode != 0:
        msg["error"] = "no agent status (%s)" % (r.stderr.strip() or "rc %d"
                                                 % r.returncode)
        return msg
    try:
        agent = json.loads(r.stdout)
    except ValueError:
        msg["error"] = "agent status is not valid JSON"
        return msg
    msg["agent"] = agent
    msg["ok"] = bool(agent.get("ok"))
    if not msg["ok"]:
        msg["error"] = "; ".join(agent.get("errors") or []) or "agent not ok"
    return msg


def main(argv):
    dry = "-n" in argv
    targets = list(clients())
    if not targets:
        print("no clients in %s" % CCD)
        return 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        site_of = sites()
        results = list(pool.map(lambda t: collect(t[0], t[1], site_of), targets))
    rc = 0
    for m in results:
        payload = json.dumps(m, separators=(",", ":"))
        gw = (m["agent"] or {}).get("gateway", {}).get("ip")
        print("%-12s %-12s %s%s" % (
            m["box"] or m["site"], m["vpn_ip"], "ok" if m["ok"] else "PROBLEM",
            " gateway " + gw if m["ok"] and gw else
            (": " + m["error"] if m["error"] else "")))
        if dry:
            print("  " + payload)
            continue
        p = subprocess.run(["mosquitto_pub", "-h", MQTT_HOST, "-r", "-q", "1",
                            "-t", TOPIC.format(name=m["box"] or m["site"]), "-s"],
                           input=payload, text=True, capture_output=True)
        if p.returncode != 0:
            print("  publish failed: %s" % p.stderr.strip(), file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
