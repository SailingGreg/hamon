#!/usr/bin/env bash
#
# hapi-install.sh  -  make a freshly imaged Raspberry Pi OS Lite box a site Pi.
#
# Run as root on the Pi from the directory holding the files of pivpn/pi
# (pivpn/hapi-build.sh copies them over and runs this), with two lines on
# stdin: the password for the pivpn user (sudo and the local console only;
# ssh is key-only), then the setup code for the installer's setup page.
# authorized_keys (beside this script) is pivpn's ssh keys: the dev Pi's and
# prod's (hapi-collect).
#
# Everything here is the same on every Pi; nothing about the site. Safe to
# run again: it updates the files and settings and keeps agent.conf, the
# gateway state and an installed VPN profile (pivpn/hapi-assign.sh adds that).
#
# It doesn't remove Raspberry Pi Imager's passwordless sudo
# (/etc/sudoers.d/010_pi-nopasswd) - hapi-build.sh does that last, once it has
# checked that pivpn can log in and use sudo with the password.
#

set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" = 0 ] || { echo "hapi-install: run as root" >&2; exit 1; }
IFS= read -r PW || true
IFS= read -r CODE || true
[ -n "${PW:-}" ] && [ -n "${CODE:-}" ] || { echo "hapi-install: the password and setup code go on stdin" >&2; exit 1; }
for f in hapi-hostname.sh hapi-hostname.service hapi-agent.py hapi-agent.service hapi-agent.timer \
         hapi-agent.conf.example hapi-setup.py hapi-setup.service hapi.sudoers authorized_keys; do
    [ -f "$f" ] || { echo "hapi-install: $f missing" >&2; exit 1; }
done
step() { echo "== $*"; }

step packages
export DEBIAN_FRONTEND=noninteractive
# iptables-persistent asks whether to save the current rules: no, the agent saves its own
echo "iptables-persistent iptables-persistent/autosave_v4 boolean false" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean false" | debconf-set-selections
apt-get -qq update
apt-get -qq -y install openvpn iptables-persistent conntrack fake-hwclock unattended-upgrades \
    avahi-daemon python3 >/dev/null

step "hostname (hapi-<eth0 MAC>)"
install -m 755 hapi-hostname.sh /usr/local/sbin/
install -m 644 hapi-hostname.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q hapi-hostname
/usr/local/sbin/hapi-hostname.sh

step "clock (no RTC: fake-hwclock keeps it past the certificate start dates if NTP is blocked)"
# Trixie splits it into -load/-save (the old fake-hwclock.service is masked there)
if systemctl cat fake-hwclock-load.service >/dev/null 2>&1; then
    systemctl enable -q fake-hwclock-load fake-hwclock-save
else
    systemctl enable -q fake-hwclock
fi

step "unattended upgrades (Debian security + Raspberry Pi archive, reboot 03:30)"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52hapi-unattended <<'EOF'
// hapi site Pi (pivpn/pi/hapi-install.sh)
Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
        "origin=Raspberry Pi Foundation,codename=${distro_codename}";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF

step "users: pivpn (ssh keys, sudo with the password), hapi (setup page)"
id pivpn >/dev/null 2>&1 || useradd -m -s /bin/bash pivpn
usermod -aG sudo pivpn
echo "pivpn:$PW" | chpasswd
install -d -m 700 -o pivpn -g pivpn ~pivpn/.ssh
install -m 600 -o pivpn -g pivpn authorized_keys ~pivpn/.ssh/authorized_keys
id hapi >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hapi

step "ssh: keys only, no root"
cat >/etc/ssh/sshd_config.d/01-hapi.conf <<'EOF'
# hapi site Pi (pivpn/pi/hapi-install.sh)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

step "hapi-agent (gateway discovery and the KNX forward)"
install -m 755 hapi-agent.py /usr/local/sbin/hapi-agent
install -m 644 hapi-agent.service hapi-agent.timer /etc/systemd/system/
install -d -m 755 /etc/hapi /var/lib/hapi
[ -f /etc/hapi/agent.conf ] || install -m 640 hapi-agent.conf.example /etc/hapi/agent.conf
chown root:hapi /etc/hapi/agent.conf
chmod 640 /etc/hapi/agent.conf

step "setup page (http://<hostname>.local/, admin + the setup code)"
install -m 755 hapi-setup.py /usr/local/sbin/hapi-setup
install -m 644 hapi-setup.service /etc/systemd/system/
printf '%s\n' "$CODE" >/etc/hapi/setup-code
chown root:hapi /etc/hapi/setup-code
chmod 640 /etc/hapi/setup-code
visudo -qcf hapi.sudoers
install -m 440 hapi.sudoers /etc/sudoers.d/hapi

step "IP forwarding"
echo net.ipv4.ip_forward=1 >/etc/sysctl.d/90-pivpn.conf
sysctl -q --system

step services
systemctl daemon-reload
systemctl enable -q --now hapi-agent.timer
systemctl enable -q hapi-setup
systemctl restart hapi-setup
if [ -f /etc/openvpn/client/pivpn.conf ]; then
    systemctl enable -q --now openvpn-client@pivpn
else
    echo "   no VPN profile yet (/etc/openvpn/client/pivpn.conf): pivpn/hapi-assign.sh adds it"
fi

echo "hapi-install: done on $(hostname)"
