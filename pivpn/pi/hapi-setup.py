#! /usr/bin/env python3
#
# hapi-setup.py  -  installer's setup page on a site Pi (local network only).
# Installed on the Pi as /usr/local/sbin/hapi-setup, run by hapi-setup.service.
#
# The installer opens http://<hostname>.local/ on a laptop on the site network,
# signs in as admin with the setup code from the box's label, and sees: VPN state, the
# KNX gateways the box can see, which one is in use, and any problem.  With
# more than one gateway they pick the right one, now or later (e.g. after a
# gateway is replaced); they can also search again and run a connection test.
# Everything is done through hapi-agent.
#
# Kept small on purpose:
#   - answers only clients on the Pi's own LAN subnets (never the VPN side);
#   - sign-in form: user admin + the setup code printed on the box's label (as
#     KNX Secure devices carry their key), one-minute lock-out after five
#     wrong codes;
#   - the session is a random cookie held in memory here: it ends after 30 min
#     idle, 4 hours at most, on "Sign out", when the setup code changes, or
#     when the page restarts;
#   - runs unprivileged; the only root action is `sudo hapi-agent ...`.
#
# Config: [setup] in /etc/hapi/agent.conf (port, code_file).
# The code lives in /etc/hapi/setup-code (root:hapi 0640).

import base64
import configparser
import hmac
import html
import ipaddress
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

CONF_FILE = os.environ.get("HAPI_CONF", "/etc/hapi/agent.conf")
STATUS_FILE = os.environ.get("HAPI_STATUS", "/run/hapi/status.json")
AGENT = ["sudo", "-n", "/usr/local/sbin/hapi-agent"]

cp = configparser.ConfigParser()
cp.read_dict({"setup": {"port": "80", "code_file": "/etc/hapi/setup-code"}})
try:
    cp.read(CONF_FILE)
except OSError:
    pass
SETUP = cp["setup"]
FAILS = {"n": 0, "until": 0.0}
SESSIONS = {}                     # token -> {issued, last, csrf, code}
IDLE_SECS, MAX_SECS = 30 * 60, 4 * 3600
COOKIE = "hapi_session"
FLASH = {"msg": "", "detail": ""}
LOCK = threading.Lock()          # one hapi-agent action at a time
SESS_LOCK = threading.Lock()     # sessions; never held across hapi-agent


def setup_code():
    with open(SETUP["code_file"]) as f:
        return f.read().strip()


def code_tag():
    """Short fingerprint of the setup code: changing the code ends sessions."""
    return hmac.new(setup_code().encode(), b"hapi-setup session",
                    "sha256").hexdigest()[:16]


def new_session():
    now = time.time()
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"issued": now, "last": now, "code": code_tag(),
                       "csrf": secrets.token_urlsafe(24)}
    return token


def live_session(token):
    """The session for this token if still valid (renewing its idle timer)."""
    now = time.time()
    for t in [t for t, v in SESSIONS.items()
              if now - v["last"] > IDLE_SECS or now - v["issued"] > MAX_SECS]:
        del SESSIONS[t]
    sess = SESSIONS.get(token or "")
    if sess and not hmac.compare_digest(sess["code"], code_tag()):
        del SESSIONS[token]
        sess = None
    if sess:
        sess["last"] = now
    return sess


def lan_networks():
    """Subnets of every IPv4 interface except loopback and the VPN tunnel."""
    out = subprocess.run(["ip", "-j", "-4", "addr", "show"],
                         capture_output=True, text=True).stdout
    nets = []
    for iface in json.loads(out or "[]"):
        name = iface.get("ifname", "")
        if name == "lo" or name.startswith("tun"):
            continue
        for a in iface.get("addr_info", []):
            nets.append(ipaddress.ip_network(
                "%s/%s" % (a["local"], a["prefixlen"]), strict=False))
    return nets


