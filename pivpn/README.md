# Pi-VPN server: admin guide

Site Pis dial **out** to this OpenVPN server. Each Pi gets a fixed tunnel IP `10.86.0.N`,
which is that site's KNX endpoint for hamon. The Pi forwards `10.86.0.N:3671` to the
site's KNX gateway. No port forwards are needed at the site.

## Where things are (on the server)

| What | Where |
|---|---|
| Container | `pivpn-server` (image `openvpn-pivpn`, built from this directory) |
| Data: config, PKI incl. CA key, ccd, client configs | `~/pivpn` (0700, backed up nightly by `hamon-backup2`) |
| Server config | `~/pivpn/server.conf` (a copy of `server.conf` here; edit the copy) |
| One file per site: fixed IP (+ LAN map) | `~/pivpn/ccd/<name>` |
| Client configs to give to Pis | `~/pivpn/clients/<name>.ovpn` (contain the private key) |
| Tunnel on the host | `pivpn`, 10.86.0.1/16; UDP 1194 |

Address plan: `10.86.0.N` = site N (start at 11), `10.86.0.200+` = bench/test,
`10.100.N.0/24` = site N's LAN as seen through the tunnel (support access, later).
Pick a free N with `grep -h ifconfig-push ~/pivpn/ccd/*`.

## Add a site

Two ways to start a box (kept side by side, docs/hapi-image.md):

- **HAMON image:** `./hapi-image.sh` on devserver builds `~/hapi-image/out/hamon-hapi-YYYYMMDD.img.xz`
  from the official Raspberry Pi OS Lite 64-bit image, with everything installed and nothing
  box-specific (no host keys, no secrets; `pivpn` with our keys and no password, and a
  temporary passwordless sudo, `hapi-adopt`, until adoption). Write it with Raspberry Pi
  Imager (Use custom, **no** OS customisation), boot it on Ethernet: it names itself and makes
  its own ssh host keys on first boot. Step 3 below then only *adopts* it (about a minute:
  password, setup code, register, `hapi-adopt` removed). For the integrator's self-install
  (phase 2, enrolment) see docs/hapi-image.md. Test-boot every new image before handing it on.
- **Standard image:** Raspberry Pi OS Lite from Imager as below; step 3 installs everything.

Everything runs from the dev Pi, in `pivpn/`. The Pi on the bench needs only Raspberry Pi
OS Lite 64-bit (Bookworm or Trixie; a Pi 3B+ or later) and a network.

