# MQTT mutual-TLS — cert generation & distribution ops note

Operational runbook for the HAMon MQTT broker's mutual-TLS (mTLS) auth. Covers
the PKI layout, issuing a per-site client cert, shipping it to a remote site Pi,
pointing that Pi's publisher at the TLS listener, and the renew/revoke lifecycle.

Background + the broker-side config and the rationale for "Option A" (mosquitto
terminates its own TLS, not behind nginx) live in [`infrastructure.md`](../infrastructure.md).
This note is the *how-to* for the cert handling that surrounds it.

Status: prototyped + validated on **home-dev** 2026-06-02. Not yet on prod
(prod mosquitto is 1.6.9 and must be upgraded to ≥2.0 first).

---

## 1. The PKI at a glance

Three kinds of certificate, all chained to one private CA:

| Cert | CN | Lives on | Purpose |
|------|----|----------|---------|
| CA (`ca.crt` / `ca.key`) | `hamon-mqtt-ca` | the **CA host** (key offline-ish, see §2) | signs everything below |
| Broker server cert | `<broker-host>` (+SAN) | the broker (`/etc/mosquitto/certs`) | clients verify the broker; TLS server side |
| Per-site client cert | **`<site>`** = the site's `location.name` | each remote Pi | authenticates the Pi; CN becomes its MQTT username |

The CN of a site cert **must equal** the `location.name` that site publishes
under (`knx/<site>/…`). The broker has `use_identity_as_username true`, so the
CN becomes the MQTT username, and the ACL `pattern readwrite knx/%u/#` then
confines that site to its own `knx/<site>/#` subtree automatically. **No
per-site broker config edit is needed** — issue the cert with the right CN and
the ACL just works.

Broker-side files (set up once, see `infrastructure.md`):

```
/etc/mosquitto/ca_certificates/ca.crt    # CA public cert — verifies client certs
/etc/mosquitto/certs/server.crt          # broker cert
/etc/mosquitto/certs/server.key          # broker key (0640 root:mosquitto)
/etc/mosquitto/acl/sites.acl             # pattern readwrite knx/%u/#
/etc/mosquitto/conf.d/tls.conf           # the :8883 listener
```

---

## 2. The CA — guard the key

`ca.key` is the crown jewel: anyone with it can mint a cert for **any** site and
publish as that site. Rules:

- The CA dir (currently `~greg/mqtt-proto/ca` on home-dev for the prototype)
  must be `0700`, `ca.key` `0600`, owned by your admin user — **never** world or
  group readable, **never** copied to a remote Pi.
- Only the **`ca.crt`** (public) is distributed. `ca.key` stays on the CA host.
- Back it up with the rest of the secrets (offline / encrypted). Losing it means
  re-issuing every site cert; leaking it means rotating the whole fleet.
- **Decision still open:** where the production CA of record lives (home-dev vs
  prod vs an offline box). Pick before real rollout. Until then the prototype CA
  on home-dev is throwaway and so are the `testsite`/`othersite` test certs.

If the CA does not exist yet, create it once:

```bash
mkdir -p ~/mqtt-proto/ca && chmod 700 ~/mqtt-proto/ca && cd ~/mqtt-proto/ca
openssl genrsa -out ca.key 4096
chmod 600 ca.key
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/O=HAMon/CN=hamon-mqtt-ca" -out ca.crt
```

---

## 3. Issue a client cert for a new site

Run on the **CA host**. Replace `SITE` with the exact `location.name`.

```bash
cd ~/mqtt-proto
SITE=acme-warehouse            # == location.name, becomes the MQTT username
mkdir -p clients
openssl genrsa -out clients/$SITE.key 2048
openssl req -new -key clients/$SITE.key -subj "/O=HAMon-sites/CN=$SITE" \
  -out clients/$SITE.csr
cat > clients/$SITE.ext <<EXT
extendedKeyUsage=clientAuth
basicConstraints=CA:FALSE
EXT
openssl x509 -req -in clients/$SITE.csr -CA ca/ca.crt -CAkey ca/ca.key \
  -CAcreateserial -days 825 -sha256 -extfile clients/$SITE.ext \
  -out clients/$SITE.crt

# sanity-check
openssl verify -CAfile ca/ca.crt clients/$SITE.crt          # -> OK
openssl x509 -in clients/$SITE.crt -noout -subject -dates    # CN + validity window
```

A reusable script (`new-site-cert.sh`) wrapping the above:

```bash
#!/usr/bin/env bash
set -euo pipefail
SITE="${1:?usage: new-site-cert.sh <site-location-name>}"
cd "$(dirname "$0")"            # run from the mqtt-proto dir holding ca/
[ -f "ca/ca.key" ] || { echo "no CA here"; exit 1; }
mkdir -p clients
openssl genrsa -out "clients/$SITE.key" 2048
openssl req -new -key "clients/$SITE.key" -subj "/O=HAMon-sites/CN=$SITE" -out "clients/$SITE.csr"
printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n' > "clients/$SITE.ext"
openssl x509 -req -in "clients/$SITE.csr" -CA ca/ca.crt -CAkey ca/ca.key \
  -CAcreateserial -days 825 -sha256 -extfile "clients/$SITE.ext" -out "clients/$SITE.crt"
openssl verify -CAfile ca/ca.crt "clients/$SITE.crt"
echo "issued clients/$SITE.{crt,key}  (CN=$SITE, 825d)"
```

Note the **825-day** lifetime — diarise renewal (§6). Keep the `clients/`
directory on the CA host as the record of who has been issued what; you can
delete the `.csr`/`.ext` once the `.crt` is signed.

