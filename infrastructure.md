# HAMon Infrastructure

Operational reference for the HAMon deployment. Last reviewed 2026-06-01.

## Environments

| Role | Host | Notes |
|------|------|-------|
| Production | `home.monitor-software.com` | live collector + dashboards; InfluxDB 2.6.1 |
| Staging | `home-dev.monitor-software.com` | testing; no hamon service on startup; InfluxDB 2.8.0 |

Login: `ssh greg@<host>` — **key-only** (password auth disabled, see Security). `sudo` requires a password.

Server-to-server SSH: **`home` → `home-dev`** works (prod has an `id_ed25519`, authorized on home-dev). The reverse is not set up.

## Services & ports

Observed listeners (prod). Everything binds to all interfaces unless noted.

| Port | Service | Intended public? | Auth |
|------|---------|------------------|------|
| 22 | sshd | needed (admin) | key-only, no root, fail2ban |
| 1883 | mosquitto (MQTT) | **no — local KNX command bus** (bound to localhost 2026-06-02) | anonymous, loopback only |
| 3000 | grafana (https) | yes | Grafana login |
| 8080 | hamon-upload (node, https) | yes | Grafana session cookie (validated) |
| 8086 | influxd | **no — exposed** | API token |
| 9092 | kapacitord | **no — exposed** | typically none |
| 80 | nginx | yes | redirects → 443 |
| 443 | nginx (reverse proxy) | yes | fronts grafana `/` + hamon-upload `/upload/` |

home-dev is the same minus kapacitor.

## Security posture

**The provider firewall is the only network filter, and it is NOT restricting to the intended ports** — an external scan reaches 22, 1883, 8086, 9092 as well as 3000/8080. SSH (22) sees constant brute-force (tens of thousands of attempts in auth.log). There is **no host firewall** (ufw/iptables/nftables empty).

**Hardening applied 2026-06-01 (both servers):**
- SSH: `PasswordAuthentication no`, `PermitRootLogin no` (key-only). Backup at `/etc/ssh/sshd_config.bak.20260601`.
- **fail2ban** installed, `sshd` jail enabled (bantime 1h, maxretry 5) — actively banning brute-forcers.
- **influxd bound to `127.0.0.1:8086` on prod** (config.toml `http-bind-address`, backup `.bak.20260601`) — 8086 no longer internet-facing; console via the SSH tunnel. (home-dev influxd **now bound too, 2026-06-02**, backup `config.toml.bak.20260602`.)

**Reverse-proxy prototype (nginx) — home-dev only, 2026-06-01:** nginx 1.18 on :443 with the home-dev LE cert (`/etc/nginx/sites-available/grafana.conf`) fronts **Grafana at `/`** and **hamon-upload at `/upload/`** (UI assets are relative so they subpath cleanly; its 3 absolute endpoints — `/load|upload-configuration-file`, `/upload-location-configuration-file` — are routed via exact-match `location` blocks). Backends stay http on localhost. hamon-upload is run there in http/dev mode for the prototype (its prod unit hardcodes prod cert paths + couples auth to NODE_ENV — behind nginx it needs a "production-but-http, keep-auth" mode). Influx 2.x console can't subpath (absolute assets) → use the `influx-console.sh` tunnel.