1. **Flash** with Raspberry Pi Imager: ssh on, any first user, a key (this machine's) or a
   password. Wired or Wi-Fi on the bench.
2. **Find it:** `./hapi-find.sh` lists the Pis on the LAN with IP, MAC and the expected
   `hapi-<last 6 hex of the eth0 MAC>` name (on Wi-Fi the MAC shown is wlan0's, so the name
   column is wrong until it's wired; `<imager-hostname>.local` also works).
3. **Build:** `./hapi-build.sh -u <imager-user> <ip>` (password-flashed: it installs this
   machine's key first, asking for the password, or `SSHPASS=<password>`). It copies `pi/`
   and runs `pi/hapi-install.sh` as root: packages (openvpn, iptables-persistent, conntrack,
   fake-hwclock, unattended-upgrades, avahi), the `hapi-<MAC>` hostname unit, the `pivpn`
   user with this machine's and prod's ssh keys, key-only ssh, `hapi-agent` + timer, the
   setup page with its `hapi` user and sudoers, IP forwarding. It makes the pivpn password
   and the setup code (three random words each), records both in the device register
   (`docs/hapi-devices.md`, local only), then removes Imager's passwordless sudo, locks the
   Imager user and checks the lock-down. It ends with the label line: hostname + setup code.
   Safe to re-run (it updates the Pi and keeps the secrets; `-n` makes new ones).
4. **Assign:** `./hapi-assign.sh <ip> <site>` (the hamon.yml name). On prod it takes the
   site's address (its existing one, or the lowest free `10.86.0.N` from .11; `-i N` to
   choose, .200 and up for bench tests) and runs `pivpn-add`; the `.ovpn` goes straight from
   prod to the Pi, starts the VPN, waits for the Pi on the server, runs `hapi-agent`
   through the tunnel and copies the register to prod. It prints the hamon-upload values:
   `dns 10.86.0.N`, port 3671.
   **WireGuard beside OpenVPN** (optional): `./hapi-wg.sh <ip>` gives the box 10.88.0.N
   (the same N as its 10.86.0.N) on prod's `wg-central`. The box's own key is made by the
   build and never leaves it; only its public key goes to prod. OpenVPN is untouched, so this
   can't cut a box off. hamon then reaches the site on either address (`dns 10.88.0.N` or
   `10.86.0.N`), and moving a site is a `dns` change. `--remove` revokes the link at once.
   Safe to re-run. Works through prod on a box on site, like the other scripts.
5. **Bench test** (optional, recommended): `./hapi-benchtest.sh <ip>` runs `pi/fake-gateway.py`
   on the dev Pi, has the Pi's agent choose it, then from prod connects a KNX tunnel to
   `10.86.0.N:3671` the way hamon does: proves prod → VPN → Pi → gateway. Needs UDP 3671
   free on the dev Pi.
6. **Ship:** on Ethernet, `./hapi-build.sh --ship <ip>` clears the bench gateway choice and
   forward, removes Wi-Fi profiles (it refuses while the Pi is still on Wi-Fi), scrubs
   Imager's cloud-init seed on the boot partition (on Trixie it holds the bench Wi-Fi
   password and the Imager user's password hash; the build already disabled cloud-init) and
   re-checks the lock-down. Run it via the Pi's Ethernet address, not its Wi-Fi one. Print
   the label: `docs/labels/<device>.png` (62 × 29 mm at 300 dpi; hostname, `.local` address
   with a QR code of it, setup code; local only, mode 600), written by every build and ship,
   or `./hapi-label.sh <device>` (`LABEL_MM=WxH` for another size). The installer's copy is
   `docs/labels/<device>-install.pdf`: one A4 page with what to bring, the steps on site, and
   the setup page with its QR code and setup code (site-neutral; local only, mode 600; send it
   yourself), also from every build and ship, or `./hapi-sheet.sh <device>`.

**A Pi on site (remote mode).** Give the scripts the Pi's tunnel address instead of a LAN
address and they reach it through prod as the ssh jump host (`ssh -J`), e.g. for the bench
unit:

```bash
./hapi-build.sh 10.86.0.201                  # re-run the build: updates, fixes, new checks
./hapi-assign.sh -r 10.86.0.201 bench-test   # renew its certificate
```

This is also the **upgrade path** for a box already on site: the re-run copies the current
`pi/` (hapi-agent, setup page, swap and enrolment tools) and re-applies the install, keeping
the secrets, the VPN profile and the gateway choice. It works for boxes built before remote
mode existed. When the new agent changes the forward rules (e.g. the TCP 3671 rules for
tunnelling v2), it clears the KNX conntrack entries once, so a live hamon tunnel through the
box may reconnect once.

A re-run of the build doesn't upgrade installed packages (an openvpn upgrade would restart the
tunnel under us; unattended-upgrades does that) and keeps the gateway choice; don't use
`--ship` on a Pi on site, it clears that choice. A new profile (`hapi-assign`) is applied by
`hapi-vpn-swap` on the Pi, detached, so the ssh session dropping with the tunnel doesn't
matter: if the Pi isn't up on the new profile within 2 minutes it goes back to the previous one
and reports `restored` (in `/run/hapi/vpn-swap`, and `journalctl -t hapi-vpn-swap`), and
`hapi-assign -r` revokes the old certificate only after the Pi itself says `up`.

**Device register** (`docs/hapi-devices.md`: local only, mode 600, copied to prod's
`~/pivpn/hapi-devices.md` by the scripts; it holds secrets). The device table has one row per
Pi with its current state, password and setup code; the **Builds** table gets a row from every
`hapi-build`, `hapi-assign` and `--ship` run: date, device, step, hamon commit, model and OS,
the Pi's ssh host key fingerprint (ED25519; compare with what ssh shows on first connection),
the VPN client certificate (name, serial, expiry: renew before it, see below) and the setup
code. Code: `hapi-register.sh`.

