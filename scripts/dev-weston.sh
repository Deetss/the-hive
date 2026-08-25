#!/usr/bin/env bash
# Run The Hive dev inside a NESTED weston compositor.
#
# Why: COSMIC's compositor does not route pointer/keyboard input to this Electron
# window (a known COSMIC+Electron issue — neither native Wayland nor XWayland
# works). weston is a small, standard Wayland compositor. Run nested, it opens a
# single window on COSMIC (as a native Wayland client, which COSMIC DOES feed
# input to) and the app runs as weston's client — weston delivers the input the
# app needs. Both weston and the app are detached from this terminal so job
# control can't suspend them.
#
# Watch logs:  tail -f .dev.log        Stop:  npm run stop  (kills weston too)
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$root/.dev.log"
sock="hive-weston"
rundir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

command -v weston >/dev/null 2>&1 || {
  echo "weston not found. Install it first:  sudo apt install weston"; exit 1; }
[ -n "${WAYLAND_DISPLAY:-}" ] || {
  echo "No WAYLAND_DISPLAY in this shell — run this from your COSMIC desktop terminal."; exit 1; }

# One clean slate (kills any prior app tree and a stale nested weston).
bash "$root/scripts/dev-stop.sh" >/dev/null 2>&1 || true
rm -f "$rundir/$sock" "$rundir/$sock.lock" 2>/dev/null || true

: > "$log"
# weston auto-selects its wayland backend because WAYLAND_DISPLAY is set (nested).
setsid weston --socket="$sock" --width=1680 --height=1050 </dev/null >>"$log" 2>&1 &

# Wait for weston's socket to come up.
for _ in $(seq 1 40); do [ -S "$rundir/$sock" ] && break; sleep 0.25; done
[ -S "$rundir/$sock" ] || { echo "weston did not start — see $log"; exit 1; }

# Launch the app as a client of weston (its socket), forced onto Wayland, detached.
# Call electron-vite directly, NOT `npm run dev`: the predev hook runs dev-stop,
# which kills processes matching `hive-weston` — i.e. it would kill the weston we
# just started. We already cleared any prior tree above, so predev is redundant
# here anyway.
setsid bash -c "cd '$root' && exec env WAYLAND_DISPLAY='$sock' THEHIVE_OZONE=wayland '$root/node_modules/.bin/electron-vite' dev" \
  </dev/null >>"$log" 2>&1 &

echo "A weston window opened on your desktop — The Hive is running inside it."
echo "  logs: tail -f .dev.log   ·   stop: npm run stop"
echo "If input still fails inside weston, the Ubuntu-on-Xorg session is the fallback."
