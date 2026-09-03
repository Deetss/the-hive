import { useEffect, useRef } from 'react';
import { useStore, type Agent } from '@/store/store';
import '@/assets/hive-art.js';
import '@/assets/hive-screens.js';
import '@/assets/hive-mailroom.js';

type BeeStatus = 'idle' | 'thinking' | 'working' | 'moving' | 'blocked' | 'done' | 'handoff';
type ScreenName = 'terminal' | 'app' | 'video' | 'site' | 'chat' | 'code' | 'chart';
type Dir = 'down' | 'up' | 'right' | 'left';
type Costume = 'hardhat' | 'couriercap' | 'headset' | 'labcoat' | 'chefhat' | 'hivis' | 'crown' | 'visor';
type TokenState = 'locked' | 'open' | 'active' | 'done';

interface HiveArtApi {
  rect: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) => void;
  px: (ctx: CanvasRenderingContext2D, x: number, y: number, fill: string) => void;
  drawHex: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, outline: string) => void;
  TILES: Record<string, (ctx: CanvasRenderingContext2D) => void>;
  PROPS: Record<
    string,
    { draw: (ctx: CanvasRenderingContext2D, frame: number, screen?: ScreenName) => void; w: number; h: number; frames: number }
  >;
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

interface MailAgentCfg {
  post: [number, number];
  costume?: Costume;
  approach?: [number, number];
  kind?: 'queen';
}

interface HiveMailroomJobOpts {
  from?: string;
  to?: string;
  label?: string | null;
}

interface HiveMailroomConfig {
  station: { x: number; y: number; w: number; h: number; stand: [number, number] };
  lanes: { mid: number; front: number };
  agents: Record<string, MailAgentCfg>;
  courier: { post: [number, number]; costume?: Costume };
  onPostChange?: (id: string, hidden: boolean, status: BeeStatus | null) => void;
  speedAgent?: number;
  speedCourier?: number;
}

interface HiveMailroomInstance {
  send: (opts: HiveMailroomJobOpts) => boolean;
  busy: () => boolean;
  deliveredTo: () => string | null;
  step: (dt: number) => void;
  drawStation: (ctx: CanvasRenderingContext2D, f: number) => void;
  drawWalkers: (ctx: CanvasRenderingContext2D, f: number, opts?: { chips?: boolean }) => void;
  box: Array<{ from: string; to: string; label: string | null }>;
}

interface HiveMailroomApi {
  create: (cfg: HiveMailroomConfig) => HiveMailroomInstance;
}

function hiveMailroom(): HiveMailroomApi | undefined {
  return (window as unknown as { HiveMailroom?: HiveMailroomApi }).HiveMailroom;
}

const W = 512;
const H = 288;
const SEAT_COLS = [30, 118, 206, 294, 382];
const SEAT_ROWS = [145, 210];
/** Row-2 centre bay (col index 2, row index 1) is reserved for the mail
 *  station — the handoff spec requires a clear desk-sized bay there, so
 *  live agents skip that physical slot when seated. */
const STATION_SEAT_INDEX = 7;
const SEAT_SLOTS: Array<{ col: number; row: number }> = [];
for (let i = 0; i < SEAT_COLS.length * SEAT_ROWS.length; i++) {
  if (i === STATION_SEAT_INDEX) continue;
  SEAT_SLOTS.push({ col: i % SEAT_COLS.length, row: Math.floor(i / SEAT_COLS.length) });
}
const MAX_SEATS = SEAT_SLOTS.length;
const COURIER_SEAT_INDEX = 5;
const COURIER_POST: [number, number] = [SEAT_COLS[0] + 8, SEAT_ROWS[1] + 30];
const QUEEN = { x: 212, y: 112 };
const QUEEN_APPROACH: [number, number] = [208, 146];
/* stand sits outside the station's x-span (208-252): hive-mailroom.js routes both the
 * sender approach and courier delivery legs as a straight vertical line between the mid
 * lane and stand, so a stand.x inside the box makes every leg cut through the mailbox.
 * x=186 gives ~22px of clearance left of station edge so the bee sprite doesn't clip. */
const MAIL_STATION = { x: 208, y: 204, w: 44, h: 26, stand: [186, 248] as [number, number] };
const MAIL_LANES = { mid: 186, front: 266 };
/** The human has no desk to walk an envelope from, so a message they dispatch
 *  flies in from off the right edge instead of running mailroom leg 1. */
