// Parsing f(x), symbolic differentiation, and Newton's Method iteration.
/* global math */

// Real-valued power: lets x^(1/3), x^(-2/3), etc. work for negative x
// (math.js would otherwise return a complex number).
function realpow(x, p) {
  if (x >= 0 || Number.isInteger(p)) return Math.pow(x, p);
  // find p = a/b with small b
  for (let b = 1; b <= 50; b++) {
    const a = Math.round(p * b);
    if (Math.abs(a / b - p) < 1e-12) {
      if (b % 2 === 0) return NaN;
      const v = Math.pow(-x, p);
      return a % 2 === 0 ? v : -v;
    }
  }
  return NaN;
}
math.import({ realpow }, { override: true });

const hasX = (node) => node.filter((n) => n.isSymbolNode && n.name === 'x').length > 0;

// Replace `a ^ c` (c constant) with realpow(a, c) so roots of negatives stay real.
function toRealPowers(node) {
  return node.transform((n) => {
    if (n.isOperatorNode && n.op === '^' && !hasX(n.args[1])) {
      return new math.FunctionNode(new math.SymbolNode('realpow'), [
        toRealPowers(n.args[0]),
        n.args[1],
      ]);
    }
    return n;
  });
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v.re === 'number') return Math.abs(v.im) < 1e-12 ? v.re : NaN;
  return NaN;
}

function makeEvaluator(node) {
  const code = toRealPowers(node).compile();
  return (x) => {
    try {
      return toNumber(code.evaluate({ x }));
    } catch {
      return NaN;
    }
  };
}

// Parse a user-entered expression. Returns { f, df, tex, dtex } or throws Error.
export function compileFunction(input) {
  let src = input.trim().replace(/^(f\s*\(\s*x\s*\)|y)\s*=/, '').trim();
  if (!src) throw new Error('Enter a function of x.');
  let node;
  try {
    node = math.parse(src);
  } catch (e) {
    throw new Error("Couldn't read that expression.");
  }
  // allow ln(x) as natural log
  node = node.transform((n) =>
    n.isFunctionNode && n.fn.name === 'ln' ? new math.FunctionNode(new math.SymbolNode('log'), n.args) : n
  );
  // check for unknown variables
  const unknown = new Set();
  node.traverse((n, path, parent) => {
    if (!n.isSymbolNode) return;
    if (parent && parent.isFunctionNode && path === 'fn') {
      if (typeof math[n.name] !== 'function') unknown.add(n.name + '()');
      return;
    }
    if (n.name !== 'x' && !(n.name in math && typeof math[n.name] !== 'function')) unknown.add(n.name);
  });
  if (unknown.size) throw new Error(`Unknown: ${[...unknown].join(', ')}. Use x as the variable.`);

  let dnode;
  try {
    dnode = math.derivative(node, 'x');
  } catch (e) {
    throw new Error("Couldn't differentiate that expression.");
  }
  const f = makeEvaluator(node);
  const dfSym = makeEvaluator(dnode);
  // Fall back to a numerical derivative wherever the symbolic one can't be evaluated.
  const df = (x) => {
    const d = dfSym(x);
    if (Number.isFinite(d)) return d;
    const h = 1e-6 * Math.max(1, Math.abs(x));
    return (f(x + h) - f(x - h)) / (2 * h);
  };
  return {
    f,
    df,
    tex: node.toTex({ implicit: 'hide', parenthesis: 'auto' }),
    dtex: dnode.toTex({ implicit: 'hide', parenthesis: 'auto' }),
  };
}

// Run Newton's Method from x0.
// Returns { xs, status, period? } where status is one of
// 'converged', 'flat', 'undefined', 'diverged', 'cycle', 'maxiter'.
export function newton(f, df, x0, maxIter = 60) {
  const xs = [x0];
  let status = null;
  for (let n = 0; n < maxIter; n++) {
    const x = xs[n];
    const fx = f(x);
    const dfx = df(x);
    if (!Number.isFinite(fx) || !Number.isFinite(dfx)) { status = 'undefined'; break; }
    if (fx === 0) { status = 'converged'; break; }
    if (dfx === 0 || Math.abs(fx / dfx) > 1e15) { status = 'flat'; break; }
    const next = x - fx / dfx;
    if (!Number.isFinite(next)) { status = 'diverged'; break; }
    xs.push(next);
    if (Math.abs(next) > 1e12) { status = 'diverged'; break; }
    if (Math.abs(next - x) <= 4e-16 * Math.max(1, Math.abs(next)) * 8) { status = 'converged'; break; }
  }
  if (!status) {
    const last = xs[xs.length - 1];
    if (Math.abs(f(last)) < 1e-12) {
      status = 'converged';
    } else {
      status = 'maxiter';
      for (let p = 2; p <= 6; p++) {
        const a = xs[xs.length - 1], b = xs[xs.length - 1 - p];
        if (Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a))) { status = 'cycle'; return { xs, status, period: p }; }
      }
      // steadily growing in size -> diverging
      const tail = xs.slice(-6).map(Math.abs);
      if (tail.every((v, i) => i === 0 || v > tail[i - 1]) && tail[5] > 1e3) status = 'diverged';
    }
  }
  return { xs, status };
}

// Final root estimate, for a converged run.
export const rootOf = (run) => (run.status === 'converged' ? run.xs[run.xs.length - 1] : null);
