import { useEffect, useState } from 'react';

/**
 * Live count of active shell/PTY processes.
 *
 * "Active shell" = any live PtySession in the main-process PtyManager: one per
 * spawned agent for their lifetime, plus any extra background/worktree terminals.
 * The count is 0 when the hive has no open terminals (no agents running yet).
 *
 * Updated immediately on spawn/exit via `fleet:shells` push, and refreshed every
 * 8 seconds by the always-on fleet beat. Backfilled from a cold-start snapshot
 * on mount so the display is never stale after reload.
 *
 * Usage in StatusBar (or any component):
 *   const shells = useActiveShells();
 *   // shells === null until the first value arrives (show nothing or "--")
 *   // shells === 0  when no terminals are open
 *   // shells > 0    at least one PTY is live
 */
export function useActiveShells(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.shellsSnapshot?.().then((s) => {
      if (alive) setCount(s.activeShells);
    }).catch(() => { /* best-effort cold-start */ });

    const unsub = window.cth.onActiveShells?.((payload) => {
      if (alive) setCount(payload.activeShells);
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  return count;
}
