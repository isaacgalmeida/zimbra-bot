#!/bin/bash
#===============================================================================
#
#          FILE: zimbra_bind_setup_and_prereqs.sh
#
#         USAGE: ./zimbra_bind_setup_and_prereqs.sh
#
#   DESCRIPTION: Instala dependências, configura Bind DNS, desativa IPv6 e instala Zimbra.
#
#===============================================================================

set -euo pipefail  # Exige que erros parem o script

HORAINICIAL=$(date +%T)

# Default values
DEFAULT_ZIMBRA_DOMAIN="zimbra.test"
DEFAULT_ZIMBRA_HOSTNAME="mail"
DEFAULT_ZIMBRA_SERVERIP="172.16.1.20"
DEFAULT_TIMEZONE="America/Sao_Paulo"
UBUNTU_VERSION="1"  # Defina 1 para Ubuntu 18.04 ou 2 para Ubuntu 20.04

# Função de log
log() {
    echo -e "[INFO]: $1"
}

# Função para erro
error_exit() {
    echo -e "[ERROR]: $1. Exiting."
    exit 1
}

# Step 1: Install Prerequisites
log "Installing system prerequisites..."
sudo apt update && sudo apt -y full-upgrade || error_exit "System update failed."
sudo apt install -y git net-tools netcat-openbsd bind9 bind9utils libidn11 libpcre3 libgmp10 libexpat1 libstdc++6 resolvconf wget gnupg unzip || error_exit "Failed to install required packages."

# Disable any running mail services
sudo systemctl disable --now postfix 2>/dev/null || true

# Step 2: Use predefined variables
log "Using default values for Zimbra configuration..."
ZIMBRA_DOMAIN=${DEFAULT_ZIMBRA_DOMAIN}
ZIMBRA_HOSTNAME=${DEFAULT_ZIMBRA_HOSTNAME}
ZIMBRA_SERVERIP=${DEFAULT_ZIMBRA_SERVERIP}
TimeZone=${DEFAULT_TIMEZONE}

log "Zimbra Base Domain: $ZIMBRA_DOMAIN"
log "Zimbra Mail Server Hostname: $ZIMBRA_HOSTNAME"
log "Zimbra Server IP Address: $ZIMBRA_SERVERIP"
log "Timezone: $TimeZone"

# Step 3: Configure /etc/hosts file
log "Configuring /etc/hosts..."
sudo cp /etc/hosts /etc/hosts.backup
sudo tee /etc/hosts > /dev/null <<EOF
127.0.0.1       localhost
$ZIMBRA_SERVERIP   $ZIMBRA_HOSTNAME.$ZIMBRA_DOMAIN       $ZIMBRA_HOSTNAME
EOF

# Update system hostname
sudo hostnamectl set-hostname $ZIMBRA_HOSTNAME.$ZIMBRA_DOMAIN || error_exit "Failed to set hostname."
log "Hostname updated to: $(hostname -f)"

# Configure timezone
log "Configuring timezone..."
sudo timedatectl set-timezone $TimeZone || error_exit "Failed to set timezone."
sudo apt remove -y ntp 2>/dev/null || true
sudo apt install -y chrony || error_exit "Failed to install chrony."
sudo systemctl restart chrony || error_exit "Failed to restart chrony."

# Step 4: Configure Bind DNS Server
log "Configuring Bind DNS server..."
sudo cp /etc/bind/named.conf.local /etc/bind/named.conf.local.backup
sudo tee /etc/bind/named.conf.local > /dev/null <<EOF
zone "$ZIMBRA_DOMAIN" IN {
    type master;
    file "/etc/bind/db.$ZIMBRA_DOMAIN";
};
EOF

sudo tee /etc/bind/db.$ZIMBRA_DOMAIN > /dev/null <<EOF
\$TTL 1D
@       IN SOA  ns1.$ZIMBRA_DOMAIN. root.$ZIMBRA_DOMAIN. (
                                0       ; serial
                                1D      ; refresh
                                1H      ; retry
                                1W      ; expire
                                3H )    ; minimum
@               IN      NS      ns1.$ZIMBRA_DOMAIN.
@               IN      MX      0 $ZIMBRA_HOSTNAME.$ZIMBRA_DOMAIN.
ns1             IN      A       $ZIMBRA_SERVERIP
$ZIMBRA_HOSTNAME IN      A       $ZIMBRA_SERVERIP
EOF

sudo systemctl restart bind9 || error_exit "Failed to restart Bind9."
log "Bind DNS configured successfully."

# Step 5: Disable systemd-resolved and set resolv.conf
log "Disabling systemd-resolved and configuring resolv.conf..."
sudo systemctl stop systemd-resolved || true
sudo systemctl disable systemd-resolved || true

sudo tee /etc/resolv.conf > /dev/null <<EOF
nameserver 127.0.0.1
EOF
log "resolv.conf configured to use Bind DNS."

# Step 6: Validate DNS Configuration
log "Validating DNS setup..."
dig MX $ZIMBRA_DOMAIN @127.0.0.1 +short || error_exit "DNS MX record validation failed."
dig A $ZIMBRA_HOSTNAME.$ZIMBRA_DOMAIN @127.0.0.1 +short || error_exit "DNS A record validation failed."

# Step 7: Download and Install Zimbra
log "Preparing to install Zimbra..."
if [[ "$UBUNTU_VERSION" == "1" ]]; then
    ZIMBRA_URL="https://files.zimbra.com/downloads/8.8.15_GA/zcs-8.8.15_GA_3869.UBUNTU18_64.20190918004220.tgz"
elif [[ "$UBUNTU_VERSION" == "2" ]]; then
    ZIMBRA_URL="https://files.zimbra.com/downloads/8.8.15_GA/zcs-8.8.15_GA_4179.UBUNTU20_64.20211118033954.tgz"
else
    error_exit "Invalid Ubuntu version specified."
fi

wget $ZIMBRA_URL -O zimbra.tgz || error_exit "Failed to download Zimbra package."
tar xvf zimbra.tgz || error_exit "Failed to extract Zimbra package."
cd zcs*/ || error_exit "Failed to navigate to Zimbra directory."

echo -e "\n[INFO]: Atenção! Durante a instalação do Zimbra, **não instale o pacote 'zimbra-dnscache'**."
echo -e "[INFO]: O DNS Cache do Zimbra não é necessário quando o Bind já está configurado e operacional."
echo -e "[INFO]: Certifique-se de selecionar 'N' (não) para evitar conflitos.\n"
sleep 5

log "Starting Zimbra installer..."
sudo ./install.sh
