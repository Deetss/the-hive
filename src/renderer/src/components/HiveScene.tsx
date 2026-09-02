import { useEffect, useRef } from 'react';
import { useStore, type Agent } from '@/store/store';
import '@/assets/hive-art.js';

type BeeStatus = 'idle' | 'thinking' | 'working' | 'moving' | 'blocked' | 'done' | 'handoff';
type Dir = 'down' | 'up' | 'right' | 'left';
type Costume = 'hardhat' | 'couriercap' | 'headset' | 'labcoat' | 'chefhat' | 'hivis' | 'crown' | 'visor';
type TokenState = 'locked' | 'open' | 'active' | 'done';

interface HiveArtApi {
  rect: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) => void;
  px: (ctx: CanvasRenderingContext2D, x: number, y: number, fill: string) => void;
  drawHex: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, outline: string) => void;
  TILES: Record<string, (ctx: CanvasRenderingContext2D) => void>;
  PROPS: Record<string, { draw: (ctx: CanvasRenderingContext2D, frame: number) => void; w: number; h: number; frames: number }>;
  drawBee: (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    opt: { status: BeeStatus; dir?: Dir; frame?: number; costume?: Costume }
  ) => void;
  drawChip: (ctx: CanvasRenderingContext2D, x: number, y: number, status: BeeStatus, invert?: boolean) => void;
  drawToken: (ctx: CanvasRenderingContext2D, x: number, y: number, icon: string, state: TokenState, frame: number) => void;
  drawFillBoard: (ctx: CanvasRenderingContext2D, step: number, frame: number) => void;
  drawEnvelope: (ctx: CanvasRenderingContext2D, x: number, y: number, open: boolean) => void;
}

function hiveArt(): HiveArtApi | undefined {
  return (window as unknown as { HiveArt?: HiveArtApi }).HiveArt;
}

const W = 512;
const H = 288;
const SEAT_COLS = [30, 118, 206, 294, 382];
const SEAT_ROWS = [145, 210];
const MAX_SEATS = SEAT_COLS.length * SEAT_ROWS.length;
const COURIER_SEAT_INDEX = 5;
const QUEEN = { x: 212, y: 112 };
const COSTUME_POOL: Costume[] = ['hardhat', 'headset', 'labcoat', 'visor', 'hivis', 'chefhat'];

function mapAgentStatus(status: Agent['status']): BeeStatus {
  switch (status) {
    case 'working':
      return 'working';
    case 'thinking':
    case 'compacting':
    case 'typing':
      return 'thinking';
    case 'waiting':
    case 'blocked':
    case 'prompt':
    case 'looping':
      return 'blocked';
    case 'success':
      return 'done';
    default:
      return 'idle';
  }
}

interface Seat {
  deskX: number;
  deskY: number;
  x: number;
  y: number;
  costume: Costume;
  status: BeeStatus;
  phase: number;
  hidden?: boolean;
}

interface CourierState {
  path: Array<[number, number]>;
  leg: number;
  tt: number;
  x: number;
  y: number;
  dir: Dir;
  phase: 'out' | 'hand' | 'back';
  wait: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ph: number;
}

interface SceneState {
  bg: HTMLCanvasElement;
  fc: HTMLCanvasElement;
  fx: CanvasRenderingContext2D;
  seats: Seat[];
  seatOrder: string[];
  seatByAgent: Map<string, Seat>;
  queenStatus: BeeStatus;
  queenUntil: number;
  courier: CourierState | null;
  lastAutoRun: number;
  motes: Mote[];
  drips: Array<{ x: number; y: number }>;
  fillStep: number;
  lastFillTick: number;
  lt: number;
}

function createScene(): SceneState {
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  const fc = document.createElement('canvas');
  fc.width = W;
  fc.height = H;
  const fx = fc.getContext('2d');
  if (!fx) throw new Error('2D context unavailable for hive scene');
  fx.imageSmoothingEnabled = false;

  return {
    bg,
    fc,
    fx,
    seats: [],
    seatOrder: [],
    seatByAgent: new Map(),
    queenStatus: 'idle',
    queenUntil: 0,
    courier: null,
    lastAutoRun: 0,
    motes: Array.from({ length: 46 }, () => ({
      x: Math.random() * W,
      y: 110 + Math.random() * 170,
      vx: 2 + Math.random() * 5,
      vy: -1 - Math.random() * 3,
      ph: Math.random() * 6
    })),
    drips: [
      { x: 74, y: 62 },
      { x: 206, y: 40 },
      { x: 356, y: 70 },
      { x: 452, y: 52 }
    ],
    fillStep: 3,
    lastFillTick: 0,
    lt: 0
  };
}

