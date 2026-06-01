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
| 443 | — | (nothing listening) | — |

home-dev is the same minus kapacitor.

## Security posture

**The provider firewall is the only network filter, and it is NOT restricting to the intended ports** — an external scan reaches 22, 1883, 8086, 9092 as well as 3000/8080. SSH (22) sees constant brute-force (tens of thousands of attempts in auth.log). There is **no host firewall** (ufw/iptables/nftables empty).

**Hardening applied 2026-06-01 (both servers):**
- SSH: `PasswordAuthentication no`, `PermitRootLogin no` (key-only). Backup at `/etc/ssh/sshd_config.bak.20260601`.
- **fail2ban** installed, `sshd` jail enabled (bantime 1h, maxretry 5) — actively banning brute-forcers.

**Outstanding hardening (recommended, not yet done):**
- **Host firewall (ufw):** default-deny inbound, allow only 22, 3000, 8080 — so we don't rely solely on the provider firewall. (Allow ssh *before* enabling.)
- **Bind internal services to localhost:** influxd → `127.0.0.1:8086`, kapacitor → `127.0.0.1:9092` (only local consumers).
- **mosquitto:** confirm it is not anonymous; add auth/ACL; bind to localhost or just the VPN/site interface.

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
