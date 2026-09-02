/* The Hive — procedural pixel-art source of truth.
   Every PNG in the kit and every frame in the live scene comes from here.
   Draws at 1:1 pixel scale into a 2D context; scale up with imageSmoothingEnabled=false. */

var HiveArt;
if (!(typeof window !== 'undefined' && window.HiveArt)) {

const PAL = {
  x: '#c9a83c', X: '#a8842a', l: '#ded08c', p: '#f0e6b8',
  d: '#4a3418', m: '#6b4a22', M: '#8d6631',
  h: '#e8a41f', H: '#f7cd4c',
  k: '#2b2115', y: '#f2c027', Y: '#c99a12',
  s: '#8fd0ef', S: '#2f6f96',
  g: '#4f9a3a', G: '#8ed06a',
  u: '#9a86e0', r: '#d1442f', c: '#5bbf5b',
  w: '#ffffff', v: '#cfe0ea',
  o: '#1a1410', n: 'rgba(0,0,0,0.20)'
};

function px(ctx, x, y, c) { if (!c || c === '.') return; ctx.fillStyle = PAL[c] || c; ctx.fillRect(x | 0, y | 0, 1, 1); }
function rect(ctx, x, y, w, h, c) { ctx.fillStyle = PAL[c] || c; ctx.fillRect(x | 0, y | 0, w, h); }
function blit(ctx, ox, oy, rows, y0) {
  y0 = y0 || 0;
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    for (let i = 0; i < r.length; i++) px(ctx, ox + i, oy + y0 + j, r[i]);
  }
}

/* ---------- bee body (16x16 cell, anchor = bottom centre) ---------- */

const BEE = {
  down: [
    '................',
    '.....o....o.....',
    '......o..o......',
    '.....oooooo.....',
    '....okkkkkko....',
    '....okwkkwko....',
    '....okkkkkko....',
    '...ooyyyyyyoo...',
    '...oykkkkkkyo...',
    '...oyyyyyyyyo...',
    '...oykkkkkkyo...',
    '....oyyyyyyo....',
    '....okkkkkko....',
    '.....oyyyyo.....',
    '......oooo......',
    '................'
  ],
  side: [
    '................',
    '.....o....o.....',
    '......o..o......',
    '.....oooooo.....',
    '....okkkkkko....',
    '....okkkwwko....',
    '....okkkkkko....',
    '...ooyyyyyyoo...',
    '...oykkkkkkyo...',
    '...oyyyyyyyyo...',
    '...oykkkkkkyo...',
    '....oyyyyyyo....',
    '....okkkkkko....',
    '.....oyyyyo.....',
    '......oooo......',
    '................'
  ],
  up: [
    '................',
    '.....o....o.....',
    '......o..o......',
    '.....oooooo.....',
    '....okkkkkko....',
    '....okkkkkko....',
    '....okkkkkko....',
    '...ooyyyyyyoo...',
    '...oykkkkkkyo...',
    '...oyyyyyyyyo...',
    '...oykkkkkkyo...',
    '....oyyyyyyo....',
    '....okkkkkko....',
    '.....oyyyyo.....',
    '......oooo......',
    '................'
  ]
};

const WINGS = {
  fold: { y: 8, rows: ['...v........v...', '...v........v...'] },
  mid: { y: 7, rows: ['..ww........ww..', '..www......www..', '...w........w...'] },
  up: { y: 5, rows: ['..w..........w..', '..ww........ww..', '...w........w...'] },
  down: { y: 9, rows: ['..vv........vv..', '..vvv......vvv..', '...v........v...'] },
  blur: { y: 6, rows: ['..v..........v..', '..vv........vv..', '.vvvv......vvvv.', '..vv........vv..', '..v..........v..'] }
};

/* ---------- costume layers (drawn over the body, same 16x16 cell) ---------- */

