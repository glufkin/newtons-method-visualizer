import { Graph, fmtNum } from './graph.js';
import { compileFunction, newton, rootOf } from './newton.js';

/* global katex, renderMathInElement */

const CURVE = '#2d70b3';
const COLORS = ['#c74440', '#388c46', '#6042a6', '#fa7e19', '#000000', '#1f9ea0', '#b5488f'];
const BASIN_COLORS = ['#f2a541', '#4aa3df', '#e377c2', '#2bb3a3', '#d9b500', '#8c6d31', '#7f9cf5', '#b0c400'];
const MAX_ITER = 60;
const ANIM_MS = 750;

export const PRESETS = {
  sqrt2: { label: '√2 — fast convergence', expr: 'x^2 - 2', guesses: [1, -3], view: [-4, 4, -3, 5] },
  cubic: { label: 'Three roots — which one wins?', expr: 'x^3 - x', guesses: [2, 0.5, -0.2], view: [-2.5, 2.5, -2, 2] },
  repeated: { label: 'Repeated root — slow convergence', expr: '(x - 1)^2', guesses: [3], view: [-1, 4, -1, 4] },
  cos: { label: 'Nearly flat tangent — a long jump', expr: 'cos(x)', guesses: [1, 0.1, 0], view: [-4, 13, -3, 3] },
  cycle: { label: 'Stuck in a cycle', expr: 'x^3 - 2x + 2', guesses: [0, -2], view: [-3, 3, -2, 5] },
  cbrt: { label: 'Cube root — diverges', expr: 'cbrt(x)', guesses: [1], view: [-10, 10, -4, 4] },
  atan: { label: 'arctan — overshoots', expr: 'atan(x)', guesses: [1, 1.5], view: [-6, 6, -2.5, 2.5] },
};

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};

const state = {
  expr: '',
  fn: null,
  guesses: [], // {id, x0, color, run}
  shown: 0,
  anim: null, // {start}
  running: false,
  basins: false,
  active: 0,
  hover: null, // {x, y, text}
  dragId: null,
};
let nextId = 1;

// ---------- graph ----------

const graph = new Graph($('#graph'), { onViewChange: () => scheduleBasins() });
graph.overlay = drawOverlay;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const stepsFor = (run) => run.xs.length - 1 + (run.status === 'flat' || run.status === 'undefined' ? 1 : 0);
const maxSteps = () => Math.max(0, ...state.guesses.map((g) => stepsFor(g.run)));
const coord = (x, y) => `(${fmtNum(x)}, ${fmtNum(y)})`;

function drawOverlay(g, ctx) {
  const pts = [];
  if (state.basins) drawBasins(g, ctx);
  if (!state.fn) return;
  const { f, df } = state.fn;
  g.plot(f, CURVE);

  const now = performance.now();
  const animP = state.anim ? clamp01((now - state.anim.start) / ANIM_MS) : 1;

  // draw the active guess last so it sits on top
  const order = state.guesses.filter((q) => q.id !== state.active).concat(state.guesses.filter((q) => q.id === state.active));
  for (const q of order) {
    const { xs, status } = q.run;
    const c = q.color;
    const k = Math.min(state.shown, xs.length - 1);
    for (let i = 1; i <= k; i++) {
      const a = xs[i - 1], fa = f(a), b = xs[i];
      const prog = i === state.shown ? animP : 1;
      const t1 = clamp01(prog / 0.35), t2 = clamp01((prog - 0.35) / 0.65);
      g.segment(a, 0, a, fa * t1, c, 1.5, [5, 5]);
      if (i === k && t1 >= 1) g.line(a, fa, df(a), c, 1.5, 0.35);
      if (t2 > 0) g.segment(a, fa, a + (b - a) * t2, fa * (1 - t2), c, 2.5);
      if (t1 >= 1) { g.point(a, fa, c); pts.push({ x: a, y: fa, text: coord(a, fa) }); }
      if (t2 >= 1) { g.point(b, 0, c, { hollow: true, r: 4 }); pts.push({ x: b, y: 0, text: `x${sub(i)} = ${fmtNum(b, 8)}` }); }
    }
    // failure at the last point: show the horizontal tangent
    if ((status === 'flat' || status === 'undefined') && state.shown >= xs.length) {
      const a = xs[xs.length - 1], fa = f(a);
      const prog = state.shown === xs.length ? animP : 1;
      if (Number.isFinite(fa)) {
        g.segment(a, 0, a, fa * clamp01(prog / 0.35), c, 1.5, [5, 5]);
        if (prog >= 0.35) { g.line(a, fa, 0, c, 2, 0.6); g.point(a, fa, c); }
      }
    }
    const x0 = xs[0];
    const isDrag = state.dragId === q.id;
    g.point(x0, 0, c, { r: 6.5, ring: isDrag || q.id === state.active });
    pts.push({ x: x0, y: 0, text: `x${sub(0)} = ${fmtNum(x0, 8)}` });
  }
  state.points = pts;
  if (state.hover) g.label(state.hover.text, state.hover.x, state.hover.y);

  if (state.anim && animP >= 1) state.anim = null;
  if (state.anim) g.redraw();
}

