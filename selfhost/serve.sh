#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
: "${CODEX_GATEWAY_DB_PATH:=$repo/.data/codex-web.db}"
: "${CODEX_GATEWAY_SSH_KEY_DIR:=$repo/ssh-keys}"
: "${CODEX_GATEWAY_KNOWN_HOSTS:=$repo/ssh-keys/known_hosts}"
: "${SELFHOST_ASSET_DIR:=$repo/.selfhost/current/assets}"
export CODEX_GATEWAY_DB_PATH CODEX_GATEWAY_SSH_KEY_DIR CODEX_GATEWAY_KNOWN_HOSTS SELFHOST_ASSET_DIR
[ -f "$repo/.selfhost/current/api/.output/server/index.mjs" ] || { echo '先运行 sh selfhost/build.sh' >&2; exit 1; }
exec node --env-file=.env --input-type=module - "$repo" <<'JS'
import {pathToFileURL} from "node:url";import {join} from "node:path";
process.env.NITRO_HOST ||= process.env.CODEX_WEB_BIND || "127.0.0.1";
process.env.NITRO_PORT ||= process.env.CODEX_WEB_PORT || "33723";
await import(pathToFileURL(join(process.argv[2],".selfhost/current/api/.output/server/index.mjs")).href);
JS
