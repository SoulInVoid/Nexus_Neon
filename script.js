'use strict';
/* ============ NEXUS ============
   Graph model: every cell is a node with a 4-bit arm mask (N=1,E=2,S=4,W=8).
   Two neighbours are linked only if BOTH have an arm facing each other.
   Energy = breadth-first search from the source over those links. */

const $ = id => document.getElementById(id);
const KEY = 'nexus.v1', MODES = ['campaign', 'endless', 'timeattack', 'zen', 'daily', 'sandbox'];
const MODE_NAMES = { campaign: 'Campaign', endless: 'Endless', timeattack: 'Time Attack', zen: 'Zen', daily: 'Daily', sandbox: 'Sandbox' };
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const rot = m => ((m << 1) | (m >> 3)) & 15;

/* [w, h, minPath, tees, gates, blockChance, moveSlack|null, tutorial] */
const LEVELS = [
  [3, 3, 5, 0, 0, .1, null, 'Click a pipe to rotate it. Link the green source to the ring, then press START FLOW.'],
  [4, 3, 6, 0, 0, .1, null], [4, 4, 8, 0, 0, .15, null],
  [4, 4, 7, 1, 0, .15, null, 'Tee nodes split energy. Every ring must receive it.'],
  [5, 4, 9, 1, 0, .2, null],
  [5, 4, 9, 0, 1, .15, null, 'Gates open (green) and close (red) on a timer. Start the flow while they are open.'],
  [5, 5, 11, 1, 1, .2, null],
  [5, 5, 10, 0, 0, .2, 6, 'Move limit! Each rotation counts, so plan your route.'],
  [5, 5, 12, 1, 0, .2, 5], [6, 5, 13, 2, 0, .2, 5], [6, 5, 12, 1, 1, .25, 4],
  [6, 6, 16, 1, 0, .25, 4], [6, 6, 15, 2, 1, .25, 3], [7, 6, 18, 2, 1, .25, 3], [7, 7, 22, 3, 1, .3, 2]
];

/* ---------- persistence ---------- */
const int = (v, a, b, d) => Number.isInteger(v) && v >= a && v <= b ? v : d;
function normalise(o) {
  const best = {};
  MODES.forEach(m => best[m] = int(o.best && o.best[m], 0, 1e9, 0));
  return {
    theme: o.theme === 'light' ? 'light' : 'dark', sound: o.sound === true, preview: o.preview !== false, motion: o.motion === true,
    unlocked: int(o.unlocked, 1, 15, 1), best, ach: o.ach && typeof o.ach === 'object' ? o.ach : {},
    mode: MODES.includes(o.mode) ? o.mode : 'campaign', lvl: int(o.lvl, 1, 15, 1),
    daily: o.daily && typeof o.daily.date === 'string' ? { date: o.daily.date } : { date: '' }
  };
}
function load() { try { return normalise(JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { return normalise({}); } }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) { /* storage unavailable */ } };
let save = load();

/* ---------- sound (off until the player enables it) ---------- */
let ac = null;
function tone(f, d = .12, type = 'sine', v = .06, delay = 0) {
  if (!save.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + delay;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d + .02);
  } catch (e) { /* audio unsupported */ }
}
const sfx = {
  pick: () => tone(520, .08, 'triangle'), turn: () => tone(340, .07, 'square', .03),
  flow: d => tone(400 + d * 60, .1, 'sine', .04), err: () => tone(130, .25, 'sawtooth', .05),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .25, 'triangle', .06, i * .09))
};

/* ---------- seeded random + level generation ---------- */
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };

function findPath(w, h, minLen, r) {
  const ey = Math.floor(r() * h), sy = Math.floor(r() * h);
  for (let attempt = 0; attempt < 40; attempt++) {
    const want = attempt < 25 ? minLen : 0, seen = new Set([sy * w]), path = [[0, sy]]; let steps = 0;
    const dfs = (x, y) => {
      if (steps++ > 5000) return false;
      if (x === w - 1 && y === ey) return path.length >= want;
      for (const d of shuffle([0, 1, 2, 3], r)) {
        const nx = x + DX[d], ny = y + DY[d], k = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(k)) continue;
        seen.add(k); path.push([nx, ny]);
        if (dfs(nx, ny)) return true;
        path.pop(); seen.delete(k);
      }
      return false;
    };
    if (dfs(0, sy)) return path;
  }
  return Array.from({ length: w }, (_, x) => [x, 0]); // guaranteed straight fallback
}

