#!/usr/bin/env bash
# Gracefully stop a `npm run dev` session for THIS repo only.
# Electron runs as a multi-process tree (electron-vite -> electron -> gpu/
# renderer/network children); killing the top npm process orphans the rest, and
# Ctrl+Z only suspends it. This tears down the whole tree, scoped to this repo's
# path so a different project's dev server (e.g. another vite on 5173) is left
# untouched. The [x] bracket trick keeps the pattern from matching this script.
#
# Windows path: PowerShell Get-CimInstance scopes by BOTH exe name AND command
# line containing this repo's path — same guarantee as pkill -f, without
# accidentally killing the packaged app or any other Electron project.
set -uo errexit
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Convert to Windows path for command-line matching on Windows (spaces handled).
win_root="$(cygpath -w "$root" 2>/dev/null || echo "$root")"

pats=(
  "$root/node_modules/.bin/[e]lectron-vite"
  "$root/node_modules/[e]lectron/dist/electron"
  "[w]eston --socket=hive-weston"
)

found=0

if command -v pgrep >/dev/null 2>&1 && pgrep --help 2>&1 | grep -q '\-f'; then
  # Unix: pgrep -f matches the full command line — correctly scoped to $root.
  for p in "${pats[@]}"; do
    pgrep -f "$p" >/dev/null 2>&1 && found=1
  done
  # SIGTERM first so the app's before-quit teardown (PTY killAll, socket close) can run.
  for p in "${pats[@]}"; do pkill -TERM -f "$p" 2>/dev/null || true; done
  sleep 1
  # Escalate to SIGKILL for anything that ignored the term (Electron GPU/zygote often do).
  for p in "${pats[@]}"; do pkill -KILL -f "$p" 2>/dev/null || true; done
else
  # Windows / Git Bash: use PowerShell Get-CimInstance to filter by BOTH exe name
  # AND CommandLine containing this repo's root path. This matches the scoping
  # guarantee of pkill -f — it will NOT kill the packaged app ('Munder Difflin',
  # a different image name), a packaged 'The Hive.exe' that launched from a
  # different path, or any unrelated Electron app.
  # Escape any single-quotes in the path (e.g. username O'Brien) before
  # interpolating into the PowerShell single-quoted string literal.
  ps_root="${win_root//\'/\'\'}"
  ps_script="
\$rootPath = '$ps_root'.Replace('/', '\\')
\$exes = @('electron.exe', 'The Hive.exe')
\$pattern = [regex]::Escape(\$rootPath) + '\\\\'
\$matched = Get-CimInstance Win32_Process |
  Where-Object { \$_.Name -in \$exes -and \$_.CommandLine -match \$pattern }
\$count = (\$matched | Measure-Object).Count
if (\$count -gt 0) {
  \$matched | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output \"killed \$count\"
} else {
  Write-Output 'none'
}
"
  result="$(powershell.exe -NoProfile -NonInteractive -Command "$ps_script" 2>/dev/null || echo 'ps_unavailable')"
  if echo "$result" | grep -q "^killed"; then
    found=1
  fi
fi

if [ "$found" -eq 1 ]; then
  echo "The Hive dev session stopped."
else
  echo "No running The Hive dev session found."
fi
