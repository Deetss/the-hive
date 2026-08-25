#!/usr/bin/env bash
# Build The Hive from source and install it on Ubuntu/Debian as a .deb.
# The Hive is a personal fork with no published releases, so this builds locally
# rather than downloading a prebuilt binary. Idempotent: safe to re-run to upgrade.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

log() { printf '\033[0;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[0;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js not found. Install it first (asdf, nvm, or apt)."
command -v npm  >/dev/null 2>&1 || die "npm not found."

log "Node $(node -v), installing dependencies (native rebuild runs in postinstall)"
npm install

log "Building the app bundle"
npm run build

log "Packaging the .deb (electron-builder)"
# electron-builder bundles its own fpm; a bare Ubuntu still needs these for a deb.
if ! dpkg -s fakeroot >/dev/null 2>&1; then
  log "Installing build prerequisite: fakeroot"
  sudo apt-get update -qq && sudo apt-get install -y fakeroot
fi
npx electron-builder --linux deb

deb="$(ls -t dist/*.deb 2>/dev/null | head -1)"
[ -n "$deb" ] || die "No .deb produced under dist/. Check the electron-builder output above."

log "Installing $deb"
sudo apt-get install -y "$deb"

log "Done. Launch 'The Hive' from your app menu, or run: the-hive"
