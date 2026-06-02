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
| 1883 | mosquitto (MQTT) | **no — exposed** | unconfirmed (no explicit auth) |
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
- **mosquitto (1883) on prod:** confirm not anonymous; add auth/ACL; bind to localhost or just the VPN/site interface.
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
