#!/usr/bin/env bash
# nginx -t de um arquivo de site num container nginx:1.24 (a versão da VM),
# com o layout do Ubuntu (conf.d/*.conf antes de sites-enabled/*), certificados
# FICTÍCIOS autoassinados nos mesmos caminhos do Certbot e a cópia das zonas
# de limite. Nada de produção é tocado.
#
# Uso (no WSL): bash nginx_t_docker.sh <site.conf> [limits.conf]
#   NGINX_IMAGE (padrão nginx:1.24)   CERT_CACHE (padrão /tmp/authz-nginx-certs)
set -euo pipefail

SITE="$(readlink -f "$1")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIMITS_SRC="${2:-$HERE/kuapoa-limits.prod.conf}"
IMAGE="${NGINX_IMAGE:-nginx:1.24}"
CACHE="${CERT_CACHE:-/tmp/authz-nginx-certs}"

mkdir -p "$CACHE/le/live/bongo.dobslit.com" "$CACHE/etc"
LIVE="$CACHE/le/live/bongo.dobslit.com"
if [ ! -s "$LIVE/fullchain.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=bongo.dobslit.com" \
    -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" >/dev/null 2>&1
fi
if [ ! -s "$CACHE/le/ssl-dhparams.pem" ]; then
  openssl dhparam -dsaparam -out "$CACHE/le/ssl-dhparams.pem" 2048 >/dev/null 2>&1
fi
# conteúdo padrão do Certbot (options-ssl-nginx.conf)
cat > "$CACHE/le/options-ssl-nginx.conf" <<'EOF'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
EOF
# a cópia das zonas veio com uma linha extra da captura (`nginx version: …`):
# só diretivas e comentários entram
grep -E '^[[:space:]]*(#|limit_|$)' "$LIMITS_SRC" > "$CACHE/etc/kuapoa-limits.conf"
: > "$CACHE/etc/empty.conf"
cat > "$CACHE/etc/nginx.conf" <<'EOF'
user nginx;
worker_processes 1;
pid /var/run/nginx.pid;
events { worker_connections 64; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
EOF

docker run --rm --network none \
  -v "$CACHE/etc/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$CACHE/etc/kuapoa-limits.conf:/etc/nginx/conf.d/kuapoa-limits.conf:ro" \
  -v "$CACHE/etc/empty.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$SITE:/etc/nginx/sites-enabled/bongo.dobslit.com:ro" \
  -v "$CACHE/le:/etc/letsencrypt:ro" \
  "$IMAGE" nginx -t