def agent(*args, timeout=30):
    r = subprocess.run(AGENT + list(args), capture_output=True, text=True,
                       timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def status():
    try:
        with open(STATUS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


SEARCH = {"running": False}


def fresh_status(max_age=60):
    """If the last result is older than max_age seconds, start a search in
    the background and return True; the page shows the last result straight
    away and reloads itself when the search has finished."""
    try:
        age = time.time() - os.stat(STATUS_FILE).st_mtime
    except OSError:
        age = max_age + 1
    if age <= max_age:
        return SEARCH["running"]
    if not SEARCH["running"]:
        SEARCH["running"] = True

        def search():
            try:
                with LOCK:
                    agent("run")
            finally:
                SEARCH["running"] = False
        threading.Thread(target=search, daemon=True).start()
    return True


# ---------------------------------------------------------------- page

CSS = """
:root{--bg:#f5f7f6;--card:#fff;--fg:#1d2622;--muted:#5a6862;--line:#d6dfdb;
--ok:#0f7a5c;--okbg:#e2f2ec;--bad:#a12d2d;--badbg:#fbe7e7}
@media (prefers-color-scheme:dark){:root{--bg:#121816;--card:#1a2320;
--fg:#e4ece8;--muted:#9db0a8;--line:#2c3a35;--ok:#4cc9a0;--okbg:#163a2f;
--bad:#f08a8a;--badbg:#3a1a1a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:24px 16px 48px;display:grid;gap:20px}
h1{margin:0;font-size:1.5rem}h2{margin:0 0 8px;font-size:1.1rem}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid
var(--line);border-radius:8px;padding:14px 16px}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;
font-weight:600;font-size:.9rem}.ok{background:var(--okbg);color:var(--ok)}
.bad{background:var(--badbg);color:var(--bad)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
dt{color:var(--muted)}dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:34rem}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);
vertical-align:middle}th{font-size:.8rem;color:var(--muted);
text-transform:uppercase;letter-spacing:.05em}code{font-size:.9em}
button{font:inherit;font-weight:600;border:1px solid var(--ok);
background:var(--ok);color:var(--card);border-radius:6px;padding:6px 12px;
cursor:pointer}button.sec{background:transparent;color:var(--ok)}
.row{display:flex;flex-wrap:wrap;gap:10px}form{margin:0}
.flash{border-left:4px solid var(--ok);background:var(--okbg)}
pre{white-space:pre-wrap;margin:8px 0 0;font-size:.85rem}
button[disabled]{opacity:.5;cursor:progress}
.busy{border-left:4px solid var(--muted)}
.warn{border-left:4px solid var(--bad);background:var(--badbg)}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;
align-items:flex-start}
.login{display:grid;gap:8px;max-width:24rem}.login h2{margin:0}
.login label{color:var(--muted);font-size:.9rem}
input{font:inherit;padding:6px 8px;border:1px solid var(--line);
border-radius:6px;background:var(--bg);color:var(--fg)}
:focus-visible{outline:2px solid var(--ok);outline-offset:2px}
"""


def esc(x):
    return html.escape("" if x is None else str(x))


def button(action, label, extra="", cls="", csrf=""):
    hidden = "".join('<input type="hidden" name="%s" value="%s">'
                     % (esc(k), esc(v)) for k, v in extra.items()) \
        if extra else ""
    return ('<form method="post" action="%s"><input type="hidden" '
            'name="csrf" value="%s">%s<button%s>%s</button></form>'
            % (action, esc(csrf), hidden, ' class="%s"' % cls if cls else "",
               esc(label)))


def page(title, body):
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,"
            "initial-scale=1\"><title>%s</title><style>%s</style>"
            "</head><body>%s</body></html>" % (esc(title), CSS, body))


def render_login(msg=""):
    host = esc(socket.gethostname())
    return page("%s setup" % host,
                '<main><header><h1>%s setup</h1><p class="muted">KNX gateway '
                'link for hamon monitoring.</p></header>%s'
                '<form class="card login" method="post" action="/login">'
                '<h2>Sign in</h2>'
                '<label for="user">User</label>'
                '<input id="user" name="user" value="admin" autocomplete="username">'
                '<label for="code">Setup code (on the box\'s label)</label>'
                '<input id="code" name="code" type="password" required autofocus '
                'autocomplete="current-password">'
                '<button>Sign in</button></form></main>'
                % (host, '<div class="card warn"><b>%s</b></div>' % esc(msg)
                   if msg else ""))


def render(csrf, searching=False):
    st = status()
    gw = st.get("gateway") or {}
    in_use = gw.get("serial") if gw.get("answers") else None
    vpn = st.get("vpn") or {}
    parts = ['<main><header class="top"><div><h1>%s setup</h1>'
             '<p class="muted">KNX gateway link for hamon monitoring.</p></div>'
             '%s</header>' % (esc(socket.gethostname()),
                              button("/logout", "Sign out", cls="sec",
                                     csrf=csrf))]
    parts.append('<div class="card busy" id="busy" hidden><b>Working...</b> '
                 'searching the network and applying the change takes a few '
                 'seconds.</div>')
    if searching:
        parts.append('<div class="card busy" id="searching"><b>Searching the '
                     'network...</b> showing the last result until the new one '
                     'is ready (a few seconds).</div>')
    if FLASH["msg"]:
        parts.append('<div class="card flash"><b>%s</b>%s</div>' % (
            esc(FLASH["msg"]), "<pre>%s</pre>" % esc(FLASH["detail"])
            if FLASH["detail"] else ""))
        FLASH["msg"] = FLASH["detail"] = ""

    ok = st.get("ok")
    parts.append('<section class="card"><h2>Status <span class="pill %s">%s'
                 '</span></h2><dl>' % ("ok" if ok else "bad",
                                       "all good" if ok else "needs attention"))
    parts.append("<dt>Link to hamon</dt><dd>%s</dd>" % (
        "connected (%s)" % esc(vpn.get("ip")) if vpn.get("server_reachable")
        else "<b>not connected</b>"))
    lan = st.get("lan") or {}
    parts.append("<dt>This box</dt><dd>%s</dd>" % esc(lan.get("ip") or "-"))
    parts.append("<dt>Gateway in use</dt><dd>%s</dd>" % (
        "%s, %s (%s)" % (esc(gw.get("name")), esc(gw.get("ip")),
                         esc(gw.get("selected_by")))
        if gw else "none"))
    for e in st.get("errors") or []:
        parts.append("<dt>Problem</dt><dd>%s</dd>" % esc(e))
    parts.append("<dt>Checked</dt><dd>%s</dd></dl></section>"
                 % esc(st.get("time", "not yet")))

    gws = st.get("gateways") or []
    parts.append('<section class="card"><h2>KNX gateways on this network</h2>')
    if not gws:
        parts.append('<p class="muted">None found. Check this box is on the '
                     'same network as the KNX gateway, then search again.</p>')
    else:
        parts.append('<div class="tbl"><table><thead><tr><th>Name</th>'
                     '<th>Address</th><th>Serial</th><th>Tunnelling</th>'
                     '<th></th></tr></thead><tbody>')
        for d in gws:
            if d.get("serial") and d.get("serial") == in_use:
                act = '<span class="pill ok">in use</span>'
            elif d.get("tunnelling"):
                act = button("/select", "Use this one",
                             {"serial": d.get("serial") or ""}, csrf=csrf)
            else:
                act = '<span class="muted">not usable</span>'
            parts.append("<tr><td>%s</td><td>%s</td><td><code>%s</code></td>"
                         "<td>%s</td><td>%s</td></tr>" % (
                             esc(d.get("name")), esc(d.get("ip")),
                             esc(d.get("serial")),
                             "yes" if d.get("tunnelling") else "no", act))
        parts.append("</tbody></table></div>")
    parts.append("</section>")

    pinned = st.get("pinned")
    parts.append('<section class="card"><h2>Actions</h2><div class="row">%s'
                 '%s%s</div><p class="muted">Search again after moving cables. '
                 'The connection test briefly uses one of the gateway\'s '
                 'connections.%s</p></section>' % (
                     button("/refresh", "Search again", csrf=csrf),
                     button("/test", "Test connection", cls="sec", csrf=csrf),
                     button("/select", "Choose automatically", {"serial": ""},
                            "sec", csrf=csrf) if pinned else "",
                     " A gateway is chosen by hand (%s); "
                     "\"Choose automatically\" undoes that." % esc(pinned)
                     if pinned else ""))
    parts.append("</main><script>(function(){var busy=false;"
                 "document.querySelectorAll('form').forEach(function(f){"
                 "f.addEventListener('submit',function(e){if(busy){"
                 "e.preventDefault();return;}busy=true;"
                 "document.getElementById('busy').hidden=false;"
                 "setTimeout(function(){document.querySelectorAll('button')"
                 ".forEach(function(b){b.disabled=true;});},0);});});"
                 "if(document.getElementById('searching')){var poll=function(){"
                 "fetch('/searching',{cache:'no-store'}).then(function(r){"
                 "return r.text();}).then(function(t){if(busy)return;"
                 "if(t.trim()==='no')location.reload();"
                 "else setTimeout(poll,1000);}).catch(function(){"
                 "setTimeout(poll,3000);});};setTimeout(poll,1000);}"
                 "})();</script>")
    return page("%s setup" % socket.gethostname(), "".join(parts))


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "hapi-setup"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

    def send(self, code, body, ctype="text/html; charset=utf-8", hdrs=None):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (hdrs or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def on_lan(self):
        ip = ipaddress.ip_address(self.client_address[0])
        if not any(ip in n for n in lan_networks()):
            self.send(403, "Setup is only available on the local network.\n",
                      "text/plain")
            return False
        return True

    def cookie_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return None

    def session_cookie(self, token, max_age):
        return {"Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; "
                              "SameSite=Strict" % (COOKIE, token, max_age)}

    def form(self):
        n = int(self.headers.get("Content-Length") or 0)
        return parse_qs(self.rfile.read(min(n, 4096)).decode())

    def login(self):
        if time.time() < FAILS["until"]:
            self.send(429, render_login("Too many wrong codes - wait a minute "
                                        "and try again."))
            return
        form = self.form()
        user = form.get("user", [""])[0].strip().lower()
        given = form.get("code", [""])[0].strip()
        if user == "admin" and hmac.compare_digest(given, setup_code()):
            FAILS["n"] = 0
            with SESS_LOCK:
                token = new_session()
            self.send(303, "", "text/plain",
                      {**self.session_cookie(token, MAX_SECS), "Location": "/"})
            return
        FAILS["n"] += 1
        if FAILS["n"] >= 5:
            FAILS["n"], FAILS["until"] = 0, time.time() + 60
        self.send(401, render_login("Wrong user or setup code. The user is "
                                    "admin; the code is on the box's label."))

    def do_GET(self):
        if not self.on_lan():
            return
        token = self.cookie_token()
        with SESS_LOCK:
            sess = live_session(token)
        if not sess:
            self.send(200, render_login("Your session has ended - sign in "
                                        "again." if token else ""),
                      hdrs=self.session_cookie("", 0) if token else None)
            return
        if self.path in ("/refresh", "/select", "/test", "/login", "/logout"):
            # an action address opened directly (reload, back, typed): show
            # the page instead of an error
            self.send(303, "", "text/plain", {"Location": "/"})
            return
        if self.path == "/searching":       # polled while a search runs
            self.send(200, "yes" if SEARCH["running"] else "no", "text/plain")
            return
        if self.path not in ("/", "/index.html"):
            self.send(404, "Not found\n", "text/plain")
            return
        searching = fresh_status()
        left = MAX_SECS - (time.time() - sess["issued"])
        self.send(200, render(sess["csrf"], searching),
                  hdrs=self.session_cookie(token, max(int(left), 0)))

    def do_POST(self):
        if not self.on_lan():
            return
        if self.path == "/login":
            self.login()
            return
        token = self.cookie_token()
        with SESS_LOCK:
            sess = live_session(token)
        if not sess:                     # ended: back to the sign-in page
            self.send(303, "", "text/plain", {"Location": "/"})
            return
        form = self.form()
        if not hmac.compare_digest(form.get("csrf", [""])[0], sess["csrf"]):
            self.send(403, "Page expired - reload and try again.\n",
                      "text/plain")
            return
        if self.path == "/logout":
            with SESS_LOCK:
                SESSIONS.pop(token, None)
            self.send(303, "", "text/plain",
                      {**self.session_cookie("", 0), "Location": "/"})
            return
        with LOCK:
            if self.path == "/refresh":
                rc, out = agent("run")
                FLASH["msg"] = "Searched again."
            elif self.path == "/select":
                serial = form.get("serial", [""])[0]
                rc, out = agent("pin", serial) if serial else agent("unpin")
                FLASH["msg"] = ("Gateway %s selected." % serial if serial
                                else "Gateway chosen automatically.")
            elif self.path == "/test":
                gw = (status().get("gateway") or {}).get("ip")
                if not gw:
                    rc, out = 1, "No gateway in use yet."
                else:
                    rc, out = agent("test", gw)
                    try:
                        r = json.loads(out)
                        out = ("Connected to the gateway and disconnected "
                               "cleanly in %s ms." % r.get("connect_ms")
                               if r.get("ok") else "Test failed: %s"
                               % r.get("error"))
                    except ValueError:
                        pass
                FLASH["msg"] = "Connection test: %s" % (
                    "passed" if rc == 0 else "failed")
            else:
                self.send(404, "Not found\n", "text/plain")
                return
            FLASH["detail"] = out
        self.send(303, "", "text/plain", {"Location": "/"})


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", int(SETUP["port"])), Handler)
    print("setup page on port %s" % SETUP["port"])
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
