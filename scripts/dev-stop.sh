#!/usr/bin/env bash
# Gracefully stop a `npm run dev` session for THIS repo only.
# Electron runs as a multi-process tree (electron-vite -> electron -> gpu/
# renderer/network children); killing the top npm process orphans the rest, and
# Ctrl+Z only suspends it. This tears down the whole tree, scoped to this repo's
# path so a different project's dev server (e.g. another vite on 5173) is left
# untouched. The [x] bracket trick keeps the pattern from matching this script.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pats=(
  "$root/node_modules/.bin/[e]lectron-vite"
  "$root/node_modules/[e]lectron/dist/electron"
  "[w]eston --socket=hive-weston"
)

found=0
for p in "${pats[@]}"; do
  pgrep -f "$p" >/dev/null 2>&1 && found=1
done

# SIGTERM first so the app's before-quit teardown (PTY killAll, socket close) can run.
for p in "${pats[@]}"; do pkill -TERM -f "$p" 2>/dev/null || true; done
sleep 1
# Escalate to SIGKILL for anything that ignored the term (Electron GPU/zygote often do).
for p in "${pats[@]}"; do pkill -KILL -f "$p" 2>/dev/null || true; done

if [ "$found" -eq 1 ]; then
  echo "The Hive dev session stopped."
else
  echo "No running The Hive dev session found."
fi
