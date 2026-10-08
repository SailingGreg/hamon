# Pi-VPN server: admin guide

Site Pis dial **out** to this OpenVPN server. Each Pi gets a fixed tunnel IP `10.8.0.N`,
which is that site's KNX endpoint for hamon. The Pi forwards `10.8.0.N:3671` to the
site's KNX gateway. No port forwards are needed at the site.

## Where things are (on the server)

| What | Where |
|---|---|
| Container | `pivpn-server` (image `openvpn-pivpn`, built from this directory) |
| Data: config, PKI incl. CA key, ccd, client configs | `~/pivpn` (0700, backed up nightly by `hamon-backup2`) |
| Server config | `~/pivpn/server.conf` (a copy of `server.conf` here; edit the copy) |
| One file per site: fixed IP (+ LAN map) | `~/pivpn/ccd/<name>` |
| Client configs to give to Pis | `~/pivpn/clients/<name>.ovpn` (contain the private key) |
| Tunnel on the host | `pivpn`, 10.8.0.1/16; UDP 1194 |

Address plan: `10.8.0.N` = site N (start at 11), `10.8.0.200+` = bench/test,
`10.100.N.0/24` = site N's LAN as seen through the tunnel (support access, later).
Pick a free N with `grep -h ifconfig-push ~/pivpn/ccd/*`.

## Add a site

On the server:

```bash
docker exec --user "$(id -u)" pivpn-server pivpn-add <name> 10.8.0.N 10.100.N.0
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
apt install -y openvpn iptables-persistent
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
install -m 755 hapi-agent /usr/local/sbin/
install -m 644 hapi-agent.service hapi-agent.timer /etc/systemd/system/
install -d /etc/hapi && install -m 600 hapi-agent.conf.example /etc/hapi/agent.conf
systemctl daemon-reload
hapi-agent discover          # what answers on the LAN
hapi-agent test              # KNX tunnel connect/state/disconnect (takes a slot briefly)
systemctl enable --now hapi-agent.timer
hapi-agent status            # last result: VPN, gateway, forward, errors
```

With several tunnelling gateways it refuses to guess: set `gateway_serial` in
`/etc/hapi/agent.conf`. If multicast is blocked, set `gateway_ip`. If the gateway vanishes
it keeps the last forward and reports the problem. The timer run never takes a tunnel slot
(it only sends a description request). `hapi-agent test 10.8.0.N` run on the server tests
the whole path the way hamon connects (NAT mode). `fake-gateway.py` stands in for a gateway
on the bench.

Then check, and point hamon at the tunnel IP:

```bash
docker logs --tail 20 pivpn-server | grep <name>   # "Peer Connection Initiated", cipher CHACHA20
ping -c 3 10.8.0.N                                 # from the server
```

In hamon-upload set the site's address to `10.8.0.N`, port `3671`. Keep the old address
noted as the fallback.

## Status

```bash
docker exec pivpn-server cat /tmp/pivpn-status.log  # connected clients, refreshed every 60s
docker logs --since 1h pivpn-server
```

Site-Pi health: `hapi-collect.timer` (every 5 min, as greg) fetches each Pi's `hapi-agent`
status over ssh (`pivpn@10.8.0.N`, prod's key) and publishes it retained on the local broker
as `hapi/<name>/status`, with `reachable: false` for a Pi that doesn't answer:

```bash
mosquitto_sub -t 'hapi/+/status' -v -W 3       # current state of every Pi
journalctl -u hapi-collect -n 20               # one line per Pi per run
```

Install once: `install -m 644 hapi-collect.service hapi-collect.timer /etc/systemd/system/`,
then `systemctl daemon-reload && systemctl enable --now hapi-collect.timer`. A new Pi needs
prod's ssh key in its `~pivpn/.ssh/authorized_keys`.

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
