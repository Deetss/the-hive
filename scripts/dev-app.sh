#!/usr/bin/env bash
# Launch The Hive dev fully DETACHED from the terminal.
#
# Symptom this fixes: `npm run dev` shows "[N]+ Stopped" on its own (no Ctrl+Z)
# and the app window freezes. That is TTY job control suspending the process —
# Electron's GL log spam (GetVSyncParametersIfAvailable...) written to a terminal
# that has `tostop`, or the job being backgrounded, delivers SIGTTOU/SIGTSTP and
# STOPS the process tree. A stopped process is paused, so the window freezes.
#
# On Linux/macOS: setsid gives the dev server its own session with NO controlling
# terminal so no job-control signal can reach it.
# On Windows (Git Bash): setsid is not available. We use nohup + background
# redirect, which achieves the same effect — the process ignores SIGHUP and its
# stdio is detached from the terminal.
#
# Watch logs:  tail -f .dev.log        Stop:  npm run stop
set -uo errexit
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$root/.dev.log"

# One clean instance: clear any prior/suspended tree first.
bash "$root/scripts/dev-stop.sh" >/dev/null 2>&1 || true

: > "$log"

if command -v setsid >/dev/null 2>&1; then
  # Linux/macOS: setsid creates a new session, fully detached from job control.
  setsid bash -c "cd '$root' && exec npm run dev" </dev/null >>"$log" 2>&1 &
  pid=$!
  disown "$pid" 2>/dev/null || true
else
  # Windows / Git Bash: nohup + background. nohup redirects stdin from /dev/null
  # and ignores SIGHUP; the output redirect detaches stdio from the terminal.
  # We must export HOME/PATH for npm to work in the subshell.
  ( cd "$root" && nohup npm run dev </dev/null >>"$log" 2>&1 ) &
  pid=$!
  disown "$pid" 2>/dev/null || true
fi

echo "The Hive dev launched detached (pid $pid)."
echo "  window opens shortly · logs: tail -f .dev.log · stop: npm run stop"
