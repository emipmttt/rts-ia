import {
  TILE_SIZE, Terrain, ResourceType, RESOURCE_STATS, BUSH_WOOD,
} from '../shared/constants.js';

// Deterministic PRNG so a seed always produces the same map
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic 2D Perlin noise, output roughly in [-1, 1]
function createPerlin(rng) {
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = [...perm, ...perm];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const grad = (hash, x, y) => {
    const h = hash & 3;
    return ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  };

  return (x, y) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    return lerp(
      lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
      v,
    );
  };
}
// Tuning
const NOISE_SCALE = 0.07;
const ROAD_WIDTH = 0.045; // |height| below this = sand road (the noise "valleys"); purely cosmetic
const SPAWN_CLEAR_RADIUS = 13; // tiles kept free of forests around each town center's middle (room to build)
// Every base gets exactly the same resources around it, so starts are fair (amounts like Age of
// Empires' standard land maps, distances from the town center's middle; it is 7 tiles wide)
const BASE_WOODLINES = [
  { trees: 54, angle: 2.4, distance: 17 }, // main woodline behind the base, a little to one side
  { trees: 32, angle: -1.5, distance: 16 }, // a smaller one to the other side
];
const STRAGGLER_TREES = 4; // lone trees just outside the town center
const BASE_MINES = [
  { type: 'gold', tiles: 7, angle: -0.7, distance: 11.5 }, // main gold
  { type: 'stone', tiles: 5, angle: 0.8, distance: 12.5 }, // main stone
  { type: 'gold', tiles: 4, angle: 0.15, distance: 21 }, // second gold, toward the middle
  { type: 'stone', tiles: 4, angle: -1.9, distance: 19 }, // second stone, off to the side
];
const BASE_SHEEP = 8; // around the town center
const FAR_SHEEP_PAIRS = 2; // further out
// Neutral resources between the bases, scaled with the map area (per 1000 tiles)
const BORDER_FOREST = 6; // tiles from the map edge where the border forest grows (in noisy bands)
const FOREST_CLUMPS_PER_1000 = 1.8;
const CLUMP_TREES = [20, 45]; // min, max
const GOLD_PILES_PER_1000 = 0.45;
const STONE_PILES_PER_1000 = 0.35;
const PILE_TILES = [4, 6];
const SHEEP_PER_1000 = 1.5;
const BUSHES_PER_1000 = 8;
const NEUTRAL_MIN_DISTANCE = 24; // neutral resources stay this far from bases and the centre
// Rivers: one running across the map and one running down it, between the bases and the centre,
// crossable only over their bridges
const RIVER_WIDTH = 2;
const SPIRIT_RIVER_WIDTH = 4; // the spirit dimension's chasms are wider
const RIVER_POSITIONS = [0.28, 0.29, 0.3, 0.7, 0.71, 0.72]; // middle line, as a fraction of the map side
const RIVER_BRIDGES = 4;
const BRIDGE_WIDTH = 2;
const RIVER_CLEARANCE = 11; // rivers stay this far from bases and the centre
// Spirit dimension: crystal outcrops (impassable). The same ones at every base, in base-relative
// spots like the mines (angle from the direction to the map centre, distance in tiles), and neutral
// ones on the ring between neighbouring bases and further in toward the centre; `r` = blob radius
const BASE_CRYSTALS = [
  { r: 7.5, angle: 0.95, distance: 31 }, // a crystal mountain off to one side, toward the middle
  { r: 3.2, angle: -0.95, distance: 31 }, // a crag on the other side
  { r: 1.2, angle: -1.6, distance: 22 }, // small ones scattered around the base
  { r: 1.1, angle: Math.PI, distance: 13 },
  { r: 1.3, angle: 2.2, distance: 19 },
  { r: 1.0, angle: -2.5, distance: 17 },
];
// `shift`: fraction of the gap between the two bases to turn the spot by (the same at every gap)
const NEUTRAL_CRYSTALS = [
  { r: 8.5, ring: 1 }, // a crystal mountain between two bases, on the ring the bases stand on
  { r: 3.4, ring: 0.74, shift: 0.18 }, // crags further in
  { r: 1.3, ring: 0.52 }, // further in, between the bases' lanes to the centre
  { r: 2.6, ring: 1.36, shift: -0.12 }, // out toward the map's edge
  { r: 1.2, ring: 0.9, shift: -0.3 },
  { r: 1.2, ring: 1.15, shift: 0.32 },
];
const CRYSTAL_RIVER_GAP = 3; // tiles kept between crystals and rivers
const CRYSTAL_GAP = 2; // ... and between two outcrops
const TREE_CUT_COST = 8; // how much a road prefers going around a forest over cutting through it
const BASE_TREE_CUT_COST = 200; // a base's own trees are only cut when there is no other way, to keep starts fair

