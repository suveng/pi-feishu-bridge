#!/bin/sh
# 开机自启引导（launchd 的 ProgramArguments 就是 /bin/sh <本文件>）。
#
# 为什么不把 node 绝对路径写进 plist：node 由 fnm/brew 管理，升级后旧路径被删，
# launchd 只会在日志里留一行 "No such file or directory"，开机自启从此静默失效。
# 这里每次启动现找一遍。
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
supervisor="$here/autostart-supervisor.mjs"

if [ ! -f "$supervisor" ]; then
  echo "[feishu-autostart] 找不到 supervisor：$supervisor"
  exit 1
fi

# 优先级：显式覆盖 → pi 自带 node → PATH 里的 node → fnm 最高版本 → Homebrew。
# 与 package.json engines（^22.19.0 || >=24.0.0）一致：fnm 里若同时有 v20 与 v24，sort -V 取 v24。
node=""
for candidate in \
  "${FEISHU_AUTOSTART_NODE:-}" \
  "${PI_NODE_BIN:-}" \
  "$HOME/.local/share/pi-node/current/bin/node" \
  "$(command -v node 2>/dev/null || true)" \
  "$(ls -d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    node="$candidate"
    break
  fi
done

if [ -z "$node" ]; then
  echo "[feishu-autostart] 找不到可用的 node（检查 fnm / brew，或设 FEISHU_AUTOSTART_NODE）"
  exit 127
fi

exec "$node" "$supervisor" --watch
