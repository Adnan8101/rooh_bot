#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

NAME="rooh-bot"

[ -d node_modules ] || npm install

npm run build

if pm2 describe "$NAME" > /dev/null 2>&1; then
  pm2 restart "$NAME" --update-env
else
  pm2 start dist/index.js --name "$NAME" --node-args="--max-old-space-size=96 --env-file=.env"
fi

pm2 save
