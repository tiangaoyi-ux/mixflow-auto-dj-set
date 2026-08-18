#!/usr/bin/env bash
# 本地预览。必须走 http —— 直接双击 index.html 的话 file:// 会挡掉 fetch,样例歌单加载不了。
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "→ http://localhost:$PORT"
python3 -m http.server "$PORT"
