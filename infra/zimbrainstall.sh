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

# Opções do comando cut: -d (delimiter), -f (fields)
LOG="/var/log/$(echo $0 | cut -d'/' -f2)"

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
sudo apt install -y git net-tools netcat-openbsd libidn11 libpcre3 libgmp10 libexpat1 libstdc++6 libperl5* libaio1 resolvconf unzip pax sysstat sqlite3 bind9 bind9utils clamav clamav-daemon libnet-dns-perl libmail-spf-perl libio-string-perl libio-socket-ssl-perl

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

# Temporarily disable IPv6
echo -e "\n[INFO]: Disabling IPv6..."
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# Persist the configuration across reboots
sudo cp /etc/sysctl.conf /etc/sysctl.conf.backup
sudo tee -a /etc/sysctl.conf<<EOF
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
EOF

sudo sysctl -p

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

sudo tee /etc/bind/named.conf.options<<EOF
options {
    directory "/var/cache/bind";

    forwarders {
        8.8.8.8;
        1.1.1.1;
    };

    dnssec-validation no;

    listen-on-v6 { none; };
	listen-on { any; };
};
EOF

sudo systemctl enable bind9
sudo systemctl restart bind9 || error_exit "Failed to restart Bind9."
log "Bind DNS configured successfully."

# Step 5: Disable systemd-resolved and set resolv.conf
log "Disabling systemd-resolved and configuring resolv.conf..."
sudo systemctl stop systemd-resolved || true
sudo systemctl disable systemd-resolved || true

# Step 6: Validate DNS Configuration
log "Validating DNS setup..."
dig MX $ZIMBRA_DOMAIN @127.0.0.1 +short || error_exit "DNS MX record validation failed."
dig A $ZIMBRA_HOSTNAME.$ZIMBRA_DOMAIN @127.0.0.1 +short || error_exit "DNS A record validation failed."

# Step 7: Download and Install Zimbra
log "Preparing to install Zimbra..."

# Registrar a chave GPG do Zimbra
if [[ -f "/tmp/zimbra-pubkey.asc" ]]; then
    log "Adding Zimbra GPG key to the system..."
    sudo apt-key add /tmp/zimbra-pubkey.asc || error_exit "Failed to add Zimbra GPG key."
else
    error_exit "Zimbra GPG key not found at /tmp/zimbra-pubkey.asc."
fi

if [[ "$UBUNTU_VERSION" == "1" ]]; then
    ZIMBRA_URL="https://files.zimbra.com/downloads/8.8.15_GA/zcs-8.8.15_GA_3869.UBUNTU18_64.20190918004220.tgz"
elif [[ "$UBUNTU_VERSION" == "2" ]]; then
    ZIMBRA_URL="https://files.zimbra.com/downloads/8.8.15_GA/zcs-8.8.15_GA_4179.UBUNTU20_64.20211118033954.tgz"
else
    error_exit "Invalid Ubuntu version specified."
fi

wget $ZIMBRA_URL -O zimbra.tgz || error_exit "Failed to download Zimbra package."
tar xvf zimbra.tgz || error_exit "Failed to extract Zimbra package."

sudo apt-get update -y

sudo tee /etc/resolv.conf > /dev/null <<EOF
nameserver 127.0.0.1
EOF

log "resolv.conf configured to use Bind DNS."

log "Starting Zimbra installer..."
sleep 3
	cd zcs*/
		./install.sh
	cd ..
sleep 3
# Configure Amavis to use IPv4 only
log "Configuring Amavis to use IPv4 only..."
if [[ ! -f /opt/zimbra/conf/amavisd.conf ]]; then
    sudo mkdir -p /opt/zimbra/conf
    sudo touch /opt/zimbra/conf/amavisd.conf
fi

sudo tee -a /opt/zimbra/conf/amavisd.conf > /dev/null <<EOF
@inet_socket_bind = ('127.0.0.1');  # Força uso apenas de IPv4
EOF
log "Amavis configured to use IPv4 only."

echo -e "Habilitando o Serviço do Zimbra Collaboration Community, aguarde..."
	# opção do comando: &>> (redirecionar a saída padrão)
	systemctl enable zimbra.service &>> $LOG
	systemctl start zimbra.service &>> $LOG
echo -e "Serviço habilitado com sucesso!!!, continuando com o script...\n"
sleep 5
#
echo -e "Verificando o Status dos Serviços do Zimbra Collaboration Community, aguarde..."
	# opção do comando: &>> (redirecionar a saída padrão)
	# opção do comando su: - (login), -c (command)
	su - zimbra -c "zmcontrol status" &>> $LOG
echo -e "Verificação do Status dos Serviços feita com sucesso!!!, continuando com o script...\n"
sleep 5
#
echo -e "Verificando as portas de Conexões do Zimbra Collaboration Community, aguarde..."
	# opção do comando netstat: -a (all), -n (numeric)
	# portas do Zimbra: 80 (http), 25 (smtp), 110 (pop3), 143 (imap4), 443 (https), 587 (smtp), 7071 (admin)
	netstat -an | grep '0:80\|0:25\|0:110\|0:143\|0:443\|0:587\|0:7071'
echo -e "Portas de conexões verificadas com sucesso!!!, continuando com o script...\n"
sleep 5

log "Restarting Zimbra services..."
sudo su - zimbra -c "zmcontrol restart"

# Final log messages
echo -e "Instalação do Zimbra Collaboration Community concluída com sucesso!\n"

HORAFINAL=$(date +%T)

# Convertendo tempos para segundos desde o Epoch
HORAINICIAL_SEG=$(date -u -d "$HORAINICIAL" +"%s")
HORAFINAL_SEG=$(date -u -d "$HORAFINAL" +"%s")

# Calculando a diferença
DIFERENCA=$((HORAFINAL_SEG - HORAINICIAL_SEG))

# Convertendo a diferença para o formato HH:MM:SS
TEMPO=$(date -u -d "@$DIFERENCA" +"%H:%M:%S")

echo "Tempo inicial: $HORAINICIAL"
echo "Tempo final: $HORAFINAL"
echo "Tempo gasto na instalação: $TEMPO"

log "INFORMAÇÕES PARA ACESSO AO ZIMBRA ADMIN CONSOLE:"
echo -e "URL: https://${DEFAULT_ZIMBRA_HOSTNAME}.${DEFAULT_ZIMBRA_DOMAIN}:7071\nUsuário: admin\n"

log "Fim do script."
exit 0