**nginx now on prod too (2026-06-02):** same `grafana.conf` layout on `/etc/nginx/sites-available/grafana.conf` (prod LE cert, `server_name home.monitor-software.com`), enabled on boot. **Key difference from home-dev: both prod upstreams are HTTPS** — grafana runs `protocol=https` on :3000 and hamon-upload runs `NODE_ENV=production` https on :8080 — so `proxy_pass` uses `https://127.0.0.1:...` (nginx doesn't verify the upstream cert by default; fine over loopback). The packaged `default` site was disabled so the `:80 → :443` redirect block wins. **Direct ports 3000/8080 deliberately left exposed** until users confirm they're happy to switch to the 443 paths — nothing has been bound to localhost or closed yet. Avoided the home-dev "production-but-http, keep-auth" detour by simply keeping prod hamon-upload as-is (https) and using an https upstream. Verified flow (external): `/login`→200, `/upload/`→200, `/load-configuration-file`→401 (upload-backend auth, confirms routing), `:80`→301.

**Hardening strategy (decided 2026-06-01): NOT using ufw / a host firewall.** Instead, harden by **closing external ports** — bind every service to `127.0.0.1` and leave only two ports publicly reachable: **22 (SSH)** and **443 (nginx)**.
- Web UIs that proxy cleanly (Grafana, hamon-upload) go behind **nginx** on 443 (TLS terminates there; backends are plain http on localhost).
- Anything that can't be proxied — the InfluxDB 2.x console (absolute asset paths, no base-path) — is reached over **SSH** via the `influx-console.sh` tunnel.
- The provider firewall stays as a backstop, but binding-to-localhost is the actual control.

**Outstanding (apply the strategy):**
- **Staging (home-dev) is now the fully-hardened reference (2026-06-02):** grafana bound `127.0.0.1:3000` (set `http_addr` in grafana.ini, backup `.bak.20260602`) — reachable only via nginx 443; influxd bound `127.0.0.1:8086` — reachable only via SSH tunnel; mosquitto already localhost. External `:3000`/`:8086` now refused. (Minor: home-dev still serves the packaged nginx default page on `:80` — no `:80→443` redirect block there yet, unlike prod.)
- **Prod — gate on user sign-off** that the 443 paths (grafana `/`, upload `/upload/`) work before closing direct ports. nginx is live on prod with direct 3000/8080 still open in parallel for exactly this transition.
- **Then bind prod to localhost:** grafana → `127.0.0.1:3000` (https upstream already proxied), kapacitor → `127.0.0.1:9092`, hamon-upload → `127.0.0.1:8080` (already proxied via https upstream — no http/keep-auth rework needed). prod influxd already done.
- **mosquitto on prod — two distinct uses, now correctly separated (traced 2026-06-02):**
  - **Local KNX command/control bus (the live use):** an on-box publisher sends `knx/<loc>/<gad>/write|on|off|read` to mosquitto; hamon's per-site worker (`src/mqwrite.js` `MQTTconnect`, one mqtt client per site — ~28 on prod) subscribes to `knx/<loc>/+/+/+[/+]` and **actuates the KNX bus** (`endpoint.write/switchOn/off/read`). KNX *events* go **straight to Influx** (`dbv2.js` ephemeral HTTP POSTs to `127.0.0.1:8086`), **not** via MQTT. This path is on-box only (confirmed: only `127.0.0.1` `mqttjs_*` clients + internet scanners ever connected; kapacitor's `[[mqtt]]` is `enabled = false`). Kapacitor has three intended roles, only the first live: (1) **deadman check** (20-min timeout) — the live `deadmanv2` task; (2) **Slack alerting** — disabled; (3) **per-site MQTT commands** — PoC'd but **never implemented**, hence no kapacitor publisher on the bus. **Action taken 2026-06-02:** bound prod mosquitto to `127.0.0.1`+`::1` (`conf.d/localhost-bind.conf`, two `listener 1883 <addr>` lines; 1.6.9 keeps `allow_anonymous` default true). This **closed a real hole** — it was `0.0.0.0` anonymous, so any internet host could publish a `write` and physically actuate customers' KNX devices. External `:1883` now refused; the 28 local subscribers reconnected with no disruption.
  - **Remote non-KNX Pi integrations (the mTLS PoC — future, not yet on prod):** external Pi servers as a *flexible, non-KNX alternative integration source* that publish into the broker over the internet. This is the **only** thing that needs the broker reachable off-box, and it must be authenticated → the mTLS `:8883` work below. **Decided approach = Option A (deferred, pick up later):** mosquitto terminates its own TLS on **`:8883`** with client-cert auth + per-site ACLs (`use_identity_as_username`) — **not** behind nginx (nginx is HTTP-only; its `stream` module could TCP-proxy MQTT but would hide the client identity and break per-site ACLs). nginx stays web-only. End-state public ports: **22 (ssh) + 443 (nginx) + 8883 (mosquitto TLS)**.
  - **Prototype built + validated on home-dev 2026-06-02.** home-dev runs mosquitto 2.0.11 (prod is still 1.6.9). Private CA at `~greg/mqtt-proto/ca` (`hamon-mqtt-ca`, 10y) signs the broker cert (CN=`home-dev.monitor-software.com`, +SAN) and per-site client certs. `/etc/mosquitto/conf.d/tls.conf` uses `per_listener_settings true`: plaintext `listener 1883 127.0.0.1`/`::1` (anonymous, for the in-host writer, unchanged) + public `listener 8883` with `require_certificate true`, `use_identity_as_username true`, `tls_version tlsv1.2`. ACL `/etc/mosquitto/acl/sites.acl` = `pattern readwrite knx/%u/#` (each site confined to its own subtree; `%u` = cert CN). Certs in `/etc/mosquitto/{ca_certificates,certs}`, server key `0640 root:mosquitto`. Stock `mosquitto.conf` backed up `.bak.<ts>`. Tested from pidevserver over the public path: valid cert pub/sub on own subtree ✅; no-cert connection refused ✅; cross-site sub/pub denied by ACL ✅; CN→username confirmed in broker log ✅. Test identities `testsite`/`othersite` are throwaway — delete before real rollout.
  - **Cert generation + distribution runbook:** [`docs/mqtt-mtls-ops.md`](docs/mqtt-mtls-ops.md) (CA handling, per-site issuing, shipping to a site Pi, renew/revoke).
  - **Remaining to productionise — gated on actually deploying a remote Pi integration to prod (no point doing it speculatively):** define each integration's CN + its publish subtree (these are *non-KNX* sources, so topics need not be `knx/<site>/…` — pick a scheme and match the ACL `pattern`), issue+ship each Pi its cert/key + the CA, point it at `:8883`. Provider firewall must allow `8883`.
  - **Prod mosquitto upgrade (prerequisite for the above):** prod is **1.6.9 on Ubuntu 20.04 focal**, whose archive tops out at 1.6.9 — getting ≥2.0 (needed for `use_identity_as_username` + per-listener ACLs) requires the **`ppa:mosquitto-dev/mosquitto-ppa`** (or an OS upgrade). **CRITICAL gotcha:** mosquitto 2.0 flips `allow_anonymous` to **false** by default — a naïve `apt upgrade` would instantly lock out all ~28 local KNX-command subscribers. The upgrade procedure MUST pre-stage `per_listener_settings true` + `allow_anonymous true` on the localhost `1883` listener (and add the `:8883` mTLS listener + certs) **before** `apt install`, then verify the local subscribers reconnect. home-dev (already 2.0.11) is the reference config. On home-dev `8883` is internet-exposed but cert-gated, so safe.
    - **Pre-provisioned 2026-06-02 (staged, NOT applied):** PPA confirmed to ship **mosquitto 2.0.22 for focal**. Staged on prod at `~greg/mqtt-upgrade/` (running broker untouched, still 1.6.9 localhost): prod's own CA `hamon-prod-mqtt-ca` (`ca.key` 0600, never leaves host), broker cert CN=`home.monitor-software.com` (+SAN, 825d), the upgrade-safe `conf.d-staged/tls.conf` (loopback-anon `1883` + mTLS `8883`) and `sites.acl` (`pattern readwrite %u/#` — adjust once the non-KNX topic scheme is set), `new-site-cert.sh`, and `do-upgrade.sh` (adds PPA → installs config → `apt install mosquitto` → restart + verify). **To apply when the first remote integration lands:** `sudo bash ~/mqtt-upgrade/do-upgrade.sh`, then open `8883` on the provider firewall and issue per-integration certs. See `~greg/mqtt-upgrade/README.md`.
