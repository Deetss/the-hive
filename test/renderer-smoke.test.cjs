'use strict';
/**
 * Renderer smoke test. Self-contained, no test framework beyond `node --test`
 * (mirrors the rest of test/*.test.cjs — this project deliberately ships no
 * vitest/jest/playwright). Run it with `npm run test:smoke`.
 *
 * What it does: bundles a key renderer panel from TSX with the bundled esbuild
 * (a transitive dep, same trick the .cjs suite uses with `typescript`), then
 * server-renders it with `react-dom/server` against a hand-rolled DOM +
 * `window.cth` stub — no jsdom, no @testing-library. It asserts two things a
 * worker's renderer change must not break:
 *   1. the panel and its whole import graph still BUNDLE (catches bad imports,
 *      renamed exports, type-only mistakes that survive tsc but not a bundle),
 *   2. the panel RENDERS to non-empty markup without throwing during the render
 *      phase (catches a null-deref in a component body, a bad hook call, a
 *      missing provider).
 *
 * It is a smoke test, not a UI test: effects don't run under SSR, so this
 * verifies "the screen mounts", not "the screen behaves". Workers should still
 * click through the real app for behavior — this is the cheap pre-`done` check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[renderer-smoke] esbuild not resolvable — skipping (run `npm ci`).');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

// ── DOM / Electron globals (no jsdom) ──────────────────────────────────────────
function installDomStub() {
  const noop = () => {};
  const makeEl = () => ({
    style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false,
    appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c, replaceChild: (c) => c,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, remove: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => null, focus: noop, blur: noop, click: noop, scrollIntoView: noop, scrollTo: noop,
    children: [], childNodes: [], firstChild: null, lastChild: null, parentNode: null, nextSibling: null,
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0,
    innerHTML: '', outerHTML: '', textContent: '', value: '', checked: false,
    ownerDocument: null, nodeType: 1, cloneNode() { return makeEl(); }
  });
  const documentStub = {
    nodeType: 9,
    createElement: makeEl, createElementNS: makeEl,
    createTextNode: (t) => ({ textContent: String(t), nodeType: 3 }),
    createDocumentFragment: makeEl, createComment: () => ({ nodeType: 8 }),
    getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    documentElement: makeEl(), head: makeEl(), body: makeEl(),
    fonts: { add: noop, delete: noop, ready: Promise.resolve() },
    cookie: '', title: '', visibilityState: 'visible', hidden: false, readyState: 'complete',
    activeElement: null
  };
  const bag = new Map();
  const storage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    clear: () => bag.clear(),
    key: (i) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; }
  };
  const win = global.window || {};
  Object.assign(win, {
    document: documentStub, localStorage: storage, sessionStorage: storage,
    navigator: {
      userAgent: 'node-smoke', platform: 'test', language: 'en-US', languages: ['en-US'],
      clipboard: { writeText: async () => {}, readText: async () => '' },
      mediaDevices: { getUserMedia: async () => ({}) }, onLine: true
    },
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '', pathname: '/', search: '', hash: '', assign: noop, replace: noop, reload: noop },
    history: { pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop, length: 1, state: null },
    matchMedia: () => ({ matches: false, media: '', onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => true }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: false }), 0), cancelIdleCallback: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, screen: { width: 1280, height: 800 },
    scrollTo: noop, scrollBy: noop, alert: noop, confirm: () => true, prompt: () => null,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    performance: global.performance ?? { now: () => Date.now() },
    crypto: global.crypto ?? { getRandomValues: (a) => a, randomUUID: () => '00000000-0000-4000-8000-000000000000' }
  });
  documentStub.defaultView = win;
  // Node >=21 makes some of these (navigator, performance…) read-only getters on
  // globalThis, so assign defensively: try plain set, fall back to defineProperty,
  // and let a truly locked prop pass (the renderer reads `window.*` anyway).
  const setGlobal = (key, value) => {
    try { global[key] = value; return; } catch { /* getter-only */ }
    try { Object.defineProperty(global, key, { value, configurable: true, writable: true }); } catch { /* locked */ }
  };
  setGlobal('window', win);
  setGlobal('self', win);
  setGlobal('document', documentStub);
  setGlobal('navigator', win.navigator);
  setGlobal('localStorage', storage);
  setGlobal('sessionStorage', storage);
  setGlobal('location', win.location);
  setGlobal('matchMedia', win.matchMedia);
  setGlobal('ResizeObserver', win.ResizeObserver);
  setGlobal('IntersectionObserver', win.IntersectionObserver);
  setGlobal('MutationObserver', win.MutationObserver);
  setGlobal('requestAnimationFrame', win.requestAnimationFrame);
  setGlobal('cancelAnimationFrame', win.cancelAnimationFrame);
  setGlobal('getComputedStyle', win.getComputedStyle);
  setGlobal('HTMLElement', global.HTMLElement ?? class {});
  setGlobal('HTMLCanvasElement', global.HTMLCanvasElement ?? class {});
  setGlobal('Element', global.Element ?? class {});
  setGlobal('Node', global.Node ?? class {});
}

