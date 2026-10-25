#!/usr/bin/env python3
#
# hapi-enrol-server.py  -  the enrolment endpoint for site boxes from the HAMON
# image (docs/hapi-image.md, phase 2). Runs on prod behind nginx
# (location /hapi-enrol/ -> 127.0.0.1:8095), as the user that owns ~/pivpn.
#
# It never signs anything. It keeps requests and hands out what hapi-approve.sh
# (run by us) has prepared:
#
#   POST /hapi-enrol/request   {"box", "mac", "model", "image", "csr", "secret"}
#       A box sends this at first boot and every few minutes after. The first
#       request for a box name is kept as pending (with a hash of the box's own
#       random secret); later ones with the same secret refresh last_seen, a
#       different secret is refused (409) - nobody can replace a pending request.
#       Answer: {"state": "pending" | "approved"}.
#   GET /hapi-enrol/profile?box=<box>   header X-Hapi-Secret: <secret>
#       The approved box's VPN profile (no private key: that stays on the box),
#       only to the holder of the secret that sent the request.
#
# Data: $HAPI_ENROL_DIR (default ~/pivpn/enrol): pending/<box>.json,
# approved/<box>.json + approved/<box>.ovpn. Python 3 standard library only.
#

import hashlib
import hmac
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA = os.environ.get("HAPI_ENROL_DIR", os.path.expanduser("~/pivpn/enrol"))
PENDING, APPROVED = os.path.join(DATA, "pending"), os.path.join(DATA, "approved")
REFUSED = os.path.join(DATA, "refused")   # the last refused request per box, for --list
LISTEN = ("127.0.0.1", int(os.environ.get("HAPI_ENROL_PORT", "8095")))
MAX_BODY = 16 * 1024
MAX_PENDING = 50          # a flood of fake requests can't fill the disk

BOX = re.compile(r"^hapi-[0-9a-f]{6}$")
MAC = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")
SECRET = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
TEXT = re.compile(r"^[\x20-\x7e]{0,80}$")
CSR_BEGIN, CSR_END = "-----BEGIN CERTIFICATE REQUEST-----", "-----END CERTIFICATE REQUEST-----"


def log(msg):
    print(time.strftime("%F %T"), msg, flush=True)


def digest(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save(path, obj):
    tmp = path + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def refused(box, mac, addr, reason, model="", image=""):
    """Keep the last refused (well-formed) request per box: a replaced card on
    an enrolled box shows up in hapi-approve --list instead of only here."""
    path = os.path.join(REFUSED, box + ".json")
    cur = load(path) or {"count": 0, "first_seen": time.strftime("%F %T")}
    cur.update(box=box, mac=mac, addr=addr, reason=reason, model=model, image=image,
               last_seen=time.strftime("%F %T"), count=cur.get("count", 0) + 1)
    save(path, cur)


class Handler(BaseHTTPRequestHandler):
    server_version = "hapi-enrol"
    sys_version = ""

    def log_message(self, fmt, *args):      # our own lines only
        pass

    def addr(self):
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def reply(self, code, obj=None, text=None):
        body = (text if text is not None else json.dumps(obj or {}) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain" if text is not None else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path != "/hapi-enrol/request":
            return self.reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            return self.reply(400, {"error": "bad length"})
        try:
            req = json.loads(self.rfile.read(n))
        except ValueError:
            return self.reply(400, {"error": "not JSON"})
        if not isinstance(req, dict):
            return self.reply(400, {"error": "not an object"})
        box, mac = str(req.get("box", "")), str(req.get("mac", "")).lower()
        csr, secret = str(req.get("csr", "")), str(req.get("secret", ""))
        model, image = str(req.get("model", "")), str(req.get("image", ""))
        if not BOX.match(box) or not MAC.match(mac) or mac.replace(":", "")[-6:] != box[5:]:
            return self.reply(400, {"error": "bad box name or MAC"})
        if not SECRET.match(secret) or not TEXT.match(model) or not TEXT.match(image):
            return self.reply(400, {"error": "bad field"})
        csr = csr.strip()
        if not (csr.startswith(CSR_BEGIN) and csr.endswith(CSR_END)) or len(csr) > 4096:
            return self.reply(400, {"error": "bad certificate request"})
        h, now = digest(secret), time.strftime("%F %T")

        done = load(os.path.join(APPROVED, box + ".json"))
        if done is not None:
            if hmac.compare_digest(done.get("secret_sha256", ""), h):
                return self.reply(200, {"state": "approved"})
            log("%s: request with another secret for an approved box, from %s" % (box, self.addr()))
            refused(box, mac, self.addr(), "already enrolled (a new card? hapi-approve --forget)", model, image)
            return self.reply(409, {"error": "box already enrolled"})

        path = os.path.join(PENDING, box + ".json")
        cur = load(path)
        if cur is not None:
            if not hmac.compare_digest(cur.get("secret_sha256", ""), h):
                log("%s: request with another secret from %s - refused (pending one kept)" % (box, self.addr()))
                refused(box, mac, self.addr(), "another request for this box is pending", model, image)
                return self.reply(409, {"error": "another request for this box is pending"})
            cur.update(last_seen=now, last_addr=self.addr(), image=image or cur.get("image", ""))
            save(path, cur)
            return self.reply(200, {"state": "pending"})
        if len(os.listdir(PENDING)) >= MAX_PENDING:
            log("pending list full - %s from %s refused" % (box, self.addr()))
            return self.reply(503, {"error": "try later"})
        save(path, {"box": box, "mac": mac, "model": model, "image": image, "csr": csr,
                    "secret_sha256": h, "first_seen": now, "last_seen": now,
                    "addr": self.addr(), "last_addr": self.addr()})
        log("%s: new enrolment request (%s, %s) from %s" % (box, mac, model, self.addr()))
        return self.reply(200, {"state": "pending"})

    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/hapi-enrol/profile":
            return self.reply(404, {"error": "not found"})
        box = (parse_qs(u.query).get("box") or [""])[0]
        secret = self.headers.get("X-Hapi-Secret", "")
        if not BOX.match(box) or not SECRET.match(secret):
            return self.reply(400, {"error": "bad request"})
        done = load(os.path.join(APPROVED, box + ".json"))
        if done is None or not hmac.compare_digest(done.get("secret_sha256", ""), digest(secret)):
            return self.reply(404, {"error": "not approved"})
        try:
            with open(os.path.join(APPROVED, box + ".ovpn")) as f:
                profile = f.read()
        except OSError:
            return self.reply(404, {"error": "no profile"})
        if not done.get("collected"):
            done["collected"] = time.strftime("%F %T")
            save(os.path.join(APPROVED, box + ".json"), done)
            log("%s: profile collected from %s" % (box, self.addr()))
        return self.reply(200, text=profile)


def main():
    for d in (DATA, PENDING, APPROVED, REFUSED):
        os.makedirs(d, mode=0o700, exist_ok=True)
    srv = ThreadingHTTPServer(LISTEN, Handler)
    log("hapi-enrol listening on %s:%d, data %s" % (LISTEN[0], LISTEN[1], DATA))
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