- ~~Replicate the nginx control point to prod~~ — **done 2026-06-02.** End state: only **22 + 443** reachable externally on both hosts.

## Collector & app

- `ha-mon.service` → `node /home/greg/hamon/src/hamon.js` (runs as **root**). Logs to hamon.log; winston logs to `src/combined.log` / `src/error.log` (no rotation — see Backups/known issues).
- `hamon-upload.service` → `node /home/greg/hamon-upload/backend.js` (root, `NODE_ENV=production`, https :8080). Config UI; reads/writes the live `hamon.yml`.
- Per-site VPNs run in docker containers (`dns: 172.17/172.18.*.*` in hamon.yml); `restart.sh <site>` bounces the container.

## Data (InfluxDB 2.x)

- Org `HA`, bucket `hamon` (~947M `knx2` points). InfluxQL via the v1 compat API (DBRP `hamon`→bucket, default) — used by Grafana.
- Event-count: `dbstats,metric=knx2 event_total` maintained by `eventcount.sh` (cron `:05` incremental + `hamon-eventcount.service` full rescan on influxd start). Panel: `SELECT last("event_total") FROM "dbstats"`.
- **Upgrade:** 2.6.1 → 2.7.12/2.8.0 is a low-risk in-place apt upgrade (same engine, Flux + InfluxQL preserved). Avoid v3 (rewrite, no in-place, Flux removed, Core caps historical querying).

## Backups

- `hamon-backup2` (cron 23:30) → `influx backup` + grafana.db + configs, tarred to `/var/opt/hamon/backups/influx.YYYY-MM-DD` (~5.3G/day, 6-day retention). Token from `/home/greg/hamon/.hamon-backup.env` (chmod 600). Replicated offsite via a root rsync of `/var/opt/hamon`.
- `archive-hamonyml.sh` (cron Sun 01:00) moves timestamped `hamon.yml.*` backups into `config/archive`, trims to ~6 months.

## Repos & deploy

GitHub `SailingGreg/hamon` and `SailingGreg/hamon-upload`, branch `main`. Deploy = `git pull` on the host (or `scp` a single file). hamon-upload frontend changes need `npm run build` on the host (bundle is gitignored); backend changes need a service restart.
