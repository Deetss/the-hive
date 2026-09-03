/* hive-mailroom.js — mail station + courier routing for the Hive scene.
 * Loads AFTER hive-art.js. Framework-agnostic: no DOM, no React, no globals besides window.HiveMailroom.
 *
 *   const mail = HiveMailroom.create({
 *     station: { x: 208, y: 222, w: 44, h: 26, stand: [228, 266] },
 *     lanes:   { mid: 186, front: 266 },
 *     agents: {
 *       queen:  { post: [212, 112], costume: 'crown',  approach: [208, 146], kind: 'queen' },
 *       worker: { post: [126, 175], costume: 'headset' }
 *     },
 *     courier: { post: [38, 240], costume: 'couriercap' },
 *     onPostChange: (id, hidden, status) => { ... }   // hide/show the seated sprite
 *   });
 *
 *   mail.send({ from: 'worker', to: 'queen' });   // ONE run per call; extra calls queue
 *   mail.step(dt);                                 // once per frame, dt in seconds
 *   mail.drawStation(ctx, frame);                  // draw before the walkers
 *   mail.drawWalkers(ctx, frame, { chips: true }); // draw after desks
 *   mail.deliveredTo();                            // 'queen' | 'worker' | null — open envelope at that post
 */
(function () {
  const A = () => window.HiveArt;

  function makeTrip(path, dir) {
    return { path, leg: 0, tt: 0, x: path[0][0], y: path[0][1], dir: dir || 'down', wait: 0 };
  }

  function stepPath(c, dt, speed) {
    const a = c.path[c.leg], b = c.path[c.leg + 1];
    if (!b) return true;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    c.tt += (speed * dt) / len;
    if (c.tt >= 1) { c.tt = 0; c.leg++; c.x = b[0]; c.y = b[1]; return false; }
    c.x = a[0] + dx * c.tt; c.y = a[1] + dy * c.tt;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)
      c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    return false;
  }

  function create(cfg) {
    const st = cfg.station, mid = cfg.lanes.mid, front = cfg.lanes.front;
    const agents = cfg.agents, courier = cfg.courier;
    const onPost = cfg.onPostChange || function () {};
    const speedAgent = cfg.speedAgent || 46, speedCourier = cfg.speedCourier || 50;

    const M = {
      outbox: [],       // jobs whose sender has not walked them over yet
      box: [],          // envelopes sitting in the station, waiting for pickup
      senderTrip: null,
      courierTrip: null
    };

    /* sender post -> station: up out of the seat, along the mid lane, down to the stand */
    function toStation(a) {
      const p = a.post;
      return a.kind === 'queen'
        ? [[p[0], p[1]], [p[0], p[1] + 38], [p[0] - 4, mid], [st.stand[0], mid], st.stand]
        : [[p[0], p[1]], [p[0], mid], [st.stand[0], mid], st.stand];
    }
    /* station -> addressee */
    function toAgent(a) {
      const p = a.approach || [p0(a)[0], p0(a)[1] + 12];
      return [st.stand, [st.stand[0], mid], [p[0], mid], p];
    }
    function p0(a) { return a.post; }

    M.send = function (opts) {
      const o = opts || {};
      const from = agents[o.from] ? o.from : 'worker';
      let to = agents[o.to] ? o.to : null;
      if (!to) to = Object.keys(agents).find((k) => k !== from);
      if (!to || to === from) return false;
      M.outbox.push({ from, to, label: o.label || null });
      return true;
    };

    M.busy = function () { return !!(M.senderTrip || M.courierTrip || M.box.length || M.outbox.length); };

    M.deliveredTo = function () {
      const c = M.courierTrip;
      return c && c.phase === 'hand' && c.job ? c.job.to : null;
    };

    M.step = function (dt) {
      /* ---- leg 1: the sending agent carries its own envelope to the station ---- */
      if (!M.senderTrip && M.outbox.length) {
        const job = M.outbox.shift();
        const a = agents[job.from];
        const trip = makeTrip(toStation(a), 'down');
        trip.job = job; trip.actor = a; trip.phase = 'toBox';
        M.senderTrip = trip;
        onPost(job.from, true, null);
      }
      const s = M.senderTrip;
      if (s) {
        if (s.wait > 0) s.wait -= dt;
        else if (stepPath(s, dt, speedAgent)) {
          if (s.phase === 'toBox') {
            M.box.push(s.job);
            s.phase = 'home'; s.wait = 0.7; s.leg = 0; s.tt = 0; s.dir = 'up';
            s.path = s.path.slice().reverse();
          } else {
            onPost(s.job.from, false, 'working');
            M.senderTrip = null;
          }
        }
      }

      /* ---- leg 2: courier collects from the box and routes by the job's `to` ---- */
      if (!M.courierTrip && M.box.length) {
        const p = courier.post;
        const trip = makeTrip([[p[0], p[1]], [p[0], front], [st.stand[0] - 18, front], st.stand], 'down');
        trip.phase = 'pickup'; trip.job = null;
        M.courierTrip = trip;
        onPost('courier', true, null);
      }
      const c = M.courierTrip;
      if (!c) return;
      if (c.wait > 0) {
        c.wait -= dt;
        if (c.wait <= 0 && c.phase === 'hand') {
          const p = courier.post;
          c.phase = 'home'; c.leg = 0; c.tt = 0; c.job = null;
          c.path = [[c.x, c.y], [c.x, mid], [p[0], mid], [p[0], front], [p[0], p[1]]];
        }
        return;
      }
      if (!stepPath(c, dt, speedCourier)) return;
      if (c.phase === 'pickup') {
        c.job = M.box.shift() || null;
        if (!c.job) { c.phase = 'hand'; c.wait = 0.1; return; }
        c.phase = 'deliver'; c.leg = 0; c.tt = 0; c.wait = 0.5;
        c.path = toAgent(agents[c.job.to]);
      } else if (c.phase === 'deliver') {
        c.phase = 'hand'; c.wait = 1.6; c.dir = 'up';
        onPost(c.job.to, false, 'done');
      } else {
        onPost('courier', false, 'working');
        M.courierTrip = null;
      }
    };

    /* ---------- placeholder art: swap the body of this for the real sprite ---------- */
    M.drawStation = function (ctx, f) {
      const { rect, px, drawHex } = A();
      const bx = st.x, by = st.y, w = st.w, h = st.h;
      rect(ctx, bx - 2, by + h + 2, w + 6, 3, 'rgba(0,0,0,0.35)');
      rect(ctx, bx + 5, by + h, 4, 8, 'd');
      rect(ctx, bx + w - 9, by + h, 4, 8, 'd');
      rect(ctx, bx, by, w, h, 'm');
      rect(ctx, bx, by, w, 3, 'M');
      rect(ctx, bx, by + h - 3, w, 3, 'd');
      rect(ctx, bx, by, 2, h, 'd'); rect(ctx, bx + w - 2, by, 2, h, 'd');
      rect(ctx, bx + 7, by + 7, w - 14, 5, 'd');
      rect(ctx, bx + 7, by + 7, w - 14, 1, 'n');
      for (let i = 0; i < Math.min(3, M.box.length); i++)
        rect(ctx, bx + 8 + i * 2, by + 16 - i, w - 18, 3, i % 2 ? 'p' : 'w');
      drawHex(ctx, bx + w - 14, by + 15, 10, 9, 'h', 'd');
      const up = M.box.length > 0;
      rect(ctx, bx + w + 1, by - (up ? 12 : 0), 2, up ? h - 4 : 10, 'd');
      rect(ctx, bx + w + 3, by - (up ? 11 : 1), 7, 5, up ? 'r' : 'n');
      if (up && f % 8 < 4) px(ctx, bx + w + 9, by - 11, 'w');
    };

    M.drawWalkers = function (ctx, f, opts) {
      const chips = !opts || opts.chips !== false;
      const list = [];
      if (M.senderTrip) list.push({ c: M.senderTrip, costume: M.senderTrip.actor.costume, carry: M.senderTrip.phase === 'toBox' });
      if (M.courierTrip) list.push({ c: M.courierTrip, costume: courier.costume || 'couriercap', carry: M.courierTrip.phase === 'deliver' });
      list.forEach((wk) => {
        const c = wk.c;
        const status = (c.phase === 'hand' || c.wait > 0) ? 'handoff' : 'moving';
        A().drawBee(ctx, Math.round(c.x), Math.round(c.y), { status, dir: c.dir, frame: f, costume: wk.costume });
        if (wk.carry) A().drawEnvelope(ctx, Math.round(c.x) + 3, Math.round(c.y) + 5, false);
        if (chips) A().drawChip(ctx, Math.round(c.x) + 1, Math.round(c.y) - 15, status);
      });
    };

    return M;
  }

  window.HiveMailroom = { create };
})();
