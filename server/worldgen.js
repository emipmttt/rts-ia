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
const SPAWN_CLEAR_RADIUS = 7; // tiles kept free of trees around each town center (room to build)
// Every base gets exactly the same resources around it, so starts are fair
const BASE_TREES = 64;
const BASE_FOREST_ANGLE = 1.25; // radians // two forests, this far to either side of the direction to the map centre
const BASE_FOREST_DISTANCE = 9.5; // tiles from the town center to each forest's middle
const BASE_GOLD_MINES = 2;
const BASE_STONE_MINES = 1;
const BASE_SHEEP = 8;
// Neutral resources between the bases, scaled with the map area (per 1000 tiles)
const FOREST_CLUMPS_PER_1000 = 3;
const CLUMP_TREES = [8, 18]; // min, max
const GOLD_MINES_PER_1000 = 4;
const STONE_MINES_PER_1000 = 3;
const SHEEP_PER_1000 = 7;
const BUSHES_PER_1000 = 10;
const NEUTRAL_MIN_DISTANCE = 13; // neutral resources stay this far from bases and the centre
// Rivers: one running across the map and one running down it, between the bases and the centre,
// crossable only over their bridges
const RIVER_WIDTH = 2;
const RIVER_POSITIONS = [0.28, 0.29, 0.3, 0.7, 0.71, 0.72]; // middle line, as a fraction of the map side
const RIVER_BRIDGES = 4;
const BRIDGE_WIDTH = 2;
const RIVER_CLEARANCE = 11; // rivers stay this far from bases and the centre
const TREE_CUT_COST = 8; // how much a road prefers going around a forest over cutting through it
const BASE_TREE_CUT_COST = 200; // a base's own trees are only cut when there is no other way, to keep starts fair

/**
 * Generates the terrain grid and the resource tiles.
 * @param {number} seed
 * @param {number} size map side in tiles
 * @param {{x: number, y: number}[]} spawnPoints world coordinates of each town center
 * @param {{x: number, y: number}[]} clearPoints extra spots kept free of trees and sand (e.g. the central town center)
 * @returns {{ seed, tiles: number[], resources: {id, type, variant, tx, ty, x, y, amount, max}[] }}
 */
export function generateWorld(seed, size, spawnPoints, clearPoints = []) {
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
  const isFree = (tx, ty) => inMap(tx, ty) && !resourceAt.has(`${tx},${ty}`) && !isWet(tx, ty);
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
        const lo = Math.min(middle(u), middle(Math.max(0, u - 1))) - Math.floor(RIVER_WIDTH / 2);
        const hi = Math.max(middle(u), middle(Math.max(0, u - 1))) + Math.ceil(RIVER_WIDTH / 2) - 1;
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

  // Sand roads (cosmetic)
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (!isWet(tx, ty) && Math.abs(height(tx, ty)) < ROAD_WIDTH && distToClear(tx, ty) > SPAWN_CLEAR_RADIUS) {
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

  // Mines are 2x2 tile clusters on dry, empty ground
  const placeMine = (type, tx, ty) => {
    const cells = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]];
    if (!cells.every(([x, y]) => x >= 1 && y >= 1 && x < size - 1 && y < size - 1 && isFree(x, y))) return false;
    if (cells.some(([x, y]) => nearBridge.has(`${x},${y}`) || distToClear(x, y) <= SPAWN_CLEAR_RADIUS - 1)) return false;
    for (const [x, y] of cells) {
      tiles[y * size + x] = Terrain.GRASS;
      addResource(type, x, y);
    }
    return true;
  };

  // ---- Fair resources around every base ----
  const center = size / 2;
  spawnTiles.forEach((s, index) => {
    base = index;
    const toCenter = Math.atan2(center - s.ty, center - s.tx);
    const at = (angle, d) => [Math.round(s.tx + Math.cos(angle) * d), Math.round(s.ty + Math.sin(angle) * d)];

    // Two forests of exactly BASE_TREES / 2 trees each
    for (const side of [-1, 1]) {
      const [fx, fy] = at(toCenter + side * BASE_FOREST_ANGLE, BASE_FOREST_DISTANCE);
      growPatch(fx, fy, BASE_TREES / 2, (x, y) => addResource(ResourceType.WOOD, x, y));
    }

    // Mines in front of the base, between the two forests (behind and beside a corner base is the map
    // edge), each nudged until it lands on free ground: gold left and right, stone further ahead
    const mines = [
      [ResourceType.GOLD, toCenter - 0.5, 7.5], [ResourceType.GOLD, toCenter + 0.5, 7.5],
      [ResourceType.STONE, toCenter, 10],
    ].slice(0, BASE_GOLD_MINES + BASE_STONE_MINES);
    for (const [type, angle, distance] of mines) {
      for (let tries = 0; tries < 80; tries++) {
        const [mx, my] = at(angle + (((tries % 9) - 4) * 0.15), distance + Math.floor(tries / 9) * 0.6);
        if (placeMine(type, mx - 1, my - 1)) break;
      }
    }

    // Sheep grazing next to the town center
    let sheep = 0;
    for (let d = 3; d < 7 && sheep < BASE_SHEEP; d++) {
      for (let k = 0; k < 12 && sheep < BASE_SHEEP; k++) {
        const [x, y] = at(toCenter + Math.PI / 2 + (k / 12) * Math.PI * 2, d);
        if (isFree(x, y) && !nearBridge.has(`${x},${y}`)) { addResource(ResourceType.FOOD, x, y, 'sheep'); sheep++; }
      }
    }
  });
  base = null;

  // ---- Neutral resources ----
  const far = (tx, ty) => distToClear(tx, ty) >= NEUTRAL_MIN_DISTANCE;
  const scatter = (count, place) => {
    for (let placed = 0, tries = 0; placed < count && tries < count * 200; tries++) {
      const [tx, ty] = randomTile();
      if (far(tx, ty) && place(tx, ty)) placed++;
    }
  };
  scatter(per1000(FOREST_CLUMPS_PER_1000), (tx, ty) => {
    const trees = CLUMP_TREES[0] + Math.floor(rng() * (CLUMP_TREES[1] - CLUMP_TREES[0]));
    return growPatch(tx, ty, trees, (x, y) => addResource(ResourceType.WOOD, x, y), (x, y) => canGrow(x, y) && far(x, y)) > 0;
  });
  scatter(per1000(GOLD_MINES_PER_1000), (tx, ty) => placeMine(ResourceType.GOLD, tx, ty));
  scatter(per1000(STONE_MINES_PER_1000), (tx, ty) => placeMine(ResourceType.STONE, tx, ty));
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
          if (!inMap(nx, ny) || tileAt(nx, ny) === Terrain.WATER) continue;
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
}
