#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
mkdir -p .selfhost
stage=$(mktemp -d "$repo/.selfhost/release-XXXXXXXX")
corepack pnpm --filter . --filter @zcode/web... install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @zcode/web build
node selfhost/worker/build.mjs "$stage/assets/workspace.cjs"
python3 selfhost/gateway/materialize.py "$stage/api"
mkdir -p "$stage/api/public"
cp -R packages/web/dist/. "$stage/api/public/"
(cd "$stage/api" && npm ci --no-audit --no-fund && npm run build)
cp selfhost/upstreams.lock.json "$stage/"
node --input-type=module - "$repo" "$stage" <<'JS'
import {symlink,rename} from "node:fs/promises";
import {basename,join} from "node:path";
const [, , root,stage]=process.argv;const link=join(root,".selfhost",".current-"+process.pid);
await symlink(basename(stage),link);await rename(link,join(root,".selfhost","current"));
JS
printf '%s\n' "$stage"