// ── window.cth (preload bridge) stub ──────────────────────────────────────────
// Every renderer call to the main process goes through window.cth. The renderer
// treats `on*` / `subscribe*` as "register a listener, get an unsubscribe fn"
// and `*Sync` as synchronous; everything else is an async IPC call. Model those
// three shapes so a component body that reads a bridge value at render time gets
// something of the right *kind* rather than undefined.
function installCthStub() {
  const unsub = () => () => {};
  const syncNull = () => null;
  const asyncNull = () => Promise.resolve(null);
  global.window.cth = new Proxy(Object.create(null), {
    has: () => true,
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined; // never look thenable
      if (prop.startsWith('on') || prop.startsWith('subscribe')) return unsub;
      if (prop.endsWith('Sync')) return syncNull;
      return asyncNull;
    }
  });
}

// ── esbuild bundle of one renderer entry ──────────────────────────────────────
// Vite understands import suffixes esbuild does not: `foo?worker`, `foo?url`,
// `foo?raw`, `foo?inline`. Resolve them to a tiny inert module so a panel that
// pulls in a web worker (Monaco's language workers) or an asset URL still
// bundles for the smoke.
const viteSuffixPlugin = {
  name: 'vite-import-suffixes',
  setup(build) {
    const RE = /(\?|&)(worker|worker&inline|sharedworker|url|raw|inline)(&|$)/;
    build.onResolve({ filter: /\?/ }, (args) => {
      if (!RE.test(args.path)) return null;
      return { path: args.path, namespace: 'vite-suffix' };
    });
    build.onLoad({ filter: /.*/, namespace: 'vite-suffix' }, () => ({
      contents: 'class InertWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }\nexport default InertWorker;\nexport const __inert = "";',
      loader: 'js'
    }));
  }
};