const COSTUMES = {
  hardhat: { y: 1, rows: ['......HHHH......', '.....HHHHHH.....', '.....HHHHHH.....', '....hhhhhhhh....'] },
  couriercap: { y: 1, rows: ['......SSSS......', '.....SSSSSS.....', '.....SSSSSS.....', '....ssssssss....'] },
  headset: { y: 3, rows: ['....kkkkkkkk....', '...kk......kk...', '...kk......kk...', '...........kk...', '............k...'] },
  labcoat: { y: 7, rows: ['....wwwwwwww....', '................', '....pppppppp....', '................', '....pppppppp....'] },
  chefhat: { y: 0, rows: ['......wwww......', '.....wwwwww.....', '.....wwwwww.....', '.....vwwwwv.....', '....wwwwwwww....'] },
  hivis: { y: 8, rows: ['....hhh..hhh....', '....hpp..pph....', '....hhh..hhh....', '....hpp..pph....'] },
  crown: { y: 1, rows: ['....H.H..H.H....', '....HHHHHHHH....', '.....hhhhhh.....'] },
  visor: { y: 4, rows: ['....GGGGGGGG....', '....gggggggg....'] }
};

const COSTUME_LIST = ['hardhat', 'couriercap', 'headset', 'labcoat', 'chefhat', 'hivis', 'crown', 'visor'];
const COSTUME_LABELS = {
  hardhat: 'hard hat — builder', couriercap: 'courier cap — delivery', headset: 'headset — support',
  labcoat: 'lab coat — research', chefhat: 'chef hat — kitchen', hivis: 'hi-vis — ops',
  crown: 'crown — queen', visor: 'visor — review'
};

/* ---------- status timing ---------- */

const STATUS = {
  idle: { bob: [0, -1, -1, 0, 0, 1, 1, 0], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'fold', L: 1.4 },
  thinking: { bob: [-1, -2, -2, -1, -1, -2, -2, -1], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'mid', L: 1.4 },
  working: { bob: [0, -1, 0, 1, 0, -1, 0, 1], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'blur', L: 1.4 },
  moving: { bob: [0, -1, 0, 0, 0, -1, 0, 0], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'mid', L: 0.7 },
  blocked: { bob: [0, 0, 0, 0, 0, 0, 0, 0], dx: [0, 1, -1, 1, -1, 1, -1, 0], wing: 'fold', L: 0.24 },
  done: { bob: [0, -2, -3, -3, -2, -1, 0, 0], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'up', L: 1.4 },
  handoff: { bob: [0, 0, -1, -1, 0, 0, 0, 0], dx: [0, 0, 0, 0, 0, 0, 0, 0], wing: 'mid', L: 1.4 }
};
const STATUS_LIST = ['idle', 'thinking', 'working', 'moving', 'blocked', 'done', 'handoff'];

const CHIP_ICON = {
  idle: 'dots', thinking: 'cog', working: 'keys', moving: 'arrow',
  blocked: 'bang', done: 'check', handoff: 'drop'
};
const CHIP_TINT = { idle: 'p', thinking: 'u', working: 's', moving: 'c', blocked: 'r', done: 'c', handoff: 'H' };

/* ---------- 8x8 glyphs ---------- */

const GLYPH = {
  dots: ['........', '........', '........', '.o.o.o..', '........', '........', '........', '........'],
  cog: ['..o..o..', '.oooooo.', '.o.oo.o.', 'oooooooo', 'oooooooo', '.o.oo.o.', '.oooooo.', '..o..o..'],
  bang: ['...oo...', '...oo...', '...oo...', '...oo...', '...oo...', '........', '...oo...', '........'],
  check: ['......o.', '.....oo.', '....oo..', 'o..oo...', 'oo.oo...', '.ooo....', '..oo....', '........'],
  drop: ['...oo...', '...oo...', '..oooo..', '..oooo..', '.oooooo.', '.oooooo.', '..oooo..', '........'],
  arrow: ['........', '....o...', '.....o..', 'oooooooo', '.....o..', '....o...', '........', '........'],
  keys: ['........', 'oooooooo', 'o.o.o.oo', 'oooooooo', 'o..oo..o', 'oooooooo', '........', '........'],
  mail: ['........', 'oooooooo', 'oo....oo', 'o.oo.o.o', 'o...o..o', 'oooooooo', '........', '........'],
  star: ['...o....', '...o....', '.o.o.o..', '..ooo...', '.ooooo..', '..ooo...', '.o.o.o..', '...o....']
};