function generate(p, r) {
  const [w, h, minLen, tees, gates, blockP, slack] = p;
  const path = findPath(w, h, minLen, r), cells = Array.from({ length: w * h }, () => ({ t: 'emp', m: 0, rot: false, need: false, gate: false, sol: 0 }));
  const idx = ([x, y]) => y * w + x, dirTo = (a, b) => DX.indexOf(b[0] - a[0]) !== -1 && b[0] !== a[0] ? (b[0] > a[0] ? 1 : 3) : (b[1] > a[1] ? 2 : 0);
  path.forEach((pt, i) => {
    const c = cells[idx(pt)], toNext = i < path.length - 1 ? 1 << dirTo(pt, path[i + 1]) : 0, toPrev = i > 0 ? 1 << dirTo(pt, path[i - 1]) : 0;
    c.m = toNext | toPrev;
    if (i === 0) c.t = 'src'; else if (i === path.length - 1) c.t = 'dst'; else { c.t = 'pipe'; c.rot = true; c.need = true; }
  });
  const mids = shuffle(path.slice(1, -1).map(idx), r);
  let made = 0;
  for (const i of mids) {
    if (made >= tees) break;
    const x = i % w, y = Math.floor(i / w);
    for (const d of shuffle([0, 1, 2, 3], r)) {
      const nx = x + DX[d], ny = y + DY[d], n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[n].t !== 'emp') continue;
      cells[n].t = 'dst'; cells[n].m = 1 << ((d + 2) % 4);
      cells[i].t = 'tee'; cells[i].m |= 1 << d; made++; break;
    }
  }
  mids.filter(i => cells[i].t === 'pipe').slice(0, gates).forEach(i => cells[i].gate = true);
  cells.forEach(c => {
    if (c.t !== 'emp') return;
    const v = r();
    if (v < blockP) c.t = 'blk';
    else if (v < .65) { c.t = 'pipe'; c.rot = true; c.m = [5, 10, 3, 6, 12, 9][Math.floor(r() * 6)]; }
  });
  cells.forEach(c => c.sol = c.m);
  cells.forEach(c => { if (c.rot) for (let k = Math.floor(r() * 4); k > 0; k--) c.m = rot(c.m); });
  let opt = optimal(cells);
  if (opt === 0) { const c = cells.find(c => c.need); c.m = rot(c.m); opt = optimal(cells); }
  return { w, h, cells, opt, limit: slack == null ? null : opt + slack };
}
function optimal(cells) {
  return cells.reduce((s, c) => { if (!c.need) return s; let m = c.m, k = 0; while (m !== c.sol && k < 4) { m = rot(m); k++; } return s + k; }, 0);
}

/* ---------- game state ---------- */
let G = null, timers = [], gateTimer = 0, clockTimer = 0, gateOpen = true;
const gatesTick = () => G && !['zen', 'sandbox'].includes(G.mode);

function cleanup() { timers.forEach(clearTimeout); timers = []; clearInterval(gateTimer); clearInterval(clockTimer); }
const later = (fn, ms) => timers.push(setTimeout(fn, ms));

function toast(msg) {
  const el = document.createElement('p'); el.className = 'toast'; el.textContent = msg; $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}
function achieve(id, name) { if (!save.ach[id]) { save.ach[id] = 1; persist(); toast('🏆 ' + name); } }
const today = () => new Date().toISOString().slice(0, 10);
const hash = s => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7);

function setup(mode, lvl, keepRun) {
  cleanup();
  const prev = G, n = lvl || 1;
  let p, seed;
  if (mode === 'campaign') { p = LEVELS[n - 1]; seed = n * 7919 + 13; }
  else if (mode === 'daily') { p = [5, 5, 11, 1, 1, .2, 4, 'Same puzzle for everyone today. Solve it once for bonus points.']; seed = hash(today()); }
  else if (mode === 'sandbox') { p = [6, 5, 10, 2, 0, .2, null, 'Sandbox: experiment freely. No score, no limits. Press the mode button for a new network.']; seed = Math.floor(Math.random() * 1e9); }
  else { // endless, timeattack, zen scale with n
    p = [Math.min(4 + Math.floor(n / 3), 7), Math.min(3 + Math.floor(n / 3), 6), Math.min(5 + n * 1.5, 20), Math.min(Math.floor(n / 2), 3), n > 4 ? 1 : 0, .2,
      mode === 'endless' && n > 2 ? Math.max(2, 7 - Math.floor(n / 3)) : null];
    seed = Math.floor(Math.random() * 1e9);
  }
  const lvlData = generate(p, rng(seed));
  G = Object.assign(lvlData, {
    mode, n, tip: p[7] || '', phase: 'idle', paused: false, over: false, awarded: false, undo: [], moves: 0, used: false, sel: -1, hint: -1, lit: new Set(),
    init: lvlData.cells.map(c => c.m), score: keepRun && prev ? prev.score : 0, combo: keepRun && prev ? prev.combo : 1,
    timeLeft: keepRun && prev && prev.timeLeft > 0 ? prev.timeLeft : 90
  });
  gateOpen = true;
  const svg = $('board'); svg.setAttribute('viewBox', `0 0 ${G.w * 64} ${G.h * 64}`);
  svg.classList.remove('win'); svg.classList.add('fade'); setTimeout(() => svg.classList.remove('fade'), 450);
  if (gatesTick()) gateTimer = setInterval(() => { if (!G.paused && !G.over) { gateOpen = !gateOpen; if (G.phase === 'idle') render(); } }, 2500);
  if (mode === 'timeattack') clockTimer = setInterval(() => {
    if (G.paused || G.over) return;
    G.timeLeft--; if (G.timeLeft <= 0) endRun(); hud();
  }, 1000);
  if (mode === 'campaign') { save.lvl = n; }
  save.mode = mode; persist(); render(); hud();
}

