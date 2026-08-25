#!/usr/bin/env bash
# Launch The Hive dev fully DETACHED from the terminal.
#
# Symptom this fixes: `npm run dev` shows "[N]+ Stopped" on its own (no Ctrl+Z)
# and the app window freezes. That is TTY job control suspending the process —
# Electron's GL log spam (GetVSyncParametersIfAvailable...) written to a terminal
# that has `tostop`, or the job being backgrounded, delivers SIGTTOU/SIGTSTP and
# STOPS the process tree. A stopped process is paused, so the window freezes.
#
# setsid gives the dev server its own session with NO controlling terminal, and
# stdin/stdout/stderr are detached to a log file, so no job-control signal can
# reach it. The app runs independently of this shell.
#
# Watch logs:  tail -f .dev.log        Stop:  npm run stop
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$root/.dev.log"

# One clean instance: clear any prior/suspended tree first.
bash "$root/scripts/dev-stop.sh" >/dev/null 2>&1 || true

: > "$log"
setsid bash -c "cd '$root' && exec npm run dev" </dev/null >>"$log" 2>&1 &
pid=$!
disown "$pid" 2>/dev/null || true

echo "The Hive dev launched detached (session pid $pid)."
echo "  window opens shortly · logs: tail -f .dev.log · stop: npm run stop"
