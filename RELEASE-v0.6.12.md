# The Hive v0.6.12

## Fix

**browser-bridge.js overwrote window.cth in Electron** (cc9693e) — the file is now copied to out/renderer/ so the HTTP server can serve it to browsers. But that means Electron's own renderer also loads it via the script tag in index.html. In Electron, the preload already defines window.cth via contextBridge; the WS shim was then overwriting it, breaking all IPC and crashing the app. Fix: guard at the top of browser-bridge.js so the shim only installs when window.cth is undefined (browser context). Electron is unaffected.

Also includes 0.6.11 diagnostics: invoke send/receive logging + App.tsx getConfig .catch().

## Artifacts (TheHive/dist/)

- The-Hive-0.6.12-win-x64-setup.exe + .blockmap
- The-Hive-0.6.12-win-x64-portable.exe

## Gate

Dylan installs + confirms Electron app works normally. Then open http://localhost:48003 in Chrome — invoke logging will show in console.