---

## 4. Distribute to the remote site Pi

Three files go to the Pi: its **own** `crt` + `key`, and the **`ca.crt`** (so the
Pi can verify the broker). The Pi never receives `ca.key`.

```bash
# from the CA host (adjust user/host for the site Pi)
SITE=acme-warehouse
scp ca/ca.crt clients/$SITE.crt clients/$SITE.key pi@<site-pi>:/tmp/
```

On the site Pi, install with tight permissions (the key is a secret):

```bash
sudo install -d -m 0755 /etc/hamon/mqtt
sudo install -m 0644 /tmp/ca.crt            /etc/hamon/mqtt/ca.crt
sudo install -m 0644 /tmp/$SITE.crt         /etc/hamon/mqtt/client.crt
sudo install -m 0600 /tmp/$SITE.key         /etc/hamon/mqtt/client.key
shred -u /tmp/$SITE.key /tmp/$SITE.crt /tmp/ca.crt   # don't leave the key in /tmp
```

Prefer `scp` over the broker itself for transport. If you must hand a key over a
less-trusted channel, encrypt it (`gpg -c`) and decrypt on the Pi.

---

## 5. Point the site publisher at the TLS listener

The remote site's MQTT client must switch from `mqtt://broker:1883` to a TLS
connection on `:8883` presenting the client cert. For a Node `mqtt` client:

```js
const mqtt = require('mqtt')
const fs = require('fs')
const client = mqtt.connect('mqtts://home.monitor-software.com:8883', {
  ca:   fs.readFileSync('/etc/hamon/mqtt/ca.crt'),
  cert: fs.readFileSync('/etc/hamon/mqtt/client.crt'),
  key:  fs.readFileSync('/etc/hamon/mqtt/client.key'),
  // host must match the broker cert CN/SAN; leave servername default.
  // rejectUnauthorized stays true (default) — that's the point of shipping ca.crt.
})
```

Verify the path end-to-end **before** declaring the site live (run on the Pi or
anywhere with the three files), using the site's own subtree:

```bash
mosquitto_pub -h home.monitor-software.com -p 8883 \
  --cafile /etc/hamon/mqtt/ca.crt \
  --cert   /etc/hamon/mqtt/client.crt \
  --key    /etc/hamon/mqtt/client.key \
  -t "knx/$SITE/selftest" -m "hello from $SITE"
```

Expected outcomes (these are the same checks the home-dev prototype passed,
verified end-to-end via the Node `mqtt` client on 2026-06-02):
- publish/subscribe within `knx/$SITE/#` → **works**;
- publish into any other `knx/<other>/#` → **dropped** by the ACL (never reaches
  that site's subscribers);
- subscribe to another site's `knx/<other>/#` → the SUBACK comes back **granted
  (qos 0), not 128** — that is normal mosquitto behaviour for a wildcard filter.
  It is **not** a hole: the read ACL is enforced at *delivery* time, so **zero**
  of the other site's messages are actually delivered. Don't mistake a granted
  SUBACK for an ACL failure — test by actually publishing to the other subtree
  and confirming nothing arrives.
- connecting without the client cert → **connection refused** (`require_certificate`);
- the broker log shows `... as ... (u'$SITE')` confirming CN→username.

---

## 6. Renewal, revocation, server cert

**Client renewal (every ≤825 days, or on staff/key compromise):** re-run §3 for
the same `SITE` (overwrites the `crt`/`key`), redistribute (§4), restart the site
publisher. No broker change. Renew a few weeks before expiry — an expired client
cert is rejected at the TLS handshake and the site goes silent.

**Revocation.** mosquitto is *not* configured with a CRL, so you cannot simply
"revoke" a leaked cert by publishing a revocation list. Two practical options:
1. **Re-key the CA** and re-issue every site — heavy, only for a CA-key
   compromise.
2. **Block the one identity at the ACL:** since the username == CN, add a deny
   ahead of the pattern in `sites.acl`, e.g.

   ```
   user acme-warehouse
   topic deny knx/#
   pattern readwrite knx/%u/#
   ```

   then reload mosquitto. The leaked cert still authenticates (TLS) but can
   publish/subscribe nothing. Re-issue under a new CN if the site needs to come
   back. (If you want true CRL revocation later, add `crlfile` to the listener
   and maintain a CRL — a follow-up decision.)

**Broker server cert** also expires (825 days as issued). Renew by re-running the
server-cert step from `infrastructure.md` (CN=broker host + SAN), reinstalling
`server.crt`, and `systemctl reload mosquitto`. Clients are unaffected as long as
the **same CA** signs the new server cert (they trust the CA, not the leaf).

---

## 7. Quick reference — file locations

| Where | Path | Mode |
|-------|------|------|
| CA host | `~/mqtt-proto/ca/ca.key` | `0600` (secret, never leaves host) |
| CA host | `~/mqtt-proto/ca/ca.crt` | public |
| CA host | `~/mqtt-proto/clients/<site>.{crt,key}` | issuance record |
| Broker | `/etc/mosquitto/ca_certificates/ca.crt` | public |
| Broker | `/etc/mosquitto/certs/server.{crt,key}` | key `0640 root:mosquitto` |
| Broker | `/etc/mosquitto/acl/sites.acl` | `pattern readwrite knx/%u/#` |
| Site Pi | `/etc/hamon/mqtt/ca.crt` | public |
| Site Pi | `/etc/hamon/mqtt/client.crt` | public |
| Site Pi | `/etc/hamon/mqtt/client.key` | `0600` (secret) |
