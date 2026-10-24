# Pi-VPN OpenVPN server for hamon (see setup.sh).  Alpine 3.23: OpenVPN 2.6
# with OpenSSL 3.5 (LTS series); 3.20, the openvpn-tunv2 client image's base,
# went out of support in April 2026.
FROM alpine:3.23

# the server drops to this uid after start-up; it should own the host's data
# directory so config, PKI and ccd stay private to that user (and its backup)
ARG PIVPN_UID=1001
RUN apk --no-cache --no-progress add openvpn easy-rsa tini bash && \
    addgroup -g "$PIVPN_UID" pivpn && \
    adduser -D -H -u "$PIVPN_UID" -G pivpn -s /sbin/nologin pivpn

COPY server.conf /usr/local/share/pivpn/server.conf
COPY pivpn-init pivpn-add /usr/local/bin/

WORKDIR /etc/pivpn
VOLUME ["/etc/pivpn"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["openvpn", "--config", "/etc/pivpn/server.conf"]