function endRun() {
  G.over = true; G.timeLeft = 0; cleanup();
  if (G.score > save.best.timeattack) { save.best.timeattack = G.score; persist(); }
  toast(`Time's up! Final score ${G.score}`); sfx.err();
}

/* ---------- graph traversal ---------- */
function reach() {
  const { w, h, cells } = G, seen = new Map(), src = cells.findIndex(c => c.t === 'src');
  seen.set(src, 0); const q = [src];
  const open = !gatesTick() || gateOpen;
  while (q.length) {
    const i = q.shift(), x = i % w, y = Math.floor(i / w);
    for (let d = 0; d < 4; d++) {
      if (!(cells[i].m & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx, c = cells[n];
      if (seen.has(n) || c.t === 'blk' || !(c.m & (1 << ((d + 2) % 4))) || (c.gate && !open)) continue;
      seen.set(n, seen.get(i) + 1); q.push(n);
    }
  }
  return seen;
}
const solved = () => { const r = reach(); return G.cells.every((c, i) => c.t !== 'dst' || r.has(i)); };

/* ---------- rendering ---------- */
function render() {
  const svg = $('board'), S = 64, { w, cells } = G;
  const focused = svg.contains(document.activeElement) ? document.activeElement.dataset.i : null;
  const r = save.preview && G.phase === 'idle' ? reach() : null;
  let s = '';
  cells.forEach((c, i) => {
    const x = (i % w) * S, y = Math.floor(i / w) * S, cx = x + S / 2, cy = y + S / 2;
    const cls = ['cell', c.t, c.rot ? 'rot' : '', G.lit.has(i) ? 'lit' : '', r && r.has(i) && c.t !== 'src' ? 'pv' : '', G.sel === i ? 'sel' : '', G.hint === i ? 'hint' : '', G.phase === 'idle' ? 'idle' : ''].join(' ');
    let arms = '';
    for (let d = 0; d < 4; d++) if (c.m & (1 << d)) { const e = [[cx, y], [x + S, cy], [cx, y + S], [x, cy]][d]; arms += `<line class="arm" x1="${cx}" y1="${cy}" x2="${e[0]}" y2="${e[1]}"/>`; }
    let hub = '';
    if (c.t === 'blk') hub = `<path class="x" d="M${cx - 10} ${cy - 10}L${cx + 10} ${cy + 10}M${cx + 10} ${cy - 10}L${cx - 10} ${cy + 10}"/>`;
    else if (c.t !== 'emp') hub = `<circle class="hub" cx="${cx}" cy="${cy}" r="${['tee', 'src', 'dst'].includes(c.t) ? 10 : 7}"/>`;
    if (c.gate) hub += `<circle class="gate-ring${gatesTick() && !gateOpen ? ' closed' : ''}" cx="${cx}" cy="${cy}" r="19"/>`;
    const label = `Row ${Math.floor(i / w) + 1}, column ${i % w + 1}: ${{ src: 'source', dst: 'target', tee: 'splitter', pipe: 'pipe', blk: 'blocked', emp: 'empty' }[c.t]}${c.rot ? ', press to rotate' : ''}`;
    s += `<g class="${cls}" data-i="${i}" ${c.rot ? 'tabindex="0" role="button"' : 'role="img"'} aria-label="${label}"><rect x="${x + 2}" y="${y + 2}" width="${S - 4}" height="${S - 4}" rx="10"/>${arms}${hub}</g>`;
  });
  svg.innerHTML = s;
  if (focused != null) { const f = svg.querySelector(`[data-i="${focused}"]`); if (f) f.focus(); }
}

function hud() {
  const m = G.mode;
  $('levelLbl').textContent = m === 'campaign' ? G.n : m === 'daily' ? 'Daily' : m === 'sandbox' ? '∞' : G.n;
  $('score').textContent = G.score; $('moves').textContent = G.moves;
  $('limit').textContent = G.limit != null ? ' / ' + G.limit : '';
  $('best').textContent = save.best[m]; $('combo').textContent = 'x' + G.combo;
  $('time').textContent = m === 'timeattack' ? G.timeLeft + 's' : '–';
  const n = G.cells.filter(c => c.t === 'dst').length;
  $('objective').textContent = (G.tip ? G.tip + ' ' : '') + `Reach ${n === 1 ? 'the target' : 'all ' + n + ' targets'}.`;
  const idle = G.phase === 'idle' && !G.paused && !G.over;
  $('undoBtn').disabled = !idle || !G.undo.length; $('resetBtn').disabled = G.paused || G.phase === 'flowing';
  $('hintBtn').disabled = !idle; $('startBtn').disabled = G.paused || G.over || G.phase === 'flowing';
  $('startBtn').textContent = G.phase === 'won' ? (['campaign', 'endless', 'timeattack', 'zen'].includes(m) ? 'NEXT LEVEL' : 'NEW NETWORK') : 'START FLOW';
  const done = save.unlocked - 1; $('bar').style.width = (done / 15 * 100) + '%'; $('barWrap').setAttribute('aria-valuenow', done);
  $('modes').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === m));
  const pk = $('picker'); pk.hidden = m !== 'campaign';
  if (m === 'campaign') pk.querySelectorAll('button').forEach(b => { const l = +b.textContent; b.disabled = l > save.unlocked; b.toggleAttribute('aria-current', l === G.n); b.setAttribute('aria-current', l === G.n); });
}

