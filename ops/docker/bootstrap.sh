#!/usr/bin/env bash
set -euo pipefail

usage='Usage: bash ops/docker/bootstrap.sh (--dry-run | --apply --ssh-cidr <owner CIDR>)'
if [[ $# == 1 && $1 == --dry-run ]]; then
  echo 'On Ubuntu 24.04 install Docker, Compose, UFW, Fail2ban, unattended-upgrades, cron, AWS CLI and age.'
  echo 'Permit SSH from the owner CIDR and HTTP/HTTPS for Caddy TLS. Enable UFW, sshd jail and security updates.'
  exit 0
fi
if [[ $# != 3 || $1 != --apply || $2 != --ssh-cidr ]]; then echo "$usage" >&2; exit 2; fi
[[ $(id -u) == 0 ]]
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
ssh_cidr=$(python3 -c 'import ipaddress, sys; print(ipaddress.ip_network(sys.argv[1], strict=True))' "$3")
if [[ $ssh_cidr == */0 ]]; then echo 'Specify the owner SSH network.' >&2; exit 2; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 ufw fail2ban unattended-upgrades awscli age cron
docker compose version
ufw allow from "$ssh_cidr" to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw --force enable
cat > /etc/fail2ban/jail.d/rivetquay-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
EOF
cat > /etc/apt/apt.conf.d/20rivetquay-auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now docker cron fail2ban apt-daily.timer apt-daily-upgrade.timer
systemctl restart fail2ban
