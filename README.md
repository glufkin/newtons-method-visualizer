# Newton's Method Visualizer

An interactive, Desmos-style demonstration of Newton's Method in single-variable calculus.

- Type any function f(x); its derivative is computed symbolically.
- Step through the iterations one tangent line at a time, for several starting guesses at once.
- See how fast it converges: the iteration table highlights the correct digits of each guess, which roughly double every step.
- Built-in examples show the ways Newton's Method can fail, plus a "basins of attraction" view.

## Running locally

It's a static site with no build step. Serve the folder with any static server, for example:

```bash
python3 -m http.server
```

then open http://localhost:8000. (Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://` URLs.)

## Hosting

Deployed with GitHub Pages from the `main` branch root.

## Files

- `index.html`: page layout and the explanatory text
- `js/graph.js`: canvas graphing (grid, axes, pan and zoom)
- `js/newton.js`: parsing, differentiation, and the iteration itself
- `js/app.js`: UI state, animation, the table, and the examples
- `vendor/`: [math.js](https://mathjs.org) and [KaTeX](https://katex.org), bundled so the site has no external dependencies