/* ---------- actions ---------- */
function rotate(i) {
  if (!G || G.paused || G.over || G.phase !== 'idle') return;
  const c = G.cells[i]; if (!c.rot) { G.sel = i; sfx.pick(); render(); return; }
  if (G.limit != null && G.moves >= G.limit) { toast('Move limit reached. Undo or reset.'); sfx.err(); return; }
  c.m = rot(c.m); G.moves++; G.undo.push(i); G.sel = i; sfx.turn(); render(); hud();
}
function undo() {
  if (G.phase !== 'idle' || G.paused || !G.undo.length) return;
  const i = G.undo.pop(), c = G.cells[i]; c.m = rot(rot(rot(c.m))); G.moves--; sfx.pick(); render(); hud();
}
function reset() {
  if (G.paused || G.phase === 'flowing') return;
  timers.forEach(clearTimeout); timers = [];
  G.cells.forEach((c, i) => c.m = G.init[i]); G.moves = 0; G.undo = []; G.lit = new Set(); G.phase = 'idle'; G.awarded = false; G.hint = -1;
  if (G.mode !== 'sandbox') G.combo = 1;
  sfx.pick(); render(); hud();
}
function hint() {
  if (G.phase !== 'idle' || G.paused) return;
  const i = G.cells.findIndex(c => { if (!c.need) return false; let m = c.m, k = 0; while (m !== c.sol && k < 4) { m = rot(m); k++; } return k > 0; });
  if (i < 0) { toast('Looks right. Try START FLOW.'); return; }
  G.hint = i; G.combo = 1; G.used = true; render(); hud(); later(() => { G.hint = -1; render(); }, 1400);
}

