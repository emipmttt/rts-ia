import { TILE_SIZE } from '../shared/constants.js';

const SQRT2 = Math.SQRT2;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Minimal binary heap of tile indexes ordered by score
class Heap {
  constructor(score) { this.items = []; this.score = score; }

  get size() { return this.items.length; }

  push(v) {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score[a[p]] <= this.score[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.score[a[l]] < this.score[a[m]]) m = l;
        if (r < a.length && this.score[a[r]] < this.score[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* over the tile grid, 8 directions without cutting blocked corners.
 * With enterGoal the goal tile may itself be blocked (a tree being chopped). When the goal can't be reached the path
 * leads to the reachable tile closest to it and `partial` is true.
 * @param {Uint8Array} blocked 1 = impassable tile
 * @returns {{ points: {x, y}[], partial: boolean }}
 */
export function findPath(blocked, sx, sy, gx, gy, enterGoal = false) {
  const N = Math.sqrt(blocked.length); // grids are square
  const tileCenter = (i) => ({ x: ((i % N) + 0.5) * TILE_SIZE, y: (Math.floor(i / N) + 0.5) * TILE_SIZE });
  const start = sy * N + sx;
  const goal = gy * N + gx;
  const h = (i) => Math.hypot((i % N) - gx, Math.floor(i / N) - gy);
  const g = new Float32Array(N * N).fill(Infinity);
  const f = new Float32Array(N * N).fill(Infinity);
  const from = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);
  const open = new Heap(f);
  g[start] = 0;
  f[start] = h(start);
  open.push(start);
  let best = start;

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { best = goal; break; }
    if (h(cur) < h(best)) best = cur;
    const cx = cur % N;
    const cy = Math.floor(cur / N);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const ni = ny * N + nx;
      if (closed[ni] || (blocked[ni] && !(enterGoal && ni === goal))) continue;
      if (dx && dy && (blocked[cy * N + nx] || blocked[ny * N + cx])) continue; // no corner cutting
      const cost = g[cur] + (dx && dy ? SQRT2 : 1);
      if (cost >= g[ni]) continue;
      g[ni] = cost;
      f[ni] = cost + h(ni);
      from[ni] = cur;
      open.push(ni);
    }
  }

  const points = [];
  for (let i = best; i !== start && i !== -1; i = from[i]) points.push(tileCenter(i));
  points.reverse();
  return { points, partial: best !== goal };
}

// True when a body of radius r can walk the straight segment without touching a blocked tile
// (tiles listed in `ignore` don't count, e.g. the tree being walked to)
export function clearLine(blocked, x0, y0, x1, y1, r, ignore = -1) {
  const N = Math.sqrt(blocked.length);
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / (TILE_SIZE / 4)));
  for (let s = 0; s <= steps; s++) {
    const x = x0 + ((x1 - x0) * s) / steps;
    const y = y0 + ((y1 - y0) * s) / steps;
    for (const [ox, oy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      const tx = Math.floor((x + ox) / TILE_SIZE);
      const ty = Math.floor((y + oy) / TILE_SIZE);
      if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
      const i = ty * N + tx;
      if (blocked[i] && i !== ignore) return false;
    }
  }
  return true;
}
