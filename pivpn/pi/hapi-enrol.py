#!/usr/bin/env python3
#
# hapi-enrol  -  ask the HAMON server to take this box on (docs/hapi-image.md,
# phase 2). In the HAMON image only; run as root by hapi-enrol.timer from
# first boot until the box has a VPN profile, then the timer switches itself off.
#
# Each run:
#   - once: make the box's VPN key and a certificate request (openssl, EC P-256)
#     and a random secret, in /etc/hapi/vpn (root only). The key never leaves
#     the box.
#   - send the request (box name, eth0 MAC, model, image version, CSR, secret)
#     to the enrolment endpoint; we approve it by hand (hapi-approve.sh)
#   - once approved: fetch the profile with the secret, add the key line, and
#     hand it to hapi-vpn-swap, which starts the VPN (and falls back if it
#     doesn't connect)
#
# State for people and the setup page: /run/hapi/enrol ("pending", "approved",
# "enrolled", or "error: ..."). URL: url= in /etc/hapi/enrol.conf, if present.
#

import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

URL = "https://home.monitor-software.com/hapi-enrol"
VPNDIR = "/etc/hapi/vpn"
KEY, CSR, SECRET = (os.path.join(VPNDIR, f) for f in ("client.key", "client.csr", "enrol-secret"))
PROFILE = "/etc/openvpn/client/pivpn.conf"
STATE = "/run/hapi/enrol"


def state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        f.write(s + "\n")
    os.chmod(STATE, 0o644)
    print(s)


def url():
    try:
        with open("/etc/hapi/enrol.conf") as f:
            for line in f:
                m = re.match(r"\s*url\s*=\s*(\S+)", line)
                if m:
                    return m.group(1).rstrip("/")
    except OSError:
        pass
    return URL


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip("\x00\n ")
    except OSError:
        return default


def identity():
    mac = read("/sys/class/net/eth0/address").lower()
    if not re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", mac):
        raise SystemExit("no eth0 MAC")
    return "hapi-" + mac.replace(":", "")[-6:], mac


def keys(box):
    os.makedirs(VPNDIR, mode=0o700, exist_ok=True)
    if not os.path.exists(KEY):
        subprocess.run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt",
                        "ec_paramgen_curve:P-256", "-out", KEY], check=True, capture_output=True)
        os.chmod(KEY, 0o600)
    if not os.path.exists(CSR):
        subprocess.run(["openssl", "req", "-new", "-key", KEY, "-subj", "/CN=" + box,
                        "-out", CSR], check=True, capture_output=True)
    if not os.path.exists(SECRET):
        fd = os.open(SECRET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(32) + "\n")
    return read(CSR), read(SECRET)


def call(req):
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode()


def main():
    if os.path.exists(PROFILE):
        state("enrolled")
        subprocess.run(["systemctl", "disable", "--now", "hapi-enrol.timer"], capture_output=True)
        return 0
    box, mac = identity()
    csr, secret = keys(box)
    base = url()
    body = json.dumps({"box": box, "mac": mac, "csr": csr, "secret": secret,
                       "model": read("/proc/device-tree/model")[:80],
                       "image": (re.search(r"^image=(\S+)", read("/etc/hapi/image"), re.M) or [None, ""])[1]}).encode()
    try:
        ans = json.loads(call(urllib.request.Request(base + "/request", data=body,
                                                     headers={"Content-Type": "application/json"})))
    except urllib.error.HTTPError as e:
        state("error: server said %d %s" % (e.code, e.read().decode(errors="replace").strip()[:120]))
        return 1
    except (urllib.error.URLError, OSError, ValueError) as e:
        state("error: can't reach %s (%s)" % (base, e))
        return 1
    if ans.get("state") != "approved":
        state("pending: %s waiting for approval" % box)
        return 0

    state("approved: fetching the VPN profile")
    try:
        profile = call(urllib.request.Request(base + "/profile?box=" + box,
                                              headers={"X-Hapi-Secret": secret}))
    except (urllib.error.URLError, OSError) as e:
        state("error: approved, but the profile fetch failed (%s)" % e)
        return 1
    if not profile.startswith("client\n") or "<ca>" not in profile or "<cert>" not in profile:
        state("error: the profile from the server doesn't look right")
        return 1
    new = PROFILE + ".new"
    os.makedirs(os.path.dirname(PROFILE), exist_ok=True)
    fd = os.open(new, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(profile.rstrip("\n") + "\nkey " + KEY + "\n")
    subprocess.run(["systemctl", "enable", "-q", "openvpn-client@pivpn"], check=False)
    r = subprocess.run(["/usr/local/sbin/hapi-vpn-swap"])
    if r.returncode == 0:
        state("enrolled")
        subprocess.run(["systemctl", "disable", "-q", "hapi-enrol.timer"], capture_output=True)
        return 0
    state("error: the VPN didn't come up with the new profile (journalctl -t hapi-vpn-swap)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
