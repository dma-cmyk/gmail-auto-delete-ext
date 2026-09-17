#!/usr/bin/env bash
# .env から manifest.json を生成する（実IDをgitに入れないための仕組み）
# 使い方: cp .env.example .env → .envを編集 → ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo ".env がありません。先に 'cp .env.example .env' して値を編集してください。" >&2
  exit 1
fi
if [ ! -f manifest.template.json ]; then
  echo "manifest.template.json がありません。" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ./.env
set +a

if [ -z "${GMAIL_OAUTH_CLIENT_ID:-}" ] || [ "$GMAIL_OAUTH_CLIENT_ID" = "YOUR_CLIENT_ID.apps.googleusercontent.com" ]; then
  echo "GMAIL_OAUTH_CLIENT_ID が .env に設定されていません。" >&2
  exit 1
fi

python3 - "$GMAIL_OAUTH_CLIENT_ID" <<'EOF'
import json, sys
cid = sys.argv[1]
with open("manifest.template.json", encoding="utf-8") as f:
    d = json.load(f)
d["oauth2"]["client_id"] = cid
with open("manifest.json", "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("manifest.json を生成しました")
EOF