/**
 * Generates the terrain grid and the resource tiles.
 * @param {number} seed
 * @param {number} size map side in tiles
 * @param {{x: number, y: number}[]} spawnPoints world coordinates of each town center
 * @param {{x: number, y: number}[]} clearPoints extra spots kept free of trees and sand (e.g. the central town center)
 * @param {{theme?: string}} options `theme: 'spirit'` widens the rivers and adds crystal outcrops
 * @returns {{ seed, tiles: number[], resources: {id, type, variant, tx, ty, x, y, amount, max}[] }}
 */
export function generateWorld(seed, size, spawnPoints, clearPoints = [], { theme = 'classic' } = {}) {
  const spirit = theme === 'spirit';
  const rng = mulberry32(seed);
  const noise = createPerlin(rng);
  const height = (tx, ty) => noise(tx * NOISE_SCALE, ty * NOISE_SCALE) * 0.75 + noise(tx * NOISE_SCALE * 2, ty * NOISE_SCALE * 2) * 0.25;
  const per1000 = (n) => Math.round((n * size * size) / 1000);

  const tiles = new Array(size * size).fill(Terrain.GRASS);
  const resourceAt = new Map(); // "tx,ty" -> resource
  const toTile = (p) => ({ tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) });
  const spawnTiles = spawnPoints.map(toTile);
  const clearTiles = [...spawnTiles, ...clearPoints.map(toTile)];
  const distToClear = (tx, ty) => Math.min(...clearTiles.map((s) => Math.hypot(s.tx - tx, s.ty - ty)));
  const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < size && ty < size;
  const tileAt = (tx, ty) => tiles[ty * size + tx];
  const isWet = (tx, ty) => tileAt(tx, ty) === Terrain.WATER || tileAt(tx, ty) === Terrain.BRIDGE;
  const isFree = (tx, ty) => inMap(tx, ty) && !resourceAt.has(`${tx},${ty}`) && !isWet(tx, ty) && tileAt(tx, ty) !== Terrain.CRYSTAL;
  const nearBridge = new Set(); // tiles at either end of a bridge are kept free of resources
  const canGrow = (tx, ty) => isFree(tx, ty) && !nearBridge.has(`${tx},${ty}`) && distToClear(tx, ty) > SPAWN_CLEAR_RADIUS;
  const randomTile = () => [Math.floor(rng() * size), Math.floor(rng() * size)];

  let nextId = 1;
  let base = null; // index of the base whose own resources are being placed, null for neutral ones
  const addResource = (type, tx, ty, variant = null) => {
    const amount = variant === 'bush' ? BUSH_WOOD : RESOURCE_STATS[type].amount;
    resourceAt.set(`${tx},${ty}`, {
      id: nextId++, type, variant, tx, ty, x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE, amount, max: amount, base,
    });
  };

  // ---- Rivers ----
  // A sine-shaped river. Along the river, `u` is the coordinate it flows along and `v` the one across.
  const riverWidth = spirit ? SPIRIT_RIVER_WIDTH : RIVER_WIDTH;
  const addRiver = (axis) => {
    const cell = (u, v) => (axis === 'x' ? [u, v] : [v, u]);
    for (let attempt = 0; attempt < 40; attempt++) {
      const base = Math.round(size * RIVER_POSITIONS[Math.floor(rng() * RIVER_POSITIONS.length)]);
      const amplitude = 1 + rng() * 2.5;
      const freq = 0.08 + rng() * 0.08;
      const phase = rng() * Math.PI * 2;
      const middle = (u) => Math.round(base + amplitude * Math.sin(u * freq + phase));
      // Each column spans from its own middle to the previous one's so the river has no diagonal gaps
      const columns = [];
      for (let u = 0; u < size; u++) {
        const lo = Math.min(middle(u), middle(Math.max(0, u - 1))) - Math.floor(riverWidth / 2);
        const hi = Math.max(middle(u), middle(Math.max(0, u - 1))) + Math.ceil(riverWidth / 2) - 1;
        columns.push([lo, hi]);
      }
      const cells = columns.flatMap(([lo, hi], u) => Array.from({ length: hi - lo + 1 }, (_, k) => cell(u, lo + k)));
      if (cells.some(([tx, ty]) => distToClear(tx, ty) < RIVER_CLEARANCE)) continue;
      for (const [tx, ty] of cells) tiles[ty * size + tx] = Terrain.WATER;

      // Bridges spread along the river, skipping spots where the other river crosses
      const spacing = size / RIVER_BRIDGES;
      const crossesOther = (u) => {
        const [lo, hi] = columns[u];
        return [cell(u, lo - 1), cell(u, hi + 1)].some(([x, y]) => inMap(x, y) && isWet(x, y));
      };
      for (let b = 0; b < RIVER_BRIDGES; b++) {
        let start = Math.round(spacing * (b + 0.5) - BRIDGE_WIDTH / 2);
        while (start < size - BRIDGE_WIDTH && [...Array(BRIDGE_WIDTH).keys()].some((k) => crossesOther(start + k))) start++;
        for (let u = start; u < start + BRIDGE_WIDTH && u < size; u++) {
          const [lo, hi] = columns[u];
          for (let v = lo; v <= hi; v++) {
            const [tx, ty] = cell(u, v);
            if (tileAt(tx, ty) === Terrain.WATER) tiles[ty * size + tx] = Terrain.BRIDGE;
          }
          for (let v = lo - 2; v <= hi + 2; v++) nearBridge.add(cell(u, v).join(','));
        }
      }
      return;
    }
  };
  addRiver('x');
  addRiver('y');

  const center = size / 2;
  if (spirit) addCrystals();

  // Sand roads (cosmetic)
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (!isWet(tx, ty) && tileAt(tx, ty) !== Terrain.CRYSTAL && Math.abs(height(tx, ty)) < ROAD_WIDTH && distToClear(tx, ty) > SPAWN_CLEAR_RADIUS) {
        tiles[ty * size + tx] = Terrain.SAND;
      }
    }
  }

  // Grows a patch of `count` resource tiles outward from (tx, ty), closest tiles first; returns how many it placed
  const growPatch = (tx, ty, count, place, allowed = canGrow) => {
    const queue = [[tx, ty]];
    const seen = new Set([`${tx},${ty}`]);
    let placed = 0;
    while (queue.length && placed < count) {
      // Pick the queued tile closest to the seed, with a little noise so patches look natural
      let best = 0;
      let bestScore = Infinity;
      queue.forEach(([x, y], i) => {
        const score = Math.hypot(x - tx, y - ty) + rng() * 0.8;
        if (score < bestScore) { best = i; bestScore = score; }
      });
      const [x, y] = queue.splice(best, 1)[0];
      if (allowed(x, y)) { place(x, y); placed++; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${x + dx},${y + dy}`;
        if (!seen.has(key) && inMap(x + dx, y + dy) && Math.hypot(x + dx - tx, y + dy - ty) < 12) {
          seen.add(key);
          queue.push([x + dx, y + dy]);
        }
      }
    }
    return placed;
  };

  // A compact cluster of `count` mine tiles grown from (tx, ty) on dry, empty ground; placed only if
  // it fits whole. `minClear` keeps it that far from every base and the centre
  const placeMine = (type, tx, ty, count, minClear) => {
    const ok = (x, y) => x >= 1 && y >= 1 && x < size - 1 && y < size - 1 && isFree(x, y)
      && !nearBridge.has(`${x},${y}`) && distToClear(x, y) > minClear;
    if (!ok(tx, ty)) return null;
    const cells = [[tx, ty]];
    const seen = new Set([`${tx},${ty}`]);
    while (cells.length < count) {
      // The free neighbour closest to the seed
      let best = null, bestD = Infinity;
      for (const [x, y] of cells)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
          if (seen.has(key) || !ok(nx, ny)) continue;
          const d = Math.hypot(nx - tx, ny - ty) + rng() * 0.3;
          if (d < bestD) { bestD = d; best = [nx, ny]; }
        }
      if (!best) return null;
      seen.add(best.join(','));
      cells.push(best);
    }
    for (const [x, y] of cells) {
      tiles[y * size + x] = Terrain.GRASS;
      addResource(type, x, y);
    }
    return cells;
  };

  // ---- Fair resources around every base ----
  const minesPlaced = BASE_MINES.map(() => []); // per mine: the cells placed for each base
  spawnTiles.forEach((s, index) => {
    base = index;
    const toCenter = Math.atan2(center - s.ty, center - s.tx);
    const at = (angle, d) => [Math.round(s.tx + Math.cos(angle) * d), Math.round(s.ty + Math.sin(angle) * d)];

    for (const { trees, angle, distance } of BASE_WOODLINES) {
      const [fx, fy] = at(toCenter + angle, distance);
      growPatch(fx, fy, trees, (x, y) => addResource(ResourceType.WOOD, x, y));
    }
    // A few lone trees right outside the town center, toward the back
    for (let i = 0, placed = 0; i < 24 && placed < STRAGGLER_TREES; i++) {
      const [x, y] = at(toCenter + Math.PI + (i % 6 - 2.5) * 0.45, 6.5 + Math.floor(i / 6));
      if (isFree(x, y) && !nearBridge.has(`${x},${y}`)) { addResource(ResourceType.WOOD, x, y); placed++; }
    }
    // Mines, each nudged around its spot (sweeping sideways, then further out) until the whole
    // cluster fits
    BASE_MINES.forEach(({ type, tiles: count, angle, distance }, m) => {
      for (let tries = 0; tries < 300; tries++) {
        const sweep = tries % 15, side = sweep % 2 ? 1 : -1;
        const [mx, my] = at(toCenter + angle + side * Math.ceil(sweep / 2) * 0.12, distance + Math.floor(tries / 15) * 0.6);
        const cells = placeMine(type, mx, my, count, 9);
        if (cells) { minesPlaced[m][index] = cells; break; }
      }
    });
    // Sheep grazing around the town center, two pairs further out
    let sheep = 0;
    for (let d = 6; d < 11 && sheep < BASE_SHEEP; d++) {
      for (let k = 0; k < 12 && sheep < BASE_SHEEP; k++) {
        const [x, y] = at(toCenter + Math.PI / 2 + (k / 12) * Math.PI * 2, d);
        if (isFree(x, y) && !nearBridge.has(`${x},${y}`)) { addResource(ResourceType.FOOD, x, y, 'sheep'); sheep++; }
      }
    }
    for (let pair = 0; pair < FAR_SHEEP_PAIRS; pair++) {
      for (let tries = 0; tries < 40; tries++) {
        const [x, y] = at(toCenter + (pair ? 1.3 : -1.3) + (tries % 5) * 0.1, 22 + Math.floor(tries / 5));
        if (isFree(x, y) && isFree(x + 1, y) && !nearBridge.has(`${x},${y}`)) {
          addResource(ResourceType.FOOD, x, y, 'sheep');
          addResource(ResourceType.FOOD, x + 1, y, 'sheep');
          break;
        }
      }
    }
  });
  base = null;
  // A mine that didn't fit at every base is taken away from all of them, so starts stay equal
  for (const placed of minesPlaced) {
    if (spawnTiles.every((_, i) => placed[i])) continue;
    for (const cells of placed) for (const [x, y] of cells ?? []) resourceAt.delete(`${x},${y}`);
  }

  // ---- Neutral resources ----
  const far = (tx, ty) => distToClear(tx, ty) >= NEUTRAL_MIN_DISTANCE;
  const scatter = (count, place) => {
    for (let placed = 0, tries = 0; placed < count && tries < count * 200; tries++) {
      const [tx, ty] = randomTile();
      if (far(tx, ty) && place(tx, ty)) placed++;
    }
  };
  // Border forest: thick along the edges, broken into bands by noise, never near a base
  for (let ty = 0; ty < size; ty++)
    for (let tx = 0; tx < size; tx++) {
      const edge = Math.min(tx, ty, size - 1 - tx, size - 1 - ty);
      if (edge >= BORDER_FOREST) continue;
      const n = noise(tx * 0.13 + 50, ty * 0.13 + 50);
      if (n > -0.15 + edge * 0.06 && canGrow(tx, ty) && distToClear(tx, ty) > SPAWN_CLEAR_RADIUS + 4) addResource(ResourceType.WOOD, tx, ty);
    }
  scatter(per1000(FOREST_CLUMPS_PER_1000), (tx, ty) => {
    const trees = CLUMP_TREES[0] + Math.floor(rng() * (CLUMP_TREES[1] - CLUMP_TREES[0]));
    return growPatch(tx, ty, trees, (x, y) => addResource(ResourceType.WOOD, x, y), (x, y) => canGrow(x, y) && far(x, y)) > 0;
  });
  const pile = () => PILE_TILES[0] + Math.floor(rng() * (PILE_TILES[1] - PILE_TILES[0] + 1));
  scatter(per1000(GOLD_PILES_PER_1000), (tx, ty) => placeMine(ResourceType.GOLD, tx, ty, pile(), NEUTRAL_MIN_DISTANCE));
  scatter(per1000(STONE_PILES_PER_1000), (tx, ty) => placeMine(ResourceType.STONE, tx, ty, pile(), NEUTRAL_MIN_DISTANCE));
  const onOpenGrass = (tx, ty) => isFree(tx, ty) && tileAt(tx, ty) === Terrain.GRASS && !nearBridge.has(`${tx},${ty}`);
  scatter(per1000(SHEEP_PER_1000), (tx, ty) => onOpenGrass(tx, ty) && (addResource(ResourceType.FOOD, tx, ty, 'sheep'), true));
  for (let placed = 0, tries = 0; placed < per1000(BUSHES_PER_1000) && tries < 5000; tries++) {
    const [tx, ty] = randomTile();
    if (!onOpenGrass(tx, ty) || distToClear(tx, ty) < SPAWN_CLEAR_RADIUS - 1) continue;
    addResource(ResourceType.WOOD, tx, ty, 'bush');
    placed++;
  }

  // Trees are solid, so a forest can wall a base off: cut the cheapest road through the trees from the
  // first base to every other base and to the centre
  const [first, ...others] = clearTiles;
  for (const target of others) {
    for (const [tx, ty] of cheapestRoad(first, target)) {
      if (resourceAt.get(`${tx},${ty}`)?.type === ResourceType.WOOD) resourceAt.delete(`${tx},${ty}`);
    }
  }

  // If a road had to cut through a base's own forest, trim the other bases to match so starts stay fair
  const baseTrees = spawnTiles.map((_, i) => [...resourceAt.values()].filter(
    (r) => r.base === i && r.type === ResourceType.WOOD,
  ));
  const fewest = Math.min(...baseTrees.map((t) => t.length));
  baseTrees.forEach((trees, i) => {
    const s = spawnTiles[i];
    trees.sort((a, b) => Math.hypot(b.tx - s.tx, b.ty - s.ty) - Math.hypot(a.tx - s.tx, a.ty - s.ty));
    for (const r of trees.slice(0, trees.length - fewest)) resourceAt.delete(`${r.tx},${r.ty}`);
  });

  // Dijkstra over 4-connected tiles: open ground costs 1, a tree costs TREE_CUT_COST, water and mines
  // can't be crossed (bridges can). Returns the tiles of the path.
  function cheapestRoad(from, to) {
    const dist = new Float64Array(size * size).fill(Infinity);
    const prev = new Int32Array(size * size).fill(-1);
    const start = from.ty * size + from.tx;
    const goal = to.ty * size + to.tx;
    const buckets = [[start]];
    dist[start] = 0;
    for (let d = 0; d < buckets.length && dist[goal] > d; d++) {
      for (const cur of buckets[d] ?? []) {
        if (dist[cur] !== d) continue;
        const cx = cur % size;
        const cy = Math.floor(cur / size);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inMap(nx, ny) || tileAt(nx, ny) === Terrain.WATER || tileAt(nx, ny) === Terrain.CRYSTAL) continue;
          const r = resourceAt.get(`${nx},${ny}`);
          if (r && r.type !== ResourceType.WOOD && r.type !== ResourceType.FOOD) continue;
          const isTree = r?.type === ResourceType.WOOD && r.variant !== 'bush';
          const nd = d + (isTree ? (r.base === null ? TREE_CUT_COST : BASE_TREE_CUT_COST) : 1);
          const ni = ny * size + nx;
          if (nd >= dist[ni]) continue;
          dist[ni] = nd;
          prev[ni] = cur;
          (buckets[nd] ??= []).push(ni);
        }
      }
    }
    const path = [];
    for (let i = goal; i !== -1; i = prev[i]) path.push([i % size, Math.floor(i / size)]);
    return path;
  }

  return { seed, tiles, resources: [...resourceAt.values()] };

  // ---- Crystal outcrops (spirit dimension) ----
  // Every outcrop is placed at all bases (or between every pair of neighbouring bases) or at none, so
  // the map stays fair; each is nudged around its spot until its whole blob fits on open ground away
  // from rivers, bridges, bases and the centre without cutting any base off from the others
  function addCrystals() {
    const spawnAngles = spawnTiles.map((s) => Math.atan2(s.ty - center, s.tx - center));
    const ringRadius = spawnTiles.length
      ? spawnTiles.reduce((sum, s) => sum + Math.hypot(s.tx - center, s.ty - center), 0) / spawnTiles.length
      : size * 0.36;
    const wetNear = (tx, ty, d) => {
      for (let y = ty - d; y <= ty + d; y++)
        for (let x = tx - d; x <= tx + d; x++) if (inMap(x, y) && isWet(x, y)) return true;
      return false;
    };
    const crystalNear = (tx, ty, d) => {
      for (let y = ty - d; y <= ty + d; y++)
        for (let x = tx - d; x <= tx + d; x++) if (inMap(x, y) && tileAt(x, y) === Terrain.CRYSTAL) return true;
      return false;
    };
    // Cells of a slightly irregular, turned elliptical blob around (cx, cy)
    const blob = (cx, cy, r) => {
      const turn = rng() * Math.PI, sx = 0.8 + rng() * 0.4, sy = 0.8 + rng() * 0.4;
      const cells = [];
      const reach = Math.ceil(r * 1.3);
      for (let y = Math.round(cy) - reach; y <= Math.round(cy) + reach; y++)
        for (let x = Math.round(cx) - reach; x <= Math.round(cx) + reach; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          const u = (dx * Math.cos(turn) + dy * Math.sin(turn)) / sx, v = (-dx * Math.sin(turn) + dy * Math.cos(turn)) / sy;
          if (Math.hypot(u, v) <= r) cells.push([x, y]);
        }
      return cells;
    };
    // Every base and the centre can still reach the first base (4-connected, rivers crossed on bridges)
    const connected = () => {
      if (clearTiles.length < 2) return true;
      const seen = new Uint8Array(size * size);
      const queue = [clearTiles[0].ty * size + clearTiles[0].tx];
      seen[queue[0]] = 1;
      for (let q = 0; q < queue.length; q++) {
        const cur = queue[q], cx = cur % size, cy = (cur - cx) / size;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy, ni = ny * size + nx;
          if (!inMap(nx, ny) || seen[ni] || tileAt(nx, ny) === Terrain.WATER || tileAt(nx, ny) === Terrain.CRYSTAL) continue;
          seen[ni] = 1;
          queue.push(ni);
        }
      }
      return clearTiles.every((t) => seen[t.ty * size + t.tx]);
    };
    // Tries to put an outcrop of radius r near (cx, cy) (polar nudges around it); returns its cells
    const place = (cx, cy, r, minClear) => {
      for (let tries = 0; tries < 60; tries++) {
        const a = tries * 2.4, d = Math.sqrt(tries) * 1.2 * Math.max(1, r / 3); // big ones may wander further
        const cells = blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r);
        const ok = cells.length && cells.every(([x, y]) => x >= 2 && y >= 2 && x < size - 2 && y < size - 2
          && !nearBridge.has(`${x},${y}`) && !wetNear(x, y, CRYSTAL_RIVER_GAP) && !crystalNear(x, y, CRYSTAL_GAP)
          && distToClear(x, y) > minClear);
        if (!ok) continue;
        for (const [x, y] of cells) tiles[y * size + x] = Terrain.CRYSTAL;
        if (connected()) return cells;
        for (const [x, y] of cells) tiles[y * size + x] = Terrain.GRASS;
      }
      return null;
    };
    const keepAllOrNone = (placed) => {
      if (placed.every(Boolean)) return true;
      for (const cells of placed) for (const [x, y] of cells ?? []) tiles[y * size + x] = Terrain.GRASS;
      return false;
    };
    // An outcrop that doesn't fit at every spot is tried again a size smaller
    const SHRINK = [1, 0.8, 0.62, 0.48];
    for (const { r, angle, distance } of BASE_CRYSTALS) {
      SHRINK.some((k) => keepAllOrNone(spawnTiles.map((s) => {
        const a = Math.atan2(center - s.ty, center - s.tx) + angle;
        return place(s.tx + 0.5 + Math.cos(a) * distance, s.ty + 0.5 + Math.sin(a) * distance, r * k, 9);
      })));
    }
    // Neutral ones halfway (in angle) between each pair of neighbouring bases
    const sorted = [...spawnAngles].sort((a, b) => a - b);
    const between = sorted.length > 1
      ? sorted.map((a, i) => (i + 1 < sorted.length ? (a + sorted[i + 1]) / 2 : (a + sorted[0] + Math.PI * 2) / 2))
      : sorted.map((a) => a + Math.PI);
    const gap = sorted.length > 1 ? (Math.PI * 2) / sorted.length : Math.PI;
    for (const { r, ring, shift = 0 } of NEUTRAL_CRYSTALS) {
      SHRINK.some((k) => keepAllOrNone(between.map((b) => {
        const a = b + shift * gap;
        return place(center + Math.cos(a) * ringRadius * ring, center + Math.sin(a) * ringRadius * ring, r * k, 16);
      })));
    }
  }
}
