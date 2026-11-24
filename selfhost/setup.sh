#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p ssh-keys
if [ ! -f .env ]; then
  secret=$(openssl rand -hex 32)
  (set -C; printf 'CODEX_GATEWAY_CONFIG_SECRET=%s\nCODEX_WEB_PORT=33723\nCODEX_WEB_BIND=127.0.0.1\n' "$secret" > .env)
fi
chmod 600 .env
printf '%s\n' '配置已就绪。使用 sh selfhost/update.sh 启动。'