const HUMAN_ENVELOPE_FROM: [number, number] = [W + 24, MAIL_STATION.stand[1]];
const HUMAN_ENVELOPE_DURATION = 0.5;
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

function screenForStatus(status: BeeStatus): ScreenName {
  switch (status) {
    case 'working':
      return 'terminal';
    case 'thinking':
      return 'app';
    case 'blocked':
      return 'video';
    case 'done':
    case 'handoff':
    case 'moving':
      return 'chat';
    default:
      return 'site';
  }
}

/** Monitor content pools for the two statuses that hold long enough for a
 *  cycle to read: working desks show productivity apps, idle desks show
 *  downtime content. Other statuses keep the single screenForStatus() shot —
 *  they're too transient to bother cycling. */
const WORK_SCREENS: ScreenName[] = ['terminal', 'code', 'chart'];
const IDLE_SCREENS: ScreenName[] = ['video', 'site', 'chat'];
const SCREEN_CYCLE_SECONDS = 7;

/** screenPhase staggers each seat's cycle start so desks don't flip in unison. */
function screenForSeat(s: Seat, t: number): ScreenName {
  const pool = s.status === 'working' ? WORK_SCREENS : s.status === 'idle' ? IDLE_SCREENS : null;
  if (!pool) return screenForStatus(s.status);
  const idx = Math.floor((t + s.screenPhase) / SCREEN_CYCLE_SECONDS) % pool.length;
  return pool[idx];
}

interface Seat {
  deskX: number;
  deskY: number;
  x: number;
  y: number;
  costume: Costume;
  status: BeeStatus;
  phase: number;
  screenPhase: number;
  hidden?: boolean;
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
  queenHidden: boolean;
  overmindId: string | null;
  mail: HiveMailroomInstance | null;
  mailAgents: Record<string, MailAgentCfg>;
  /** Off-screen envelope flights queued by human dispatches; only the head
   *  entry animates, the rest wait their turn before joining the mailroom
   *  station box for the normal courier leg. */
  humanMail: Array<{ t: number; to: string }>;
  motes: Mote[];
  drips: Array<{ x: number; y: number }>;
  fillStep: number;
  lastFillTick: number;
  lt: number;
  lightShafts: Array<{ grad: CanvasGradient; sx: number; sy: number; sw: number }>;
  vignetteGrad: CanvasGradient;
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

  // Light shaft + vignette gradients are static (fixed geometry every frame) —
  // built once here instead of per-frame to avoid a canvas-gradient
  // allocation on every tick.
  const lightShafts = ([[300, 96, 60], [370, 96, 40]] as Array<[number, number, number]>).map(
    ([sx, sy, sw]) => {
      const grad = fx.createLinearGradient(sx, sy, sx - 40, H);
      grad.addColorStop(0, 'rgba(255,225,140,0.22)');
      grad.addColorStop(1, 'rgba(255,225,140,0)');
      return { grad, sx, sy, sw };
    }
  );
  const vignetteGrad = fx.createRadialGradient(W / 2, 150, 90, W / 2, 150, 330);
  vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vignetteGrad.addColorStop(1, 'rgba(20,12,0,0.45)');