const SUBS = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).split('').map((d) => SUBS[d]).join('');

// ----- basins of attraction -----
let basinCache = null, basinTimer = null;
function scheduleBasins() {
  if (!state.basins) return;
  clearTimeout(basinTimer);
  basinTimer = setTimeout(computeBasins, 120);
}
function computeBasins() {
  if (!state.fn || !state.basins) return;
  const { f, df } = state.fn;
  const roots = [];
  const cols = [];
  const step = 2;
  for (let X = 0; X < graph.w + step; X += step) {
    const x = graph.wx(X);
    const r = rootOf(newton(f, df, x, MAX_ITER));
    let idx = -1;
    if (r !== null) {
      idx = roots.findIndex((s) => Math.abs(s - r) < 1e-6 * Math.max(1, Math.abs(r)));
      if (idx < 0) { roots.push(r); idx = roots.length - 1; }
    }
    cols.push({ x0: graph.wx(X - step / 2), x1: graph.wx(X + step / 2), idx });
  }
  // color roots in left-to-right order so colors are stable while panning
  const order = roots.map((r, i) => i).sort((a, b) => roots[a] - roots[b]);
  const rank = new Map(order.map((i, k) => [i, k]));
  basinCache = { cols: cols.map((c) => ({ ...c, idx: c.idx < 0 ? -1 : rank.get(c.idx) })), roots: order.map((i) => roots[i]) };
  graph.redraw();
}
function drawBasins(g, ctx) {
  if (!basinCache) return;
  const Y = g.h - 10; // color strip along the bottom edge
  for (const c of basinCache.cols) {
    const X0 = g.px(c.x0), X1 = g.px(c.x1);
    if (X1 < 0 || X0 > g.w) continue;
    const col = c.idx < 0 ? '#9a9a9a' : BASIN_COLORS[c.idx % BASIN_COLORS.length];
    ctx.fillStyle = col + (c.idx < 0 ? '10' : '1c');
    ctx.fillRect(X0, 0, X1 - X0 + 0.5, g.h);
    ctx.fillStyle = col + (c.idx < 0 ? '66' : 'cc');
    ctx.fillRect(X0, Y, X1 - X0 + 0.5, 10);
  }
  basinCache.roots.forEach((r, i) => {
    g.point(r, 0, BASIN_COLORS[i % BASIN_COLORS.length], { r: 3.5 });
  });
}