function glyph(ctx, x, y, name, c) {
  const g = GLYPH[name]; if (!g) return;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (g[j][i] === 'o') px(ctx, x + i, y + j, c);
}

/* ---------- hex helper ---------- */

function hexInset(w, h, y) {
  const t = Math.max(1, Math.round(h * 0.22)), half = Math.max(1, Math.floor(w / 4));
  if (y < t) return Math.round(((t - y) / t) * half);
  if (y >= h - t) return Math.round(((y - (h - t) + 1) / t) * half);
  return 0;
}
function drawHex(ctx, x, y, w, h, fill, outline) {
  for (let j = 0; j < h; j++) {
    const ins = hexInset(w, h, j), ww = w - ins * 2;
    if (ww <= 0) continue;
    rect(ctx, x + ins, y + j, ww, 1, fill);
    if (outline) { px(ctx, x + ins, y + j, outline); px(ctx, x + ins + ww - 1, y + j, outline); }
  }
  if (outline) {
    const t = Math.max(1, Math.round(h * 0.22)), half = Math.max(1, Math.floor(w / 4));
    rect(ctx, x + half - 1, y, w - (half - 1) * 2, 1, outline);
    rect(ctx, x + half - 1, y + h - 1, w - (half - 1) * 2, 1, outline);
    void t;
  }
}

/* honeycomb field — pitch 12x14, odd columns offset +7y. Seamless on 24x28 multiples. */
function hexField(ctx, w, h, tones) {
  tones = tones || ['x', 'l', 'X', 'x', 'l', 'x'];
  rect(ctx, 0, 0, w, h, 'X');
  for (let col = -1; col <= Math.ceil(w / 12); col++) {
    for (let row = -1; row <= Math.ceil(h / 14) + 1; row++) {
      const x = col * 12, y = row * 14 + (((col % 2) + 2) % 2) * 7 - 7;
      const hash = (col * 7 + row * 5 + ((col * row) % 3)) % tones.length;
      drawHex(ctx, x, y, 13, 14, tones[(hash + tones.length) % tones.length]);
    }
  }
}

/* ---------- tiles ---------- */

const TILES = {
  floor(ctx) { hexField(ctx, 24, 28, ['x', 'l', 'x', 'l', 'x', 'X']); },
  floorLight(ctx) { hexField(ctx, 24, 28, ['l', 'p', 'l', 'p', 'l', 'x']); },
  wall(ctx) { hexField(ctx, 24, 28, ['X', 'm', 'X', 'd', 'm', 'X']); },
  wallCapped(ctx) {
    hexField(ctx, 24, 28, ['X', 'm', 'X', 'd', 'm', 'X']);
    drawHex(ctx, 0, 14, 12, 14, 'h'); drawHex(ctx, 12, 7, 12, 14, 'H');
  },
  wood(ctx) {
    for (let y = 0; y < 28; y++) rect(ctx, 0, y, 24, 1, y % 7 === 0 ? 'd' : (y % 7 < 3 ? 'M' : 'm'));
    for (let y = 0; y < 28; y += 7) { px(ctx, 5, y + 3, 'd'); px(ctx, 17, y + 5, 'd'); }
  },
  beam(ctx) {
    for (let x = 0; x < 24; x++) rect(ctx, x, 0, 1, 28, x % 6 === 0 ? 'd' : (x % 6 < 3 ? 'm' : 'M'));
  }
};
const TILE_LIST = ['floor', 'floorLight', 'wall', 'wallCapped', 'wood', 'beam'];

/* ---------- props (animated; f = frame index) ---------- */

