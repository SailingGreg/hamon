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
5. **Ship:** on Ethernet, `./hapi-build.sh --ship <ip>` clears the bench gateway choice and
   forward, removes Wi-Fi profiles (it refuses while the Pi is still on Wi-Fi) and re-checks
   the lock-down. Print the label.

The box name identifies the hardware; the VPN client name is the site (e.g. site X uses
hapi-1a2b3c). In hamon-upload set the site's address to `10.86.0.N`, port `3671`, and keep
the old address noted as the fallback.

**Lock-down:** only `/etc/sudoers.d/hapi` may grant anything without a password
(`hapi-agent`, for the setup page and for us over the VPN). Raspberry Pi OS's own files there
(`010_global-tty`, `010_proxy`, `010_at-export`, `010_dpkg-threads`) only set `Defaults`.
`010_global-tty` makes sudo's 15-minute password cache global: after one `sudo` with the
password, a new ssh session gets sudo without it until the cache expires (`sudo -k` ends it).

**Gateway choice** (`hapi-agent`, every 10 minutes): it finds the gateway with a KNXnet/IP
search and writes the forward (own chains `HAPI-DNAT`/`HAPI-SNAT`, saved), following the
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
sudo iptables -t nat -S HAPI-SNAT     # replies come back to the Pi
# -A HAPI-SNAT -d 192.168.1.98/32 -o eth0 -p udp -m udp --dport 3671 -j MASQUERADE
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
  pivpn-server sh -c '/usr/share/easy-rsa/easyrsa revoke <name> && /usr/share/easy-rsa/easyrsa gen-crl'
rm ~/pivpn/ccd/<name> ~/pivpn/clients/<name>.*
```

The CRL is re-read on every connection. Deleting the ccd file also blocks the client
(`ccd-exclusive`).

## Certificate lifetimes

Client certificates last **825 days** (easy-rsa default). Renew before then:

```bash
docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 \
  pivpn-server /usr/share/easy-rsa/easyrsa renew <name>
```

Then re-run `pivpn-add <name> …` to refresh the `.ovpn` and copy it to the Pi. With
easy-rsa 3.1 (in the image) the old certificate stays valid until revoked, so once the Pi is on
the new one, run `easyrsa revoke-renewed <name>` and `easyrsa gen-crl` the same way.

The **server** certificate also lasts 825 days, and when it expires every site drops, so renew it
(`renew server`, then `docker restart pivpn-server`) well before. The CA and CRL last 10 years.

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
