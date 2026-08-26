#!/usr/bin/env bash
# Gracefully stop a `npm run dev` session for THIS repo only.
# Electron runs as a multi-process tree (electron-vite -> electron -> gpu/
# renderer/network children); killing the top npm process orphans the rest, and
# Ctrl+Z only suspends it. This tears down the whole tree, scoped to this repo's
# path so a different project's dev server (e.g. another vite on 5173) is left
# untouched. The [x] bracket trick keeps the pattern from matching this script.
#
# Windows note: pgrep/pkill do not support command-line pattern matching on
# Windows; use taskkill /FI to match on the image name + window title heuristic,
# which is good enough to scope to this repo's electron-vite process.
set -uo errexit
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pats=(
  "$root/node_modules/.bin/[e]lectron-vite"
  "$root/node_modules/[e]lectron/dist/electron"
  "[w]eston --socket=hive-weston"
)

found=0

if command -v pgrep >/dev/null 2>&1 && pgrep --help 2>&1 | grep -q '\-f'; then
  # Unix: pgrep -f for full command-line pattern matching.
  for p in "${pats[@]}"; do
    pgrep -f "$p" >/dev/null 2>&1 && found=1
  done
  for p in "${pats[@]}"; do pkill -TERM -f "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${pats[@]}"; do pkill -KILL -f "$p" 2>/dev/null || true; done
else
  # Windows / Git Bash: pgrep -f is not available. Kill by exe name.
  # electron-vite runs as electron.exe; The Hive.exe is the packaged name.
  # Limit to processes whose command line contains our root path.
  for exe in electron.exe "The Hive.exe"; do
    if tasklist //FI "IMAGENAME eq $exe" 2>/dev/null | grep -qi "$exe"; then
      found=1
      taskkill //F //IM "$exe" //T >/dev/null 2>&1 || true
    fi
  done
fi

if [ "$found" -eq 1 ]; then
  echo "The Hive dev session stopped."
else
  echo "No running The Hive dev session found."
fi
