# OpenVPN client for one hamon VPN site, tap or tun (see openvpn.sh). Replaces
# openvpn-client (tap) and openvpn-tunv2 (tun). Alpine 3.23, as pivpn/: OpenVPN
# 2.6 with OpenSSL 3.5.
FROM alpine:3.23

# busybox gives ip, ping, pkill and udhcpc (the tap address); the tools that
# docker exec into site containers (vpn-probe, vpn-reconnect, vpn-discover)
# need nothing more than these
RUN apk --no-cache --no-progress add bash openvpn iptables tini tzdata

COPY openvpn.sh udhcpc.script /usr/local/bin/

# healthy = the tunnel interface has its address (tun: from the server, tap:
# from DHCP on the site LAN)
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s \
    CMD ip -4 addr show dev "$(cat /run/vpn-ifname 2>/dev/null)" 2>/dev/null | grep -q inet

VOLUME ["/vpn"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/openvpn.sh"]