// ----- graph interaction -----
function hitGuess(X, Y) {
  let best = null, bd = 14;
  for (const q of state.guesses) {
    const d = Math.hypot(graph.px(q.x0) - X, graph.py(0) - Y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
function roundToView(x) {
  const q = Math.pow(10, Math.floor(Math.log10(1 / graph.sx)));
  return +(Math.round(x / q) * q).toPrecision(12);
}
graph.dragHandler = (X, Y) => {
  const q = hitGuess(X, Y);
  if (!q) return null;
  state.dragId = q.id;
  setActive(q.id);
  return {
    move(x) {
      q.x0 = roundToView(x);
      recompute(q);
      renderGuessInputs(false);
      renderTable();
      graph.redraw();
    },
    end() { state.dragId = null; saveHash(); graph.redraw(); },
  };
};
graph.hoverHandler = (X, Y) => {
  let h = null, bd = 9;
  for (const p of state.points || []) {
    const d = Math.hypot(graph.px(p.x) - X, graph.py(p.y) - Y);
    if (d < bd) { bd = d; h = p; }
  }
  if (h !== state.hover) { state.hover = h; graph.redraw(); }
  return hitGuess(X, Y) ? 'ew-resize' : null;
};
$('#graph').addEventListener('pointerleave', () => { if (state.hover) { state.hover = null; graph.redraw(); } });
$('#graph').addEventListener('dblclick', (e) => {
  const r = e.target.getBoundingClientRect();
  addGuess(roundToView(graph.wx(e.clientX - r.left)));
});
$('#zoom-in').addEventListener('click', () => graph.zoom(1.5));
$('#zoom-out').addEventListener('click', () => graph.zoom(1 / 1.5));
$('#zoom-home').addEventListener('click', () => graph.fit(...(state.view || [-5, 5, -5, 5])));

// ---------- function & guesses ----------

function setFunction(expr, { save = true } = {}) {
  state.expr = expr;
  const err = $('#f-error');
  try {
    state.fn = compileFunction(expr);
    err.textContent = '';
    $('#f-input').classList.remove('bad');
    katex.render(`f'(x) = ${state.fn.dtex}`, $('#fprime'), { throwOnError: false });
  } catch (e) {
    state.fn = null;
    err.textContent = e.message;
    $('#f-input').classList.add('bad');
    $('#fprime').textContent = '';
  }
  state.guesses.forEach(recompute);
  basinCache = null;
  scheduleBasins();
  renderTable();
  updateControls();
  graph.redraw();
  if (save) saveHash();
}

function recompute(q) {
  q.run = state.fn ? newton(state.fn.f, state.fn.df, q.x0, MAX_ITER) : { xs: [q.x0], status: 'none' };
}

function addGuess(x0) {
  if (state.guesses.length >= COLORS.length) return;
  const used = new Set(state.guesses.map((q) => q.color));
  const color = COLORS.find((c) => !used.has(c));
  const q = { id: nextId++, x0, color };
  recompute(q);
  state.guesses.push(q);
  state.active = q.id;
  renderGuessInputs(true);
  renderTable();
  updateControls();
  graph.redraw();
  saveHash();
}

function removeGuess(id) {
  state.guesses = state.guesses.filter((q) => q.id !== id);
  if (state.active === id) state.active = state.guesses[0] ? state.guesses[0].id : 0;
  renderGuessInputs(true);
  renderTable();
  updateControls();
  graph.redraw();
  saveHash();
}

function setActive(id) {
  if (state.active === id) return;
  state.active = id;
  renderTable();
  graph.redraw();
}

function renderGuessInputs(rebuild) {
  const list = $('#guess-list');
  if (!rebuild) {
    for (const q of state.guesses) {
      const inp = list.querySelector(`[data-id="${q.id}"] input`);
      if (inp && document.activeElement !== inp) inp.value = q.x0;
    }
    return;
  }
  list.replaceChildren(
    ...state.guesses.map((q, i) => {
      const inp = el('input', { type: 'text', inputmode: 'decimal', value: String(q.x0), 'aria-label': `Starting guess ${i + 1}` });
      inp.addEventListener('input', () => {
        let v = NaN;
        try { v = math.evaluate(inp.value); } catch { /* ignore */ }
        if (typeof v !== 'number' || !Number.isFinite(v)) { inp.classList.add('bad'); return; }
        inp.classList.remove('bad');
        q.x0 = v;
        recompute(q);
        renderTable();
        updateControls();
        graph.redraw();
        saveHash();
      });
      inp.addEventListener('focus', () => setActive(q.id));
      return el('div', { class: 'expr-row guess-row', 'data-id': q.id },
        el('div', { class: 'gutter' }, el('span', { class: 'swatch', style: `background:${q.color}` })),
        el('label', { class: 'expr-body' }, el('span', { class: 'lhs' }, 'x', el('sub', {}, '0'), ' = '), inp),
        el('button', { class: 'remove', title: 'Remove this guess', 'aria-label': 'Remove guess', onclick: () => removeGuess(q.id) }, '×')
      );
    })
  );
  $('#add-guess').disabled = state.guesses.length >= COLORS.length;
}

// ---------- stepping ----------

function step() {
  if (state.shown >= maxSteps()) { stopRun(); return; }
  state.shown++;
  state.anim = { start: performance.now() };
  afterStep();
}
function back() {
  stopRun();
  if (state.shown > 0) state.shown--;
  state.anim = null;
  afterStep();
}
function reset() {
  stopRun();
  state.shown = 0;
  state.anim = null;
  afterStep();
}
let runTimer = null;
function toggleRun() {
  if (state.running) { stopRun(); return; }
  if (state.shown >= maxSteps()) state.shown = 0;
  state.running = true;
  const tick = () => {
    if (!state.running) return;
    if (state.shown >= maxSteps()) { stopRun(); return; }
    step();
    runTimer = setTimeout(tick, ANIM_MS + 350);
  };
  tick();
  updateControls();
}
function stopRun() {
  state.running = false;
  clearTimeout(runTimer);
  updateControls();
}
function afterStep() {
  renderTable();
  updateControls();
  graph.redraw();
}
function updateControls() {
  const m = maxSteps();
  $('#step').disabled = state.shown >= m || !state.fn;
  $('#back').disabled = state.shown === 0;
  $('#reset').disabled = state.shown === 0;
  $('#run').disabled = !state.fn || !state.guesses.length;
  $('#run').textContent = state.running ? '❚❚ Pause' : '▶ Run';
  $('#step-count').textContent = `Step ${Math.min(state.shown, m)} of ${m}`;
}

$('#step').addEventListener('click', () => { stopRun(); step(); });
$('#back').addEventListener('click', back);
$('#reset').addEventListener('click', reset);
$('#run').addEventListener('click', toggleRun);
$('#add-guess').addEventListener('click', () => {
  // pick a spot that's visible and not already used
  const xs = state.guesses.map((q) => q.x0);
  let x = roundToView(graph.wx(graph.w * (0.3 + 0.1 * state.guesses.length) % graph.w));
  if (xs.includes(x)) x = roundToView(x + 0.5);
  addGuess(x);
});
let fTimer = null;
$('#f-input').addEventListener('input', (e) => {
  clearTimeout(fTimer);
  fTimer = setTimeout(() => { setFunction(e.target.value); $('#preset').value = ''; }, 250);
});
$('#basins').addEventListener('change', (e) => {
  state.basins = e.target.checked;
  $('#basin-note').hidden = !state.basins;
  if (state.basins) computeBasins();
  graph.redraw();
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stopRun(); step(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
});

// ---------- table ----------

const STATUS_TEXT = {
  converged: (q, r, n) => `Converged to <b>${fmtNum(r, 15)}</b> after ${n} step${n === 1 ? '' : 's'}.`,
  flat: (q, r, n) => `Stopped: the tangent at x${sub(n)} is horizontal (f′ = 0), so it never meets the x-axis.`,
  undefined: (q, r, n) => `Stopped: f or f′ is undefined at x${sub(n)}.`,
  diverged: () => 'Diverged: the guesses run off toward infinity.',
  cycle: (q) => `Stuck in a ${q.run.period}-cycle — the guesses repeat forever.`,
  maxiter: () => `No convergence after ${MAX_ITER} steps.`,
  none: () => '',
};

function digitsCorrect(x, r) {
  const err = Math.abs(x - r);
  if (err === 0) return 16;
  return Math.max(0, Math.min(16, Math.floor(-Math.log10(err / Math.max(1, Math.abs(r))))));
}

function highlightDigits(x, r) {
  const s = x.toPrecision(16);
  if (r === null || /e/.test(s)) return fmtNum(x, 16);
  const t = r.toPrecision(16);
  let i = 0;
  while (i < s.length && s[i] === t[i]) i++;
  if (!/[1-9]/.test(s.slice(0, i))) i = 0; // need at least one matching significant digit
  const pretty = (u) => u.replace('-', '−');
  return `<span class="ok">${pretty(s.slice(0, i))}</span>${pretty(s.slice(i))}`;
}

function renderTable() {
  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...state.guesses.map((q) =>
      el('button', {
        class: 'tab' + (q.id === state.active ? ' active' : ''),
        role: 'tab',
        'aria-selected': q.id === state.active,
        onclick: () => setActive(q.id),
      }, el('span', { class: 'swatch', style: `background:${q.color}` }), `x₀ = ${fmtNum(q.x0, 6)}`)
    )
  );
  const q = state.guesses.find((g) => g.id === state.active);
  const body = $('#table-body');
  const status = $('#status');
  if (!q || !state.fn) {
    body.replaceChildren();
    status.textContent = state.fn ? 'Add a starting guess to begin.' : '';
    return;
  }
  const { f, df } = state.fn;
  const { xs } = q.run;
  const r = rootOf(q.run);
  const k = Math.min(state.shown, xs.length - 1);
  const rows = [];
  for (let n = 0; n <= k; n++) {
    const x = xs[n];
    const fx = f(x), dfx = df(x);
    let dcell = '<td class="na">—</td>';
    if (r !== null) {
      const d = digitsCorrect(x, r);
      dcell = `<td class="digits"><span class="bar" style="width:${(d / 16) * 100}%;background:${q.color}"></span><span class="num">${d === 16 ? 'all' : d}</span></td>`;
    }
    rows.push(`<tr><td>${n}</td><td class="mono">${highlightDigits(x, r)}</td><td class="mono">${fmtNum(fx, 4)}</td><td class="mono">${fmtNum(dfx, 4)}</td>${dcell}</tr>`);
  }
  body.innerHTML = rows.join('');
  const done = state.shown >= stepsFor(q.run);
  status.innerHTML = done
    ? STATUS_TEXT[q.run.status](q, r, xs.length - 1)
    : state.shown === 0
      ? 'Press <b>Step</b> (or the → key) to draw the first tangent line.'
      : 'Press <b>Step</b> to keep going.';
  status.className = 'status ' + (done ? q.run.status : '');
}

// ---------- presets & URL ----------

function loadPreset(key, { save = true } = {}) {
  const p = PRESETS[key];
  if (!p) return;
  stopRun();
  state.guesses = [];
  nextId = 1;
  state.shown = 0;
  state.view = p.view;
  $('#f-input').value = p.expr;
  $('#preset').value = key;
  setFunction(p.expr, { save: false });
  p.guesses.forEach((x) => addGuess(x));
  state.active = state.guesses[0].id;
  renderTable();
  graph.fit(...p.view);
  if (save) saveHash();
}

const sel = $('#preset');
sel.append(el('option', { value: '' }, 'Choose an example…'));
for (const [k, p] of Object.entries(PRESETS)) sel.append(el('option', { value: k }, p.label));
sel.addEventListener('change', () => sel.value && loadPreset(sel.value));
document.querySelectorAll('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    loadPreset(b.dataset.preset);
    $('#app').scrollIntoView({ behavior: 'smooth' });
  })
);

function saveHash() {
  const h = new URLSearchParams({ f: state.expr, x0: state.guesses.map((q) => q.x0).join(',') });
  history.replaceState(null, '', '#' + h.toString());
}

function loadFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('f')) return false;
  const expr = h.get('f');
  $('#f-input').value = expr;
  setFunction(expr, { save: false });
  const xs = (h.get('x0') || '').split(',').map(Number).filter(Number.isFinite);
  xs.forEach((x) => addGuess(x));
  if (state.guesses.length) state.active = state.guesses[0].id;
  const preset = Object.entries(PRESETS).find(([, p]) => p.expr === expr);
  if (preset) $('#preset').value = preset[0];
  const lo = Math.min(-5, ...xs) - 1, hi = Math.max(5, ...xs) + 1;
  state.view = [lo, hi, -(hi - lo) / 3, (hi - lo) / 3];
  graph.fit(...state.view);
  renderTable();
  return true;
}

// render math in the explanation
renderMathInElement(document.body, {
  delimiters: [
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
  ],
});

if (!loadFromHash()) loadPreset('sqrt2', { save: false });
updateControls();
