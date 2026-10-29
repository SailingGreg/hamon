# wg-central: the server end of hamon's WireGuard site tunnels (exploration).
# Runs in the host's network namespace (--network host) so hamon reaches the
# boxes' tunnel addresses directly, as it does for pivpn-server today. The
# wireguard module is the host kernel's; this image only carries the tools.
FROM alpine:3.23
RUN apk --no-cache --no-progress add wireguard-tools-wg iptables iptables-legacy bash tini
COPY wg-central.sh wg-peer /usr/local/bin/
VOLUME ["/etc/wg-central"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["wg-central.sh"]
