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

On the server:

```bash
docker exec --user "$(id -u)" pivpn-server pivpn-add <name> 10.86.0.N 10.100.N.0
```

This issues a certificate and a per-client `tls-crypt-v2` key, writes `ccd/<name>`, and
creates `~/pivpn/clients/<name>.ovpn`. Copy that file to the Pi over ssh/scp only
(never email): it is the Pi's identity.

On a freshly imaged Pi, first install the hostname unit from `pi/`, which names the box
`hapi-<last 6 hex of the eth0 MAC>` at every boot (a no-op once set; reachable as `<name>.local`):

```bash
install -m 755 hapi-hostname.sh /usr/local/sbin/
install -m 644 hapi-hostname.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now hapi-hostname
```

The box name identifies the hardware; the VPN client name is the site (e.g. site X uses hapi-1a2b3c).

On the Pi (Raspberry Pi OS Lite 64-bit, Bookworm or Trixie, both OpenVPN 2.6), as root.
`eth0` below is the Pi's LAN interface; use `wlan0` if it is on Wi-Fi (wired is preferred on site):

```bash
apt install -y openvpn iptables-persistent fake-hwclock
systemctl enable fake-hwclock-load fake-hwclock-save   # no RTC: keeps the clock past cert start dates if NTP is blocked
install -m 600 <name>.ovpn /etc/openvpn/client/pivpn.conf
systemctl enable --now openvpn-client@pivpn          # reconnects by itself (keepalive)

# forward the tunnel IP's KNX port to the site gateway (GW = its LAN IP)
echo net.ipv4.ip_forward=1 > /etc/sysctl.d/90-pivpn.conf && sysctl --system
iptables -t nat -A PREROUTING  -i tun0 -p udp --dport 3671 -j DNAT --to-destination GW:3671
iptables -t nat -A POSTROUTING -o eth0 -p udp -d GW --dport 3671 -j MASQUERADE
netfilter-persistent save
```

The gateway should have a DHCP reservation so `GW` doesn't change.

**Or let `hapi-agent` do the forwarding** (in `pi/`, Python 3 stdlib only). It finds the
gateway with a KNXnet/IP search, writes the two rules (own chains `HAPI-DNAT`/`HAPI-SNAT`,
saved), and every 10 minutes follows the gateway if its IP changes:

```bash
apt install -y conntrack
install -m 755 hapi-agent.py /usr/local/sbin/hapi-agent
install -m 644 hapi-agent.service hapi-agent.timer /etc/systemd/system/
install -d /etc/hapi && install -m 600 hapi-agent.conf.example /etc/hapi/agent.conf
systemctl daemon-reload
hapi-agent discover          # what answers on the LAN
hapi-agent test              # KNX tunnel connect/state/disconnect (takes a slot briefly)
systemctl enable --now hapi-agent.timer
hapi-agent status            # last result: VPN, gateway, forward, errors
```

Every gateway it sees is listed in its status (`gateways`). With several tunnelling
gateways it refuses to guess: the installer picks one on the setup page (below), or from
the server `ssh pivpn@10.86.0.N sudo hapi-agent pin <serial>` (`unpin` = automatic again;
the sudo rule allows only `hapi-agent`, with no password). If multicast is blocked, set `gateway_ip`. If the gateway vanishes
it keeps the last forward and reports the problem. The timer run never takes a tunnel slot
(it only sends a description request). `pi/hapi-agent.py test 10.86.0.N` run on the server tests
the whole path the way hamon connects (NAT mode). `fake-gateway.py` stands in for a gateway
on the bench.

**Installer's setup page** (`hapi-setup.py`, port 80): from a laptop on the site network,
`http://<hostname>.local/`, signed in as `admin` with the setup code printed on the
box's label (as KNX Secure devices carry their key). It shows the link to hamon, the
gateway in use and every gateway seen, and can choose a gateway, search again or run the
connection test. It answers only clients on the Pi's own LAN subnets (never over the VPN),
locks out for a minute after five wrong codes, and runs as the unprivileged `hapi` user,
whose only root action is `sudo hapi-agent`. Sign-in is a form, not browser basic auth, so
nothing is remembered by the browser: the session (an in-memory cookie) ends after 30 min
idle, 4 hours at most, on **Sign out**, when the setup code changes, or when the page restarts.

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin hapi
install -m 755 hapi-setup.py /usr/local/sbin/hapi-setup
install -m 644 hapi-setup.service /etc/systemd/system/
visudo -cf hapi.sudoers && install -m 440 hapi.sudoers /etc/sudoers.d/hapi
install -m 640 -o root -g hapi setup-code /etc/hapi/setup-code   # three random words; print it on the label
chown root:hapi /etc/hapi/agent.conf && chmod 640 /etc/hapi/agent.conf
systemctl daemon-reload && systemctl enable --now hapi-setup
```

**Check sudo is locked down** before the Pi leaves the bench. Raspberry Pi Imager can add
`/etc/sudoers.d/010_pi-nopasswd`, which gives the first user passwordless sudo for
everything; remove it if present. Then, in a fresh ssh session as `pivpn`:

```bash
ls /etc/sudoers.d/       # only README and hapi
sudo -k; sudo -l         # must ask for the password (sudo caches it for 15 min per terminal),
                         # then: NOPASSWD only for /usr/local/sbin/hapi-agent
sudo -n true             # must fail: "a password is required"
```

Then check, and point hamon at the tunnel IP:

```bash
docker logs --tail 20 pivpn-server | grep <name>   # "Peer Connection Initiated", cipher CHACHA20
ping -c 3 10.86.0.N                                 # from the server
```

In hamon-upload set the site's address to `10.86.0.N`, port `3671`. Keep the old address
noted as the fallback.

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
