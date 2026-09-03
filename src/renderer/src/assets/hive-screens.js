/* The Hive — monitor screen variants (add-on to hive-art.js).
   Draws inside the desk monitor's 16x7 screen area. Requires HiveArt's rect/px + PAL.
   Load after hive-art.js; it patches HiveArt in place. */
(function () {
  const A = window.HiveArt;
  if (!A || A.SCREENS) return;
  const { rect, px } = A;

  const SCREENS = {
    terminal(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 'k');
      const w = [11, 6, 14, 8, 5, 12];
      for (let i = 0; i < 3; i++) rect(ctx, X + 1, Y + 1 + i * 2, Math.min(w[(i + f) % 6], 13), 1, 'c');
      if (f % 2 === 0) rect(ctx, X + 1 + Math.min(w[(2 + f) % 6], 13), Y + 5, 1, 1, 'G');
    },
    app(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 's');
      rect(ctx, X, Y, 16, 2, 'w'); px(ctx, X + 14, Y, 'S');
      rect(ctx, X, Y + 2, 4, 5, 'S');
      for (let i = 0; i < 3; i++) rect(ctx, X + 5, Y + 3 + i * 2, 10 - i * 2, 1, i === f % 3 ? 'w' : 'v');
    },
    video(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 'k');
      rect(ctx, X, Y + 1, 16, 5, f % 2 ? 'S' : '#3d84ab');
      rect(ctx, X + 6, Y + 2, 1, 3, 'w'); rect(ctx, X + 7, Y + 3, 1, 1, 'w');
      rect(ctx, X + 1, Y + 6, 1 + ((f * 4) % 15), 1, 'r');
    },
    site(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 'w');
      rect(ctx, X, Y, 16, 2, 'S');
      rect(ctx, X + 1, Y + 3, 9, 1, 'v'); rect(ctx, X + 1, Y + 5, 6, 1, 'v');
      rect(ctx, X + 11, Y + 4, 4, 2, f % 2 ? 'H' : 'h');
    },
    chat(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 's');
      rect(ctx, X + 1, Y + 1, 7, 2, 'w');
      if (f % 4 >= 1) rect(ctx, X + 8, Y + 3, 7, 2, 'H');
      if (f % 4 >= 2) rect(ctx, X + 1, Y + 5, 5, 2, 'w');
      if (f % 4 === 0) { px(ctx, X + 9, Y + 4, 'w'); px(ctx, X + 11, Y + 4, 'w'); px(ctx, X + 13, Y + 4, 'w'); }
    },
    code(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 'S');
      rect(ctx, X, Y, 3, 7, '#255b7d');
      const seg = [[1, 8, 'H'], [3, 6, 's'], [2, 9, 'c'], [4, 5, 'u'], [1, 11, 's'], [3, 7, 'H']];
      for (let i = 0; i < 3; i++) {
        const g = seg[(i + f) % 6];
        rect(ctx, X + 3 + g[0], Y + 1 + i * 2, g[1], 1, g[2]);
      }
    },
    chart(ctx, X, Y, f) {
      rect(ctx, X, Y, 16, 7, 'S');
      const hs = [3, 5, 2, 6, 4, 5, 3, 6];
      for (let i = 0; i < 5; i++) {
        const hh = hs[(i + f) % 8];
        rect(ctx, X + 1 + i * 3, Y + 7 - hh, 2, hh, i === f % 5 ? 'H' : 'h');
      }
      rect(ctx, X, Y + 6, 16, 1, 'd');
    }
  };
  const SCREEN_LIST = ['terminal', 'app', 'video', 'site', 'chat', 'code', 'chart'];

  A.SCREENS = SCREENS;
  A.SCREEN_LIST = SCREEN_LIST;

  // desk gains a third arg: draw(ctx, frame, screenName)
  A.PROPS.desk.draw = function (ctx, f, screen) {
    rect(ctx, 3, 1, 20, 11, 'd');
    (SCREENS[screen] || SCREENS.app)(ctx, 5, 3, f);
    if (f === 1) { ctx.globalAlpha = 0.35; rect(ctx, 5, 5, 16, 1, 'w'); ctx.globalAlpha = 1; }
    if (f === 3) { ctx.globalAlpha = 0.22; rect(ctx, 5, 3, 16, 7, 'w'); ctx.globalAlpha = 1; }
    rect(ctx, 12, 12, 4, 2, 'd');
    rect(ctx, 1, 14, 30, 4, 'M'); rect(ctx, 1, 18, 30, 1, 'd');
    rect(ctx, 3, 19, 3, 6, 'm'); rect(ctx, 26, 19, 3, 6, 'm');
    rect(ctx, 8, 19, 12, 3, 'p'); rect(ctx, 8, 19, 12, 1, 'w');
    rect(ctx, 23, 17, 5, 5, 'p'); rect(ctx, 28, 18, 1, 3, 'p');
    const st = [0, -1, -2, -1][f];
    px(ctx, 25, 15 + st, 'w'); px(ctx, 26, 14 + st, 'w');
    rect(ctx, 0, 25, 32, 1, 'n');
  };
})();
