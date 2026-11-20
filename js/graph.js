// A small Desmos-style graphing canvas: grid, axes, labels, pan & zoom.

const MINUS = '−';
const FONT = '13px "Helvetica Neue", Helvetica, Arial, sans-serif';

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  if (m < 1.5) return { major: p, minor: p / 5 };
  if (m < 3.5) return { major: 2 * p, minor: (2 * p) / 4 };
  if (m < 7.5) return { major: 5 * p, minor: p };
  return { major: 10 * p, minor: 2 * p };
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

function fmtTick(v, step) {
  if (Math.abs(v) < step * 1e-6) return '0';
  const a = Math.abs(step);
  let s;
  if (a >= 1e-4 && a < 1e6) {
    const dec = Math.max(0, -Math.floor(Math.log10(a) + 1e-9));
    s = String(parseFloat(v.toFixed(dec)));
  } else {
    const e = Math.floor(Math.log10(Math.abs(v)) + 1e-9);
    const m = +(v / Math.pow(10, e)).toFixed(3);
    s = (m === 1 ? '' : m === -1 ? '-' : m + '×') + '10' + String(e).split('').map((c) => SUP[c]).join('');
  }
  return s.replace('-', MINUS);
}

export function fmtNum(v, digits = 4) {
  if (!Number.isFinite(v)) return 'undefined';
  if (v === 0) return '0';
  const a = Math.abs(v);
  let s;
  if (a >= 1e-4 && a < 1e7) s = String(+v.toPrecision(digits));
  else s = v.toExponential(digits - 1).replace(/\.?0+e/, 'e');
  return s.replace('-', MINUS);
}

export class Graph {
  constructor(canvas, { onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onViewChange = onViewChange || (() => {});
    this.cx = 0; this.cy = 0; // world coords of canvas center
    this.sx = 60; this.sy = 60; // pixels per unit
    this.w = 0; this.h = 0;
    this._pendingFit = null;
    this.overlay = null; // function(graph, ctx) drawing app content
    this.dragHandler = null; // function(px, py) -> {move(x,y), end()} | null
    this.hoverHandler = null; // function(px, py) -> cursor string | null
    this._pointers = new Map();
    this._pending = false;
    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this._pendingFit && this.w > 0) {
      const f = this._pendingFit;
      this._pendingFit = null;
      this.fit(...f);
    }
    this.redraw();
  }

  // Show at least the given window, with equal scales on both axes (like Desmos).
  fit(xmin, xmax, ymin, ymax) {
    if (!this.w || !this.h) { this._pendingFit = [xmin, xmax, ymin, ymax]; return; }
    this.cx = (xmin + xmax) / 2;
    this.cy = (ymin + ymax) / 2;
    const s = Math.min(this.w / (xmax - xmin), this.h / (ymax - ymin));
    this.sx = this.sy = s;
    this._viewChanged();
  }

  get xmin() { return this.cx - this.w / 2 / this.sx; }
  get xmax() { return this.cx + this.w / 2 / this.sx; }
  get ymin() { return this.cy - this.h / 2 / this.sy; }
  get ymax() { return this.cy + this.h / 2 / this.sy; }

  px(x) { return this.w / 2 + (x - this.cx) * this.sx; }
  py(y) { return this.h / 2 - (y - this.cy) * this.sy; }
  wx(px) { return this.cx + (px - this.w / 2) / this.sx; }
  wy(py) { return this.cy - (py - this.h / 2) / this.sy; }

  _viewChanged() {
    this.onViewChange();
    this.redraw();
  }

  zoomAt(px, py, factor) {
    const x = this.wx(px), y = this.wy(py);
    this.sx = Math.min(1e12, Math.max(1e-9, this.sx * factor));
    this.sy = Math.min(1e12, Math.max(1e-9, this.sy * factor));
    this.cx = x - (px - this.w / 2) / this.sx;
    this.cy = y + (py - this.h / 2) / this.sy;
    this._viewChanged();
  }

