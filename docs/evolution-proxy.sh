#!/usr/bin/env bash
# Publica a Evolution API com HTTPS (porta 443) sem precisar comprar domínio.
# Rode NA VPS DA EVOLUTION (Ubuntu/Debian), como root:
#   curl -fsSL https://raw.githubusercontent.com/<seu-usuario>/<seu-repo>/main/docs/evolution-proxy.sh | bash
#   (ou copie este arquivo para a VPS e rode: bash evolution-proxy.sh)
# Porta da Evolution diferente de 8082?  EVOLUTION_PORT=8080 bash evolution-proxy.sh
#
# Resultado: https://SEU-IP-com-traços.sslip.io  →  127.0.0.1:8082
# O checkout detecta esse endereço sozinho quando a URL http://IP:8082 não responde
# (ex.: hospedagem que bloqueia saída para portas fora do padrão).
set -euo pipefail
PORT="${EVOLUTION_PORT:-8082}"
IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 ifconfig.me)"
HOST="$(echo "$IP" | tr '.' '-').sslip.io"
echo "IP público: $IP  →  domínio: $HOST  →  Evolution na porta $PORT"

curl -fsS -m 5 "http://127.0.0.1:$PORT" >/dev/null || { echo "ERRO: nada respondendo em 127.0.0.1:$PORT. A Evolution está rodando nessa porta?"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

cat >/etc/nginx/sites-available/evolution <<NGINX
server {
  listen 80;
  server_name $HOST;
  client_max_body_size 50m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/evolution /etc/nginx/sites-enabled/evolution
nginx -t && systemctl reload nginx

# libera 80/443 no firewall, se houver
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp; ufw allow 443/tcp; fi

certbot --nginx -d "$HOST" --non-interactive --agree-tos --register-unsafely-without-email --redirect

echo
echo "Pronto! Teste: curl https://$HOST"
echo "No checkout (Integrações → WhatsApp), use a URL:  https://$HOST"