function paintBackground(A: HiveArtApi, b: CanvasRenderingContext2D): void {
  const tileFill = (tile: string, x: number, y: number, w: number, h: number): void => {
    const t = document.createElement('canvas');
    t.width = 24;
    t.height = 28;
    const tctx = t.getContext('2d');
    if (!tctx) return;
    A.TILES[tile](tctx);
    b.save();
    b.beginPath();
    b.rect(x, y, w, h);
    b.clip();
    for (let i = x - (x % 24); i < x + w; i += 24) {
      for (let j = y - (y % 28); j < y + h; j += 28) b.drawImage(t, i, j);
    }
    b.restore();
  };

  tileFill('wallCapped', 0, 0, W, 96);
  [0, 118, 236, 354, 472].forEach((x) => tileFill('beam', x, 0, 12, 96));
  A.rect(b, 0, 0, W, 3, 'd');
  tileFill('wood', 0, 96, W, 14);
  A.rect(b, 0, 96, W, 1, 'd');
  A.rect(b, 0, 109, W, 1, 'd');
  tileFill('floor', 0, 110, W, H - 110);
  A.rect(b, 0, H - 4, W, 4, 'd');
  A.rect(b, 0, 110, W, 2, 'rgba(0,0,0,0.25)');
  A.rect(b, 300, 28, 92, 30, 'd');
  A.rect(b, 300, 28, 92, 2, 'm');
  for (let i = 0; i < 3; i++) A.drawBee(b, 306 + i * 24, 36, { status: 'idle', dir: 'down', frame: i * 2 });
  b.globalAlpha = 0.55;
  A.rect(b, 300, 28, 92, 30, '#1a1410');
  b.globalAlpha = 1;
  A.rect(b, 356, 34, 20, 18, 'd');
  b.save();
  b.translate(150, 30);
  A.PROPS.whiteboard.draw(b, 0);
  b.restore();
  b.save();
  b.translate(66, 116);
  A.PROPS.cabinet.draw(b, 0);
  b.restore();
  b.save();
  b.translate(452, 216);
  A.PROPS.cabinet.draw(b, 0);
  b.restore();
  A.rect(b, 186, 118, 68, 4, 'd');
  A.rect(b, 188, 122, 64, 12, 'M');
  A.rect(b, 188, 134, 64, 3, 'd');
  A.rect(b, 192, 132, 4, 8, 'm');
  A.rect(b, 244, 132, 4, 8, 'm');
  for (let i = 0; i < 3; i++) A.drawHex(b, 194 + i * 20, 106, 18, 16, i === 1 ? 'H' : 'h', 'd');
  A.rect(b, 186, 141, 68, 1, 'n');
}

function startCourier(scene: SceneState): void {
  if (scene.courier) return;
  const seat = scene.seats[COURIER_SEAT_INDEX];
  const startX = seat ? seat.x : SEAT_COLS[0] + 8;
  const startY = seat ? seat.y : SEAT_ROWS[1] + 30;
  scene.courier = {
    path: [
      [startX, startY],
      [startX, 186],
      [206, 186],
      [208, 146]
    ],
    leg: 0,
    tt: 0,
    x: startX,
    y: startY,
    dir: 'up',
    phase: 'out',
    wait: 0
  };
  if (seat) seat.hidden = true;
}