  return {
    bg,
    fc,
    fx,
    seats: [],
    seatOrder: [],
    seatByAgent: new Map(),
    queenStatus: 'idle',
    queenUntil: 0,
    queenHidden: false,
    overmindId: null,
    mail: null,
    mailAgents: {},
    humanMail: [],
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
    lt: 0,
    lightShafts,
    vignetteGrad
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

/** Keeps the mailroom's `agents` map (a stable object the HiveMailroom
 *  instance closes over) in sync with the queen and each seated agent's
 *  real id, so real hive from/to ids resolve to a post position. Mutates
 *  in place rather than rebuilding so a trip already under way keeps its
 *  captured actor reference. */
function syncMailAgents(scene: SceneState, overmind: Agent | undefined): void {
  const desired = new Set<string>();
  if (overmind) {
    desired.add(overmind.id);
    if (!scene.mailAgents[overmind.id]) {
      scene.mailAgents[overmind.id] = {
        post: [QUEEN.x, QUEEN.y],
        costume: 'crown',
        approach: QUEEN_APPROACH,
        kind: 'queen'
      };
    }
  }
  scene.seatByAgent.forEach((seat, id) => {
    desired.add(id);
    const existing = scene.mailAgents[id];
    if (!existing || existing.post[0] !== seat.x || existing.post[1] !== seat.y || existing.costume !== seat.costume) {
      scene.mailAgents[id] = { post: [seat.x, seat.y], costume: seat.costume };
    }
  });
  Object.keys(scene.mailAgents).forEach((id) => {
    if (!desired.has(id)) delete scene.mailAgents[id];
  });
}

function createMailroom(scene: SceneState): HiveMailroomInstance | null {
  const HM = hiveMailroom();
  if (!HM) return null;
  return HM.create({
    station: MAIL_STATION,
    lanes: MAIL_LANES,
    agents: scene.mailAgents,
    courier: { post: COURIER_POST, costume: 'couriercap' },
    onPostChange: (id, hidden, status) => {
      if (id === 'courier') {
        const seat = scene.seats[COURIER_SEAT_INDEX];
        if (seat) seat.hidden = hidden;
        return;
      }
      if (scene.overmindId && id === scene.overmindId) {
        scene.queenHidden = hidden;
        if (status) {
          scene.queenStatus = status;
          scene.queenUntil = 2.4;
        }
        return;
      }
      const seat = scene.seatByAgent.get(id);
      if (!seat) return;
      seat.hidden = hidden;
      if (status) seat.status = status;
    }
  });
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
      const slot = SEAT_SLOTS[i];
      const deskX = SEAT_COLS[slot.col];
      const deskY = SEAT_ROWS[slot.row];
      const prior = scene.seatByAgent.get(id);
      const seat: Seat = {
        deskX,
        deskY,
        x: deskX + 8,
        y: deskY + 30,
        costume: prior?.costume ?? COSTUME_POOL[i % COSTUME_POOL.length],
        status: prior?.status ?? 'idle',
        phase: prior?.phase ?? (i * 3) % 8,
        screenPhase: prior?.screenPhase ?? (i * 2.7) % SCREEN_CYCLE_SECONDS,
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
  // Spec frame (courier walk cycle stays crisp per Dylan: "don't slow the
  // courier when it IS running"). Everything else — bee idle bob, props,
  // board/tokens — runs at ~60% per his live UAT feedback ("animations are a
  // little fast"), a deliberate deviation from the handoff's flat `t*12`.
  const fFast = Math.floor(t * 12);
  const f = Math.floor(fFast * 0.6);

  if (t - scene.lastFillTick > 6) {
    scene.lastFillTick = t;
    scene.fillStep = (scene.fillStep % 8) + 1;
  }
  if (scene.humanMail.length) {
    const head = scene.humanMail[0];
    head.t += dt;
    if (head.t >= HUMAN_ENVELOPE_DURATION) {
      scene.humanMail.shift();
      scene.mail?.box.push({ from: 'human', to: head.to, label: null });
    }
  }
  scene.mail?.step(dt);
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
    const ph = (t * 0.24 + i * 0.37) % 1;
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

  if (!scene.queenHidden) {
    A.drawBee(x, QUEEN.x, QUEEN.y, { status: scene.queenStatus, dir: 'down', frame: f, costume: 'crown' });
    if (scene.queenStatus !== 'idle') A.drawChip(x, QUEEN.x + 1, QUEEN.y - 15, scene.queenStatus);
  }
  if (scene.overmindId && scene.mail?.deliveredTo() === scene.overmindId) {
    A.drawEnvelope(x, QUEEN.x + 16, QUEEN.y + 2, true);
  }

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
    A.PROPS.desk.draw(x, (f + i) % 4, screenForSeat(s, t));
    x.restore();
    const deliveredHere = scene.mail?.deliveredTo() === scene.seatOrder[i];
    if (!s.hidden) {
      A.drawBee(x, s.x, s.y, { status: s.status, dir: 'down', frame: f + s.phase, costume: s.costume });
      A.drawChip(x, s.x + 1, s.y - 15, s.status, s.status === 'blocked' && f % 2 === 0);
    }
    if (deliveredHere) A.drawEnvelope(x, s.x + 16, s.y + 2, true);
  });

  scene.mail?.drawStation(x, f);
  if (scene.humanMail.length) {
    const progress = Math.min(1, scene.humanMail[0].t / HUMAN_ENVELOPE_DURATION);
    const ease = 1 - (1 - progress) * (1 - progress);
    const ex = HUMAN_ENVELOPE_FROM[0] + (MAIL_STATION.stand[0] - HUMAN_ENVELOPE_FROM[0]) * ease;
    const ey = HUMAN_ENVELOPE_FROM[1] + (MAIL_STATION.stand[1] - HUMAN_ENVELOPE_FROM[1]) * ease;
    A.drawEnvelope(x, ex, ey, false);
  }
  scene.mail?.drawWalkers(x, f);

  // Order per spec: mail station + walkers, dust motes, light shafts, vignette.
  for (const m of scene.motes) {
    m.x += m.vx * dt * 0.6;
    m.y += m.vy * dt * 0.6;
    if (m.x > W + 2) {
      // Re-entering at the left edge used to keep the mote's current y, so any
      // mote wrapping while near vat height (y 112-142, x 6-30) "popped in"
      // right beside the vat every time — that's the unexplained floater
      // Dylan saw. Re-roll y along with x so it doesn't always reappear there.
      m.x = -2;
      m.y = 110 + Math.random() * 170;
    }
    if (m.y < 108) {
      m.y = H - 6;
      m.x = Math.random() * W;
    }
    const tw = (Math.sin(t * 2 + m.ph) + 1) / 2;
    x.globalAlpha = 0.25 + tw * 0.55;
    A.px(x, Math.round(m.x), Math.round(m.y), tw > 0.6 ? 'w' : 'p');
    x.globalAlpha = 1;
  }

  x.save();
  x.globalCompositeOperation = 'lighter';
  scene.lightShafts.forEach(({ grad, sx, sy, sw }) => {
    x.fillStyle = grad;
    x.beginPath();
    x.moveTo(sx, sy);
    x.lineTo(sx + sw, sy);
    x.lineTo(sx + sw - 70, H);
    x.lineTo(sx - 70, H);
    x.closePath();
    x.fill();
  });
  x.restore();

  x.fillStyle = scene.vignetteGrad;
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

    // Two-leg mail delivery: the sending agent walks its envelope to the
    // station, the courier routes it to the recipient's seat. Both ids must
    // already be posted in scene.mailAgents (queen + live seats) or the send
    // is silently dropped — mirrors OfficeFloor's posFor() guard for a
    // recipient that isn't on the floor. A "human" sender has no desk to walk
    // from, so it skips leg 1 and flies in from off-screen instead (below),
    // joining the mailroom's station box directly for the normal courier leg.
    const sendMail = (from?: string, to?: string): void => {
      if (!from || !to || from === to) return;
      if (from === 'human') {
        if (!scene.mailAgents[to] || !scene.mail) return;
        scene.humanMail.push({ t: 0, to });
        return;
      }
      if (!scene.mailAgents[from] || !scene.mailAgents[to]) return;
      scene.mail?.send({ from, to });
    };
    const win = window as unknown as { hiveSendMessage?: (opts?: { from?: string; to?: string }) => void };
    const sendMailHook = (opts?: { from?: string; to?: string }): void => sendMail(opts?.from, opts?.to);
    win.hiveSendMessage = sendMailHook;
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { type?: string; from?: string; to?: string } | null;
      if (d && d.type === 'hive:message') sendMail(d.from, d.to);
    };
    const onHandoff = (ev: Event): void => {
      const d = (ev as CustomEvent<{ from?: string; to?: string }>).detail;
      if (d) sendMail(d.from, d.to);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('cth:handoff', onHandoff);
    // Real router traffic and the no-live-hive mock loop both flew envelopes on
    // the old OfficeFloor scene via these two feeds; HiveScene only had the
    // generic postMessage/CustomEvent hooks above, so the courier never ran off
    // actual agent-to-agent messages. Mirror OfficeFloor's wiring.
    const offHiveMessage = window.cth?.onHiveMessage
      ? window.cth.onHiveMessage((e) => {
          for (const target of e.targets) sendMail(e.from, target);
        })
      : undefined;
    window.addEventListener('cth:demo-handoff', onHandoff);

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
      scene.overmindId = overmind?.id ?? null;
      syncSeats(scene, agents);
      syncMailAgents(scene, overmind);
      if (!scene.mail) scene.mail = createMailroom(scene);
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
      window.removeEventListener('cth:demo-handoff', onHandoff);
      offHiveMessage?.();
      if (win.hiveSendMessage === sendMailHook) delete win.hiveSendMessage;
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