function startFlow() {
  if (G.paused || G.over) return;
  if (G.phase === 'won') return next();
  if (G.phase !== 'idle') return;
  G.phase = 'flowing'; G.hint = -1; G.lit = new Set(); hud();
  const r = reach(), maxD = Math.max(...r.values());
  for (let d = 0; d <= maxD; d++) later(() => { r.forEach((dd, i) => { if (dd === d) G.lit.add(i); }); sfx.flow(d); render(); }, d * 150);
  later(() => (solved() ? succeed() : fail()), (maxD + 1) * 150 + 250);
}
function fail() {
  G.phase = 'idle'; if (G.mode !== 'sandbox') G.combo = 1;
  const svg = $('board'); svg.classList.add('warn'); sfx.err(); toast('Energy did not reach every target.');
  later(() => { svg.classList.remove('warn'); G.lit = new Set(); render(); hud(); }, 700);
}
function succeed() {
  const svg = $('board'); svg.classList.add('win'); sfx.win();
  if (G.mode === 'sandbox') { toast('Network connected!'); G.phase = 'idle'; later(() => { svg.classList.remove('win'); G.lit = new Set(); render(); hud(); }, 900); return; }
  G.phase = 'won';
  if (!G.awarded && solved()) { // validated and guarded against duplicates
    G.awarded = true;
    const dailyDone = G.mode === 'daily' && save.daily.date === today();
    let pts = 100 + G.n * 20 + Math.max(0, G.opt + 3 - G.moves) * 10;
    if (G.mode === 'timeattack') pts += G.timeLeft * 2;
    pts = dailyDone ? 0 : pts * G.combo; G.score += pts;
    if (G.mode === 'daily') { save.daily.date = today(); pts && (G.score += 200); }
    if (G.score > save.best[G.mode]) save.best[G.mode] = G.score;
    if (G.mode === 'campaign') save.unlocked = Math.max(save.unlocked, Math.min(15, G.n + 1));
    persist(); toast(dailyDone ? 'Daily already scored today. Nice practice!' : `+${pts} points`);
    achieve('first', 'First Flow');
    if (G.moves <= G.opt) achieve('perfect', 'Perfect Routing');
    if (G.combo >= 3) achieve('combo3', 'Combo x3');
    if (G.mode === 'campaign' && G.n === 15) achieve('campaign', 'Campaign Complete');
    if (!G.used) G.combo = Math.min(G.combo + 1, 5);
    if (G.mode === 'timeattack') G.timeLeft += 8;
  }
  hud();
}
function next() {
  const m = G.mode;
  if (m === 'campaign') { if (G.n >= 15) { toast('Campaign complete! Try Endless.'); return setup('endless', 1); } return setup(m, G.n + 1, true); }
  if (m === 'daily') { toast('New daily puzzle tomorrow. Replaying for practice.'); return setup('daily', 1); }
  setup(m, G.n + 1, true);
}
function togglePause() {
  if (G.over) return; G.paused = !G.paused;
  $('pauseBtn').setAttribute('aria-pressed', G.paused); $('pauseBtn').textContent = G.paused ? 'Resume' : 'Pause'; $('pauseVeil').hidden = !G.paused; hud();
}

/* ---------- setup UI ---------- */
function applyPrefs() {
  document.documentElement.dataset.theme = save.theme; document.documentElement.classList.toggle('rm', save.motion);
  $('soundBtn').textContent = save.sound ? '🔊' : '🔇'; $('soundBtn').setAttribute('aria-pressed', save.sound); $('soundBtn').setAttribute('aria-label', save.sound ? 'Sound on' : 'Sound off');
  $('optPreview').checked = save.preview; $('optMotion').checked = save.motion;
}
MODES.forEach(m => { const b = document.createElement('button'); b.dataset.m = m; b.textContent = MODE_NAMES[m]; b.addEventListener('click', () => { sfx.pick(); setup(m, m === 'campaign' ? save.lvl : 1); }); $('modes').appendChild(b); });
for (let i = 1; i <= 15; i++) { const b = document.createElement('button'); b.textContent = i; b.setAttribute('aria-label', 'Campaign level ' + i); b.addEventListener('click', () => { if (i <= save.unlocked) setup('campaign', i); }); $('picker').appendChild(b); }
$('board').addEventListener('click', e => { const g = e.target.closest('[data-i]'); if (g) rotate(+g.dataset.i); });
$('board').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const g = e.target.closest('[data-i]'); if (g) { e.preventDefault(); rotate(+g.dataset.i); } } });
$('startBtn').addEventListener('click', startFlow); $('undoBtn').addEventListener('click', undo); $('resetBtn').addEventListener('click', reset);
$('hintBtn').addEventListener('click', hint); $('pauseBtn').addEventListener('click', togglePause);
$('themeBtn').addEventListener('click', () => { save.theme = save.theme === 'dark' ? 'light' : 'dark'; persist(); applyPrefs(); });
$('soundBtn').addEventListener('click', () => { save.sound = !save.sound; persist(); applyPrefs(); sfx.pick(); });
$('settingsBtn').addEventListener('click', () => $('settings').showModal());
$('optPreview').addEventListener('change', e => { save.preview = e.target.checked; persist(); render(); });
$('optMotion').addEventListener('change', e => { save.motion = e.target.checked; persist(); applyPrefs(); });

applyPrefs();
setup(save.mode, save.mode === 'campaign' ? save.lvl : 1);