function stepCourier(scene: SceneState, dt: number): void {
  const c = scene.courier;
  if (!c) return;
  if (c.phase === 'hand') {
    c.wait -= dt;
    if (c.wait <= 0) {
      c.phase = 'back';
      c.leg = 0;
      c.tt = 0;
      const seat = scene.seats[COURIER_SEAT_INDEX];
      c.path = seat
        ? [
            [208, 146],
            [206, 186],
            [seat.x, 186],
            [seat.x, seat.y]
          ]
        : [
            [208, 146],
            [206, 186]
          ];
    }
    return;
  }
  const speed = 44;
  const a = c.path[c.leg];
  const b = c.path[c.leg + 1];
  if (!b) {
    if (c.phase === 'out') {
      c.phase = 'hand';
      c.wait = 1.5;
      c.dir = 'up';
      scene.queenStatus = 'done';
      scene.queenUntil = 2.4;
    } else {
      const seat = scene.seats[COURIER_SEAT_INDEX];
      if (seat) seat.hidden = false;
      scene.courier = null;
    }
    return;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  c.tt += (speed * dt) / len;
  if (c.tt >= 1) {
    c.tt = 0;
    c.leg += 1;
    c.x = b[0];
    c.y = b[1];
    return;
  }
  c.x = a[0] + dx * c.tt;
  c.y = a[1] + dy * c.tt;
  c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

function syncSeats(scene: SceneState, agents: Agent[]): void {
  const live = agents.filter((a) => !a.isOvermind && !a.isAssistant).slice(0, MAX_SEATS);
  const liveIds = live.map((a) => a.id);
  const changed =
    liveIds.length !== scene.seatOrder.length || liveIds.some((id, i) => id !== scene.seatOrder[i]);

  if (changed) {
    scene.seatOrder = liveIds;
    const nextSeats: Seat[] = [];
    liveIds.forEach((id, i) => {
      const col = i % SEAT_COLS.length;
      const row = Math.floor(i / SEAT_COLS.length);
      const deskX = SEAT_COLS[col];
      const deskY = SEAT_ROWS[row];
      const prior = scene.seatByAgent.get(id);
      const seat: Seat = {
        deskX,
        deskY,
        x: deskX + 8,
        y: deskY + 30,
        costume: prior?.costume ?? COSTUME_POOL[i % COSTUME_POOL.length],
        status: prior?.status ?? 'idle',
        phase: prior?.phase ?? (i * 3) % 8,
        hidden: prior?.hidden && i === COURIER_SEAT_INDEX ? prior.hidden : undefined
      };
      scene.seatByAgent.set(id, seat);
      nextSeats.push(seat);
    });
    const liveIdSet = new Set(liveIds);
    Array.from(scene.seatByAgent.keys()).forEach((id) => {
      if (!liveIdSet.has(id)) scene.seatByAgent.delete(id);
    });
    scene.seats = nextSeats;
  }

  scene.seats.forEach((seat, i) => {
    const agent = live[i];
    if (agent) seat.status = mapAgentStatus(agent.status);
  });
}

function renderFrame(A: HiveArtApi, scene: SceneState, t: number, overmindStatus: BeeStatus): void {
  const x = scene.fx;
  const dt = Math.min(0.05, t - (scene.lt || t));
  scene.lt = t;
  const f = Math.floor(t * 12);

  if (t - scene.lastFillTick > 6) {
    scene.lastFillTick = t;
    scene.fillStep = (scene.fillStep % 8) + 1;
  }
  if (!scene.courier && t - scene.lastAutoRun > 11) {
    scene.lastAutoRun = t;
    startCourier(scene);
  }
  stepCourier(scene, dt);
  if (scene.queenUntil > 0) {
    scene.queenUntil -= dt;
    if (scene.queenUntil <= 0) scene.queenStatus = overmindStatus;
  } else {
    scene.queenStatus = overmindStatus;
  }

  x.clearRect(0, 0, W, H);
  x.drawImage(scene.bg, 0, 0);

  [45, 96, 212, 288, 404, 470].forEach((lx, i) => {
    x.save();
    x.translate(lx, 14);
    A.PROPS.lamp.draw(x, (f + i * 2) % 3);
    x.restore();
  });
  scene.drips.forEach((d, i) => {
    const ph = (t * 0.4 + i * 0.37) % 1;
    if (ph < 0.6) A.rect(x, d.x, d.y, 2, Math.round(2 + ph * 8), 'h');
    else {
      A.rect(x, d.x, d.y + Math.round((ph - 0.6) * 60), 2, 3, 'h');
      A.px(x, d.x, d.y, 'h');
    }
  });

  x.save();
  x.translate(6, 112);
  A.PROPS.vat.draw(x, f % 6);
  x.restore();
  ([
    [250, 116],
    [468, 254],
    [488, 246]
  ] as Array<[number, number]>).forEach((p, i) => {
    x.save();
    x.translate(p[0], p[1]);
    A.PROPS.plant.draw(x, (f + i) % 4);
    x.restore();
  });

  A.drawBee(x, QUEEN.x, QUEEN.y, { status: scene.queenStatus, dir: 'down', frame: f, costume: 'crown' });
  if (scene.queenStatus !== 'idle') A.drawChip(x, QUEEN.x + 1, QUEEN.y - 15, scene.queenStatus);
  if (scene.courier && scene.courier.phase === 'hand') A.drawEnvelope(x, QUEEN.x + 16, QUEEN.y + 2, true);

  x.save();
  x.translate(436, 150);
  A.drawFillBoard(x, scene.fillStep, f);
  x.restore();
  (['dots', 'cog', 'check'] as const).forEach((icon, i) => {
    const state: TokenState = i === 0 ? 'open' : i === 1 ? 'active' : 'done';
    A.drawToken(x, 438 + i * 22, 122, icon, state, f);
  });

  scene.seats.forEach((s, i) => {
    x.save();
    x.translate(s.deskX, s.deskY);
    A.PROPS.desk.draw(x, (f + i) % 4);
    x.restore();
    if (s.hidden) return;
    A.drawBee(x, s.x, s.y, { status: s.status, dir: 'down', frame: f + s.phase, costume: s.costume });
    A.drawChip(x, s.x + 1, s.y - 15, s.status, s.status === 'blocked' && f % 2 === 0);
  });

  if (scene.courier) {
    const c = scene.courier;
    const status: BeeStatus = c.phase === 'hand' ? 'handoff' : 'moving';
    A.drawBee(x, Math.round(c.x), Math.round(c.y), { status, dir: c.dir, frame: f, costume: 'couriercap' });
    if (c.phase !== 'hand') A.drawEnvelope(x, Math.round(c.x) + 3, Math.round(c.y) + 5, false);
    A.drawChip(x, Math.round(c.x) + 1, Math.round(c.y) - 15, status);
  }

  x.save();
  x.globalCompositeOperation = 'lighter';
  ([
    [300, 96, 60],
    [370, 96, 40]
  ] as Array<[number, number, number]>).forEach(([sx, sy, sw]) => {
    const g = x.createLinearGradient(sx, sy, sx - 40, H);
    g.addColorStop(0, 'rgba(255,225,140,0.22)');
    g.addColorStop(1, 'rgba(255,225,140,0)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(sx, sy);
    x.lineTo(sx + sw, sy);
    x.lineTo(sx + sw - 70, H);
    x.lineTo(sx - 70, H);
    x.closePath();
    x.fill();
  });
  x.restore();

  for (const m of scene.motes) {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.x > W + 2) m.x = -2;
    if (m.y < 108) {
      m.y = H - 6;
      m.x = Math.random() * W;
    }
    const tw = (Math.sin(t * 2 + m.ph) + 1) / 2;
    x.globalAlpha = 0.25 + tw * 0.55;
    A.px(x, Math.round(m.x), Math.round(m.y), tw > 0.6 ? 'w' : 'p');
    x.globalAlpha = 1;
  }

  const vg = x.createRadialGradient(W / 2, 150, 90, W / 2, 150, 330);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(20,12,0,0.45)');
  x.fillStyle = vg;
  x.fillRect(0, 0, W, H);
}

export function HiveScene(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let raf = 0;
    let disposed = false;
    let bgReady = false;
    const t0 = performance.now();
    const scene = createScene();

    const displayCtx = canvas.getContext('2d');
    if (displayCtx) displayCtx.imageSmoothingEnabled = false;

    const resize = (): void => {
      const rect = container.getBoundingClientRect();
      const z = Math.max(1, Math.min(4, Math.floor(Math.min(rect.width / W, rect.height / H)) || 1));
      canvas.width = W * z;
      canvas.height = H * z;
      if (displayCtx) displayCtx.imageSmoothingEnabled = false;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const win = window as unknown as { hiveSendMessage?: () => void };
    const hook = (): void => startCourier(scene);
    win.hiveSendMessage = hook;
    const onMessage = (e: MessageEvent): void => {
      if (e.data && (e.data as { type?: string }).type === 'hive:message') hook();
    };
    const onHandoff = (): void => hook();
    window.addEventListener('message', onMessage);
    window.addEventListener('cth:handoff', onHandoff);

    const tick = (now: number): void => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      const A = hiveArt();
      if (!A) return;
      if (!bgReady) {
        const b = scene.bg.getContext('2d');
        if (!b) return;
        b.imageSmoothingEnabled = false;
        paintBackground(A, b);
        bgReady = true;
      }
      const agents = useStore.getState().agents;
      const overmind = agents.find((a) => a.isOvermind);
      syncSeats(scene, agents);
      const t = (now - t0) / 1000;
      renderFrame(A, scene, t, overmind ? mapAgentStatus(overmind.status) : 'idle');
      if (displayCtx) displayCtx.drawImage(scene.fc, 0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('cth:handoff', onHandoff);
      if (win.hiveSendMessage === hook) delete win.hiveSendMessage;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#2a2110',
        overflow: 'hidden'
      }}
    >
      <canvas ref={canvasRef} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
    </div>
  );
}