The box name identifies the hardware; the VPN client name is the site (e.g. site X uses
hapi-1a2b3c). In hamon-upload set the site's address to `10.86.0.N`, port `3671`, and keep
the old address noted as the fallback.

**Lock-down:** only `/etc/sudoers.d/hapi` may grant anything without a password
(`hapi-agent`, for the setup page and for us over the VPN). Raspberry Pi OS's own files there
(`010_global-tty`, `010_proxy`, `010_at-export`, `010_dpkg-threads`) only set `Defaults`.
`010_global-tty` makes sudo's 15-minute password cache global: after one `sudo` with the
password, a new ssh session gets sudo without it until the cache expires (`sudo -k` ends it).

**Gateway choice** (`hapi-agent`, every 10 minutes): it finds the gateway with a KNXnet/IP
search and writes the forward for UDP and TCP 3671 (tunnelling v1 and v2; own chains
`HAPI-DNAT`/`HAPI-SNAT`, saved), following the
gateway if its IP changes. With several tunnelling gateways it refuses to guess: the
installer picks one on the setup page, or from the server
`ssh pivpn@10.86.0.N sudo hapi-agent pin <serial>` (`unpin` = automatic again). If
multicast is blocked, set `gateway_ip` in `/etc/hapi/agent.conf`. The timer run never takes
a tunnel slot; `hapi-agent test` (on the Pi) or `pi/hapi-agent.py test 10.86.0.N` (on the
server, the way hamon connects) does, briefly. `fake-gateway.py` stands in for a gateway on
the bench.

**Installer's setup page** (`hapi-setup.py`, port 80): from a laptop on the site network,
`http://<hostname>.local/`, signed in as `admin` with the setup code from the label. It shows
the link to hamon, the gateway in use and every gateway seen, and can choose a gateway,
search again or run the connection test. It answers only clients on the Pi's own LAN
subnets (never over the VPN), locks out for a minute after five wrong codes, and runs as the
unprivileged `hapi` user. Sign-in is a form (an in-memory session: 30 min idle, 4 hours at
most, ended by Sign out, a new setup code or a restart).

Then check, and point hamon at the tunnel IP:

```bash
docker exec pivpn-server cat /tmp/pivpn-status.log | grep '^<name>,'   # connected clients (v1 format)
ping -c 3 10.86.0.N                                                     # from the server
```

## Status

```bash
docker exec pivpn-server cat /tmp/pivpn-status.log  # connected clients, refreshed every 60s
docker logs --since 1h pivpn-server
```