const PROPS = {
  desk: {
    w: 32, h: 26, frames: 4,
    draw(ctx, f) {
      rect(ctx, 3, 1, 20, 11, 'd');           // monitor shell
      rect(ctx, 5, 3, 16, 7, 'S');
      rect(ctx, 5, 3, 16, 7, f === 2 ? '#3d84ab' : 'S');
      for (let i = 0; i < 3; i++) rect(ctx, 6, 4 + i * 2, 10 - i * 2, 1, 's');
      if (f === 1) rect(ctx, 5, 5, 16, 1, 's');
      if (f === 3) rect(ctx, 5, 8, 16, 1, '#4b95bd');
      rect(ctx, 12, 12, 4, 2, 'd');
      rect(ctx, 1, 14, 30, 4, 'M'); rect(ctx, 1, 18, 30, 1, 'd');
      rect(ctx, 3, 19, 3, 6, 'm'); rect(ctx, 26, 19, 3, 6, 'm');
      rect(ctx, 8, 19, 12, 3, 'p'); rect(ctx, 8, 19, 12, 1, 'w'); // keyboard
      rect(ctx, 23, 17, 5, 5, 'p'); rect(ctx, 28, 18, 1, 3, 'p'); // mug
      const st = [0, -1, -2, -1][f];
      px(ctx, 25, 15 + st, 'w'); px(ctx, 26, 14 + st, 'w');
      rect(ctx, 0, 25, 32, 1, 'n');
    }
  },
  vat: {
    w: 24, h: 30, frames: 6,
    draw(ctx, f) {
      rect(ctx, 2, 2, 20, 16, 'm'); rect(ctx, 2, 2, 20, 2, 'M'); rect(ctx, 2, 17, 20, 2, 'd');
      rect(ctx, 4, 5, 16, 11, 'h'); rect(ctx, 4, 5, 16, 2, 'H');
      rect(ctx, 4, 5 + (f % 3), 16, 1, 'H');
      rect(ctx, 10, 19, 4, 3, 'd');                          // spout
      const dy = [0, 1, 3, 5, 7, 0][f];
      if (f < 5) { rect(ctx, 11, 22 + dy, 2, 2, 'h'); px(ctx, 11, 21 + dy, 'H'); }
      else rect(ctx, 9, 28, 6, 1, 'h');
      rect(ctx, 0, 29, 24, 1, 'n');
    }
  },
  cabinet: {
    w: 14, h: 20, frames: 1,
    draw(ctx) {
      rect(ctx, 1, 1, 12, 18, 'M'); rect(ctx, 1, 1, 12, 1, 'p');
      for (let i = 0; i < 3; i++) { rect(ctx, 2, 3 + i * 5, 10, 4, 'm'); rect(ctx, 6, 5 + i * 5, 3, 1, 'd'); }
      rect(ctx, 0, 19, 14, 1, 'n');
    }
  },
  plant: {
    w: 14, h: 18, frames: 4,
    draw(ctx, f) {
      const sw = [0, 1, 0, -1][f];
      rect(ctx, 4, 12, 6, 5, 'h'); rect(ctx, 3, 11, 8, 2, 'H');
      rect(ctx, 6 + (sw > 0 ? 1 : 0), 6, 2, 6, 'g');
      drawHex(ctx, 2 + sw, 3, 6, 7, 'G'); drawHex(ctx, 7 + sw, 1, 6, 7, 'g');
      drawHex(ctx, 5 - sw, 6, 5, 6, 'G');
      rect(ctx, 0, 17, 14, 1, 'n');
    }
  },
  whiteboard: {
    w: 24, h: 16, frames: 2,
    draw(ctx, f) {
      rect(ctx, 0, 0, 24, 16, 'M'); rect(ctx, 1, 1, 22, 14, 'w');
      for (let i = 0; i < 4; i++) rect(ctx, 3, 3 + i * 3, 14 - i * 2, 1, 'S');
      if (f === 1) rect(ctx, 3, 12, 8, 1, 'r');
    }
  },
  lamp: {
    w: 12, h: 16, frames: 3,
    draw(ctx, f) {
      rect(ctx, 5, 0, 2, 4, 'd');
      const g = [0, 1, 0][f];
      drawHex(ctx, 2 - g, 4 - g, 8 + g * 2, 9 + g * 2, 'H');
      drawHex(ctx, 3, 5, 6, 7, f === 1 ? '#ffe27a' : 'H');
      px(ctx, 6, 13 + g, 'h');
    }
  },
  mug: {
    w: 10, h: 12, frames: 4,
    draw(ctx, f) {
      const st = [0, -1, -2, -1][f];
      px(ctx, 4, 4 + st, 'w'); px(ctx, 5, 3 + st, 'w'); px(ctx, 6, 5 + st, 'v');
      rect(ctx, 2, 6, 6, 5, 'p'); rect(ctx, 2, 6, 6, 1, 'w'); rect(ctx, 3, 7, 4, 1, 'h');
      rect(ctx, 8, 7, 1, 3, 'p');
    }
  }
};
const PROP_LIST = ['desk', 'vat', 'cabinet', 'plant', 'whiteboard', 'lamp', 'mug'];

