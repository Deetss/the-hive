import { BrowserWindow, Notification, type NotificationConstructorOptions } from 'electron';

/** Bring a window to the foreground and focus it. Prefers the passed window
 *  (the tracked main window), falling back to the first live window. On Windows
 *  a background app is raised unreliably by focus() alone, so toggle alwaysOnTop
 *  to force it forward, then drop it back. */
export function focusMainWindow(win?: BrowserWindow | null): void {
  const target = (win && !win.isDestroyed())
    ? win
    : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.setAlwaysOnTop(true);
  target.show();
  target.setAlwaysOnTop(false);
  target.focus();
}

/** Create a native toast whose click focuses the app window, then show it.
 *  Callers keep their own `notifications` setting gate and isSupported() check. */
export function showFocusNotification(
  options: NotificationConstructorOptions,
  win?: BrowserWindow | null
): void {
  const notification = new Notification(options);
  notification.on('click', () => focusMainWindow(win));
  notification.show();
}