Site-Pi health: `hapi-collect.timer` (every 5 min, as greg) fetches each Pi's `hapi-agent`
status over ssh (`pivpn@10.86.0.N`, prod's key) and publishes it retained on the local broker
as `hapi/<name>/status`, with `reachable: false` for a Pi that doesn't answer:

```bash
mosquitto_sub -t 'hapi/+/status' -v -W 3       # current state of every Pi
journalctl -u hapi-collect -n 20               # one line per Pi per run
```

Install once: `install -m 644 hapi-collect.service hapi-collect.timer /etc/systemd/system/`,
then `systemctl daemon-reload && systemctl enable --now hapi-collect.timer`. A new Pi needs
prod's ssh key in its `~pivpn/.ssh/authorized_keys`.

### Checking a site Pi's KNX forward

On the Pi (`ssh pivpn@10.86.0.N` from the server). First see what the agent thinks:

```bash
hapi-agent status        # "gateway": chosen gateway + selected_by; "forward": tun0:3671 -> GW:3671
ip -4 -o addr            # eth0 = site LAN address, tun0 = 10.86.0.N/16
```

Then check the kernel actually has the forward. `iptables` needs the Pi's sudo password
(from the device register): the passwordless rule covers only `hapi-agent`.

```bash
sudo iptables -t nat -S HAPI-DNAT     # the forward itself
# -N HAPI-DNAT
# -A HAPI-DNAT -i tun0 -p udp -m udp --dport 3671 -j DNAT --to-destination 192.168.1.98:3671
# -A HAPI-DNAT -i tun0 -p tcp -m tcp --dport 3671 -j DNAT --to-destination 192.168.1.98:3671
sudo iptables -t nat -S HAPI-SNAT     # replies come back to the Pi
# -A HAPI-SNAT -d 192.168.1.98/32 -o eth0 -p udp -m udp --dport 3671 -j MASQUERADE
# -A HAPI-SNAT -d 192.168.1.98/32 -o eth0 -p tcp -m tcp --dport 3671 -j MASQUERADE
sudo iptables -t nat -L HAPI-DNAT -nv # pkts column: new flows forwarded (hamon connects)
sudo conntrack -L -p udp --dport 3671 # live flow: src 10.86.0.1 -> 10.86.0.N, reply from GW
```

Reading it:

| What you see | Meaning | Next |
|---|---|---|
| `No chain/target/match by that name` | No gateway has ever been confirmed, so the agent hasn't created its chains (normal on the bench) | `hapi-agent discover`; pin a serial or set `gateway_ip` |
| `-A` line, but its IP isn't the site gateway | Forwarding to the wrong device or an old address | `hapi-agent status` → `gateways`; `sudo hapi-agent pin <serial>` |
| Right IP, `pkts` stays 0 | Nothing from hamon is arriving | hamon's `dns` for the site must be `10.86.0.N`; tunnel up? |
| Right IP, `pkts` rising, no conntrack reply | Forwarded but the gateway doesn't answer | gateway power/LAN, tunnel slots in use (ETS, apps) |
| Right IP, conntrack shows replies | Path is working end to end | — |

From the server, `pi/hapi-agent.py test 10.86.0.N` runs a full KNX tunnel
connect/state/disconnect through this forward, exactly as hamon connects (it briefly takes
one of the gateway's tunnel slots).

## Remove / revoke a site

```bash
docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 \
  -e EASYRSA_CRL_DAYS=3600 pivpn-server sh -c '/usr/share/easy-rsa/easyrsa revoke <name> && /usr/share/easy-rsa/easyrsa gen-crl'
rm ~/pivpn/ccd/<name> ~/pivpn/clients/<name>.*
```

Always give `gen-crl` an `EASYRSA_CRL_DAYS` that reaches the CA's expiry (2036-10-05; check
with `openssl crl -in ~/pivpn/pki/crl.pem -noout -nextupdate`): easy-rsa's default is 180 days,
and once the CRL's next-update date passes the server refuses every client. The CRL is re-read on every connection. Deleting the ccd file also blocks the client
(`ccd-exclusive`).

## Certificate lifetimes

Client certificates run to the **CA's expiry (2036-10-05), at most 10 years** (`pivpn-add`;
easy-rsa's default was 825 days); revoke one to end it early. The register's Builds table
shows each Pi's expiry. To renew a site's certificate: `./hapi-assign.sh -r <ip> <site>`
(renews, installs the new profile, and once the Pi is on it revokes the old certificate and
updates the CRL).

The **server** certificate: renew it before it expires, or every site drops at once:

```bash
docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 \
  -e EASYRSA_CERT_EXPIRE=<days to the CA expiry> pivpn-server /usr/share/easy-rsa/easyrsa renew server
docker restart pivpn-server      # sites reconnect within about a minute
```

The CA and CRL last 10 years: the CA's expiry is the hard limit for everything, so plan a new
CA (and new client certificates for every Pi) well before 2036-10.

## Server lifecycle

```bash
./setup.sh <public-host> <ca-name>   # first install, from this directory; idempotent
docker restart pivpn-server          # after editing ~/pivpn/server.conf
```

To upgrade the image, remove the container and re-run setup: `docker rm -f pivpn-server` then
`./setup.sh …`. That rebuilds the image, keeps `~/pivpn`, and starts a new container. Sites
reconnect within about a minute.

To restore, extract `pivpn/` from a nightly tarball into `~` and run `./setup.sh`.

The server drops to the data owner's uid after start-up, so keep `~/pivpn` owned by that
user. Run `pivpn-add` (and `easyrsa`) through `docker exec --user "$(id -u)"` as above, never as root.