const buildCache = new Map();
async function buildBundle(entryRel) {
  if (buildCache.has(entryRel)) return buildCache.get(entryRel);
  const result = await esbuild.build({
    entryPoints: [R(entryRel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18',
    jsx: 'automatic', logLevel: 'silent', sourcemap: false, treeShaking: true,
    plugins: [viteSuffixPlugin],
    // React comes from the test's own node_modules so there is one instance.
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom/server'],
    alias: {
      '@': R('src/renderer/src'),
      '@renderer': R('src/renderer/src'),
      '@shared': R('src/shared')
    },
    loader: {
      '.css': 'empty', '.scss': 'empty',
      '.png': 'empty', '.jpg': 'empty', '.jpeg': 'empty', '.gif': 'empty', '.svg': 'empty', '.webp': 'empty', '.avif': 'empty',
      '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty',
      '.mp3': 'empty', '.wav': 'empty', '.ogg': 'empty', '.mp4': 'empty',
      '.glsl': 'text', '.frag': 'text', '.vert': 'text'
    },
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': '"test"',
      'import.meta.env.BASE_URL': '"/"',
      'import.meta.env.VITE_DEV': 'false',
      'process.env.NODE_ENV': '"test"'
    }
  });
  const code = result.outputFiles[0].text;
  buildCache.set(entryRel, code);
  return code;
}

// Evaluate a built bundle into a live module. Separate from buildBundle so a
// panel whose STATIC graph is fine but whose LOAD touches browser-only globals
// (Monaco, xterm, the OpenAI realtime SDK's UA sniff) still gets its bundle
// checked even when we skip the render.
const moduleCache = new Map();
async function loadModule(entryRel) {
  if (moduleCache.has(entryRel)) return moduleCache.get(entryRel);
  const code = await buildBundle(entryRel);
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', 'globalThis', code)(mod, mod.exports, require, globalThis);
  moduleCache.set(entryRel, mod.exports);
  return mod.exports;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const agentFixture = {
  id: 'smoke-agent', name: 'Smoke', character: 'michael', accent: 'lemon',
  status: 'idle', role: 'worker', provider: 'claude', isOvermind: false,
  ptyId: null, cwd: '/tmp/smoke', tokens: 0, action: '', progress: 0
};
const configFixture = {
  harnessHome: '/tmp/smoke-harness', missions: [],
  telemetryEnabled: false, autoUpdate: false, skipHarnessPickerOnLaunch: true,
  slackEnabled: false, slackProactivePosting: false, freeflowEnabled: false
};

// Panels named by the dispatch, plus a couple of leaf components as green
// anchors so a total-bundle failure is obviously distinct from a panel-only one.
//
// `render: false` — the panel's static import graph is checked (bundles), but it
// is not server-rendered: its LOAD pulls in a browser-only subsystem a no-jsdom
// stub can't satisfy (SettingsModal → OpenAI realtime SDK UA sniff;
// CommandCenterPanel → Monaco + xterm reaching for the DOM at import). Bundling
// alone still catches the mistakes a worker actually makes — a bad import, a
// renamed/removed export, a type error that slips past tsc. Full render coverage
// for these is a follow-up (add jsdom, or an electron-vite preview + Playwright).
const TARGETS = [
  { name: 'PixelBadge', entry: 'src/renderer/src/components/PixelBadge.tsx', export: 'PixelBadge', props: { status: 'compacting' }, render: true },
  { name: 'PixelButton', entry: 'src/renderer/src/components/PixelButton.tsx', export: 'PixelButton', props: { children: 'ok' }, render: true },
  { name: 'AgentRosterItem', entry: 'src/renderer/src/components/AgentRosterItem.tsx', export: 'AgentRosterItem', props: { agent: agentFixture, variant: 'card' }, render: true },
  { name: 'AgentCard', entry: 'src/renderer/src/components/AgentCard.tsx', export: 'AgentCard', props: { name: 'Smoke', character: 'michael', accent: 'lemon', status: 'idle', project: 'TheHive' }, render: true },
  { name: 'RosterList', entry: 'src/renderer/src/components/RosterList.tsx', export: 'RosterList', props: { agents: [agentFixture] }, render: true },
  { name: 'TasksKanban', entry: 'src/renderer/src/components/TasksKanban.tsx', export: 'TasksKanban', props: {}, render: true },
  { name: 'SettingsModal', entry: 'src/renderer/src/components/SettingsModal.tsx', export: 'SettingsModal', props: { config: configFixture, onClose() {} }, render: false },
  { name: 'CommandCenterPanel', entry: 'src/renderer/src/components/CommandCenterPanel.tsx', export: 'CommandCenterPanel', props: { agent: agentFixture }, render: false }
];

installDomStub();
installCthStub();

for (const t of TARGETS) {
  test(`renderer-smoke: ${t.name} bundles cleanly`, async () => {
    const code = await buildBundle(t.entry);
    assert.ok(typeof code === 'string' && code.length > 0, `${t.name}: empty bundle`);
  });

  test(`renderer-smoke: ${t.name} server-renders to non-empty markup`, { skip: t.render ? false : 'load pulls in a browser-only subsystem; see TARGETS note' }, async () => {
    const mod = await loadModule(t.entry);
    const Comp = mod[t.export] ?? mod.default;
    assert.ok(typeof Comp === 'function', `${t.name}: expected a component export "${t.export}"`);
    let html;
    try {
      html = renderToStaticMarkup(React.createElement(Comp, t.props));
    } catch (err) {
      assert.fail(`${t.name} threw during render: ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : err}`);
    }
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0, `${t.name} rendered empty markup`);
  });
}