/* ---------- bee + chip ---------- */

function drawBee(ctx, ox, oy, opt) {
  opt = opt || {};
  const status = opt.status || 'idle', dir = opt.dir || 'down';
  const f = ((opt.frame | 0) % 8 + 8) % 8, sp = STATUS[status] || STATUS.idle;
  const bob = sp.bob[f], dx = sp.dx[f];
  const flip = dir === 'left';
  const art = BEE[dir === 'left' || dir === 'right' ? 'side' : (dir === 'up' ? 'up' : 'down')];

  ctx.save();
  if (flip) { ctx.translate(ox + 16, oy); ctx.scale(-1, 1); ctx.translate(-ox, -oy); }
  const x = ox + dx, y = oy + bob;

  rect(ctx, ox + 4, oy + 14, 8, 1, 'n');
  const wing = WINGS[sp.wing];
  blit(ctx, x, y, wing.rows, wing.y);
  blit(ctx, x, y, art);
  if (opt.costume && COSTUMES[opt.costume]) {
    const cst = COSTUMES[opt.costume];
    blit(ctx, x, y, cst.rows, cst.y);
  }
  ctx.restore();

  if (opt.extras !== false) {
    if (status === 'working' && f % 2 === 0) { px(ctx, ox + 2, oy + 11, 'p'); px(ctx, ox + 13, oy + 12, 'p'); }
    if (status === 'moving') { px(ctx, ox + 3 - (f % 3), oy + 14, 'p'); px(ctx, ox + 12 + (f % 3), oy + 13, 'l'); }
    if (status === 'done') { const s = [[2, 2], [13, 3], [1, 9], [14, 8]]; s.forEach((q, i) => { if ((f + i) % 4 < 2) px(ctx, ox + q[0], oy + q[1], 'w'); }); }
    if (status === 'thinking' && f % 4 < 2) { px(ctx, ox + 11, oy + 1, 'u'); px(ctx, ox + 13, oy - 1, 'u'); }
    if (status === 'handoff') { const t = [0, 1, 2, 3, 4, 4, 3, 2][f]; rect(ctx, ox + 11 + t, oy + 6 - t, 2, 2, 'h'); }
    if (status === 'blocked' && f % 2 === 0) { px(ctx, ox + 1, oy + 4, 'r'); px(ctx, ox + 14, oy + 4, 'r'); }
  }
}

function drawChip(ctx, x, y, status, invert) {
  const tint = CHIP_TINT[status] || 'p';
  const bg = invert ? tint : 'w', fg = invert ? 'w' : tint;
  rect(ctx, x, y, 14, 12, 'o');
  rect(ctx, x + 1, y + 1, 12, 10, bg);
  rect(ctx, x + 6, y + 12, 3, 1, 'o');
  px(ctx, x + 6, y + 12, 'o');
  glyph(ctx, x + 3, y + 2, CHIP_ICON[status], fg);
}