  zoom(factor) { this.zoomAt(this.w / 2, this.h / 2, factor); }

  redraw() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this.draw();
    });
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    this._drawGrid();
    if (this.overlay) this.overlay(this, ctx);
  }

  _drawGrid() {
    const { ctx, w, h } = this;
    const gx = niceStep(110 / this.sx);
    const gy = niceStep(110 / this.sy);
    const lines = (step, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = Math.ceil(this.xmin / step); i <= Math.floor(this.xmax / step); i++) {
        const X = Math.round(this.px(i * step)) + 0.5;
        ctx.moveTo(X, 0); ctx.lineTo(X, h);
      }
      ctx.stroke();
      return step;
    };
    const linesY = (step, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = Math.ceil(this.ymin / step); i <= Math.floor(this.ymax / step); i++) {
        const Y = Math.round(this.py(i * step)) + 0.5;
        ctx.moveTo(0, Y); ctx.lineTo(w, Y);
      }
      ctx.stroke();
    };
    lines(gx.minor, '#f0f0f0', 1);
    linesY(gy.minor, '#f0f0f0', 1);
    lines(gx.major, '#d9d9d9', 1);
    linesY(gy.major, '#d9d9d9', 1);

    // axes
    const ax = this.py(0), ay = this.px(0);
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ax >= 0 && ax <= h) { ctx.moveTo(0, ax); ctx.lineTo(w, ax); }
    if (ay >= 0 && ay <= w) { ctx.moveTo(ay, 0); ctx.lineTo(ay, h); }
    ctx.stroke();

    // labels (clamped to edges when an axis is off-screen, as in Desmos)
    ctx.font = FONT;
    ctx.lineJoin = 'round';
    const halo = (text, x, y) => {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#333';
      ctx.fillText(text, x, y);
    };
    let labelY = Math.min(Math.max(ax + 4, 4), h - 18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = Math.ceil(this.xmin / gx.major); i <= Math.floor(this.xmax / gx.major); i++) {
      if (i === 0) continue;
      const X = this.px(i * gx.major);
      const t = fmtTick(i * gx.major, gx.major);
      halo(i < 0 ? t + ' ' : t, i < 0 ? X - 3 : X, labelY);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let labelX = Math.min(Math.max(ay - 6, 0), w - 6);
    if (labelX < 30) { ctx.textAlign = 'left'; labelX = Math.max(ay + 6, 4); }
    for (let i = Math.ceil(this.ymin / gy.major); i <= Math.floor(this.ymax / gy.major); i++) {
      if (i === 0) continue;
      const Y = this.py(i * gy.major);
      if (Y < 8 || Y > h - 8) continue;
      halo(fmtTick(i * gy.major, gy.major), labelX, Y);
    }
    if (ax >= 0 && ax <= h && ay >= 0 && ay <= w) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      halo('0', ay - 5, ax + 4);
    }
  }

  // ----- drawing helpers for overlays -----

  plot(fn, color, width = 2.5) {
    const { ctx, w, h } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    const clampY = (Y) => Math.max(-1e4, Math.min(h + 1e4, Y));
    let prev = null; // {X, Y, y}
    const step = 0.5;
    for (let X = -1; X <= w + 1; X += step) {
      const x = this.wx(X);
      const y = fn(x);
      if (!Number.isFinite(y)) { prev = null; continue; }
      const Y = this.py(y);
      if (prev) {
        // break the path at vertical asymptotes / jumps
        if (Math.abs(Y - prev.Y) > h) {
          const ym = fn(this.wx(X - step / 2));
          const lo = Math.min(prev.y, y), hi = Math.max(prev.y, y);
          if (!Number.isFinite(ym) || ym < lo || ym > hi) { prev = { X, Y, y }; ctx.moveTo(X, clampY(Y)); continue; }
        }
        ctx.lineTo(X, clampY(Y));
      } else {
        ctx.moveTo(X, clampY(Y));
      }
      prev = { X, Y, y };
    }
    ctx.stroke();
  }

  segment(x0, y0, x1, y1, color, width = 2, dash = null) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(this.px(x0), this.py(y0));
    ctx.lineTo(this.px(x1), this.py(y1));
    ctx.stroke();
    ctx.restore();
  }

  // Infinite line through (x0,y0) with slope m, clipped to the view.
  line(x0, y0, m, color, width = 1.5, alpha = 1) {
    const xa = this.xmin - 1, xb = this.xmax + 1;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.segment(xa, y0 + m * (xa - x0), xb, y0 + m * (xb - x0), color, width);
    this.ctx.restore();
  }

  point(x, y, color, { r = 4.5, hollow = false, ring = false } = {}) {
    const { ctx } = this;
    const X = this.px(x), Y = this.py(y);
    if (!Number.isFinite(X) || !Number.isFinite(Y) || Math.abs(X) > 1e5 || Math.abs(Y) > 1e5) return;
    if (ring) {
      ctx.beginPath();
      ctx.arc(X, Y, r + 6, 0, 2 * Math.PI);
      ctx.fillStyle = color + '33';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(X, Y, r, 0, 2 * Math.PI);
    ctx.fillStyle = hollow ? '#fff' : color;
    ctx.fill();
    ctx.lineWidth = hollow ? 2.5 : 1.5;
    ctx.strokeStyle = hollow ? color : '#fff';
    ctx.stroke();
  }

  label(text, x, y, color = '#444') {
    const { ctx } = this;
    const X = this.px(x), Y = this.py(y);
    ctx.save();
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 4;
    const tx = Math.min(X + 9, this.w - ctx.measureText(text).width - 4);
    const ty = Math.max(Y - 7, 18);
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = color;
    ctx.fillText(text, tx, ty);
    ctx.restore();
  }

  // ----- interaction -----

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-d * 0.0015));
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const X = e.clientX - r.left, Y = e.clientY - r.top;
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { X, Y });
      if (this._pointers.size === 1) {
        const handler = this.dragHandler && this.dragHandler(X, Y);
        this._drag = handler ? { handler } : { pan: true, X, Y };
      } else {
        // second finger: switch to pinch
        if (this._drag && this._drag.handler) this._drag.handler.end();
        this._drag = { pinch: true };
      }
      c.classList.add('dragging');
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const X = e.clientX - r.left, Y = e.clientY - r.top;
      if (!this._pointers.has(e.pointerId)) {
        if (this.hoverHandler) c.style.cursor = this.hoverHandler(X, Y) || '';
        return;
      }
      const prevPts = [...this._pointers.values()].map((p) => ({ ...p }));
      this._pointers.set(e.pointerId, { X, Y });
      const d = this._drag;
      if (!d) return;
      if (d.handler) {
        d.handler.move(this.wx(X), this.wy(Y));
      } else if (d.pan) {
        this.cx -= (X - d.X) / this.sx;
        this.cy += (Y - d.Y) / this.sy;
        d.X = X; d.Y = Y;
        this._viewChanged();
      } else if (d.pinch && this._pointers.size >= 2) {
        const pts = [...this._pointers.values()];
        const dist = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);
        const f = dist(pts[0], pts[1]) / Math.max(1, dist(prevPts[0], prevPts[1]));
        const mx = (pts[0].X + pts[1].X) / 2, my = (pts[0].Y + pts[1].Y) / 2;
        const pmx = (prevPts[0].X + prevPts[1].X) / 2, pmy = (prevPts[0].Y + prevPts[1].Y) / 2;
        this.cx -= (mx - pmx) / this.sx;
        this.cy += (my - pmy) / this.sy;
        this.zoomAt(mx, my, f);
      }
    });

    const up = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      if (this._drag && this._drag.handler) this._drag.handler.end();
      if (this._pointers.size === 0) {
        this._drag = null;
        c.classList.remove('dragging');
      } else if (this._pointers.size === 1) {
        const p = [...this._pointers.values()][0];
        this._drag = { pan: true, X: p.X, Y: p.Y };
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }
}