/* ---------- hex task tokens (20x22) ---------- */

const TOKEN_STATES = {
  locked: { fill: 'X', ring: 'd', fg: 'm' },
  open: { fill: 'l', ring: 'm', fg: 'd' },
  active: { fill: 'h', ring: 'd', fg: 'o' },
  done: { fill: 'c', ring: 'd', fg: 'w' }
};
const TOKEN_ICONS = ['dots', 'cog', 'bang', 'check', 'drop', 'arrow', 'mail', 'star'];

function drawToken(ctx, x, y, icon, state, f) {
  const st = TOKEN_STATES[state] || TOKEN_STATES.open;
  drawHex(ctx, x, y, 20, 22, st.fill, st.ring);
  if (state === 'active') {
    drawHex(ctx, x + 2, y + 2, 16, 18, (f | 0) % 4 < 2 ? 'H' : 'h');
  }
  if (state === 'done') drawHex(ctx, x + 2, y + 2, 16, 18, 'c');
  glyph(ctx, x + 6, y + 7, icon, st.fg);
  if (state === 'locked') { rect(ctx, x + 8, y + 9, 4, 4, 'd'); rect(ctx, x + 9, y + 6, 2, 3, 'd'); }
}

/* ---------- 8-step honey fill board (56x40) ---------- */

function drawFillBoard(ctx, step, f) {
  const W = 56, H = 40;
  for (let i = 0; i < W; i += 4) { rect(ctx, i, 0, 2, 1, 'd'); rect(ctx, i, 31, 2, 1, 'd'); }
  for (let j = 0; j < 32; j += 4) { rect(ctx, 0, j, 1, 2, 'd'); rect(ctx, W - 1, j, 1, 2, 'd'); }
  const slots = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) slots.push([3 + c * 17, 3 + r * 14]);
  const perSlot = 8 / 6;
  slots.forEach((s, i) => {
    const fillAmt = Math.max(0, Math.min(1, (step - i * perSlot) / perSlot));
    drawHex(ctx, s[0], s[1], 16, 13, 'l', 'm');
    if (fillAmt > 0) {
      const hh = Math.round(11 * fillAmt);
      for (let j = 0; j < hh; j++) {
        const yy = s[1] + 12 - j, ins = hexInset(16, 13, 12 - j);
        rect(ctx, s[0] + ins + 1, yy, 16 - ins * 2 - 2, 1, j === hh - 1 ? 'H' : 'h');
      }
      if (fillAmt === 1 && ((f | 0) + i) % 6 === 0) px(ctx, s[0] + 8, s[1] + 1, 'H');
    }
  });
  for (let i = 0; i < 8; i++) rect(ctx, 2 + i * 7, 34, 5, 4, i < step ? 'h' : 'd');
  return { w: W, h: H };
}

/* ---------- envelope + honey token props ---------- */

function drawEnvelope(ctx, x, y, open) {
  rect(ctx, x, y, 12, 9, 'o'); rect(ctx, x + 1, y + 1, 10, 7, 'w');
  if (open) { rect(ctx, x + 1, y + 1, 10, 3, 'r'); px(ctx, x + 5, y + 4, 'r'); px(ctx, x + 6, y + 4, 'r'); }
  else { for (let i = 0; i < 5; i++) { px(ctx, x + 1 + i, y + 1 + i, 'S'); px(ctx, x + 10 - i, y + 1 + i, 'S'); } }
}

HiveArt = {
  PAL, px, rect, blit, glyph, drawHex, hexField, TILES, TILE_LIST, PROPS, PROP_LIST,
  BEE, WINGS, COSTUMES, COSTUME_LIST, COSTUME_LABELS, STATUS, STATUS_LIST, CHIP_ICON, CHIP_TINT,
  drawBee, drawChip, drawToken, TOKEN_STATES, TOKEN_ICONS, drawFillBoard, drawEnvelope, GLYPH
};

if (typeof window !== 'undefined') window.HiveArt = HiveArt;

} else { HiveArt = window.HiveArt; }
