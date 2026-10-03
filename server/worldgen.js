import {
  MAP_TILES, TILE_SIZE, Terrain, ResourceType, RESOURCE_STATS, BUSH_WOOD,
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
const ROAD_WIDTH = 0.045; // |height| below this = sand road (the noise "valleys")
const TREE_HEIGHT = 0.28; // height above this = forest
const SPAWN_CLEAR_RADIUS = 5; // tiles kept free of trees around each town center
const RANDOM_GOLD_MINES = 20;
const GOLD_MIN_DISTANCE_FROM_SPAWN = 8;
const BASE_GOLD_MINES = 2; // per player, one toward the map centre and one off to the side
// Rivers: one running across the map and one running down it, sitting between the bases and the
// centre, each crossable only over its bridges
const RIVER_WIDTH = 2;
const RIVER_OFFSETS = [14, 15, 16, 44, 45, 46]; // tile row/column of the river's middle line
const RIVER_BRIDGES = 4;
const BRIDGE_WIDTH = 2;
const RIVER_CLEARANCE = SPAWN_CLEAR_RADIUS + 2; // rivers stay this far from bases and the centre
// Every base gets two guaranteed tree strips, whatever the noise did around it
const STRIP_ANGLE = Math.PI / 3; // each strip sits this far to either side of the direction to the map centre
const STRIP_START = 6; // tiles from the town center
const STRIP_LENGTH = 6;
const STRIP_WIDTH = 2;
const BASE_SHEEP = 4;
const RANDOM_SHEEP = 10;
const BUSHES = 40;
const TREE_CUT_COST = 8; // how much a road prefers going around a forest over cutting through it

/**
 * Generates the terrain grid and the resource tiles.
 * @param {number} seed
 * @param {{x: number, y: number}[]} spawnPoints world coordinates of each town center
 * @param {{x: number, y: number}[]} clearPoints extra spots kept free of trees and sand (e.g. the central town center)
 * @returns {{ seed, tiles: number[], resources: {id, type, tx, ty, x, y, amount}[] }}
 */
export function generateWorld(seed, spawnPoints, clearPoints = []) {
  const rng = mulberry32(seed);
  const noise = createPerlin(rng);
  const height = (tx, ty) => {
    const x = tx * NOISE_SCALE;
    const y = ty * NOISE_SCALE;
    return noise(x, y) * 0.75 + noise(x * 2, y * 2) * 0.25;
  };

  const tiles = new Array(MAP_TILES * MAP_TILES).fill(Terrain.GRASS);
  const resourceAt = new Map(); // "tx,ty" -> resource
  const spawnTiles = spawnPoints.map((p) => ({ tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) }));
  const distToSpawn = (tx, ty) => Math.min(...spawnTiles.map((s) => Math.hypot(s.tx - tx, s.ty - ty)));
  const clearTiles = [...spawnTiles, ...clearPoints.map((p) => ({ tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) }))];
  const distToClear = (tx, ty) => Math.min(...clearTiles.map((s) => Math.hypot(s.tx - tx, s.ty - ty)));

  let nextId = 1;
  const addResource = (type, tx, ty, variant = null) => {
    const amount = variant === 'bush' ? BUSH_WOOD : RESOURCE_STATS[type].amount;
    const r = {
      id: nextId++,
      type,
      variant,
      tx,
      ty,
      x: (tx + 0.5) * TILE_SIZE,
      y: (ty + 0.5) * TILE_SIZE,
      amount,
      max: amount,
    };
    resourceAt.set(`${tx},${ty}`, r);
  };

  const tileAt = (tx, ty) => tiles[ty * MAP_TILES + tx];
  const isWet = (tx, ty) => tileAt(tx, ty) === Terrain.WATER || tileAt(tx, ty) === Terrain.BRIDGE;
  const nearBridge = new Set(); // tiles at either end of a bridge are kept free of trees
  for (const axis of ['x', 'y']) addRiver(axis);

  // A sine-shaped river. Along the river, `u` is the coordinate it flows along and `v` the one across.
  function addRiver(axis) {
    const toTile = (u, v) => (axis === 'x' ? [u, v] : [v, u]);
    for (let attempt = 0; attempt < 40; attempt++) {
      const base = RIVER_OFFSETS[Math.floor(rng() * RIVER_OFFSETS.length)];
      const amplitude = 1 + rng() * 2.5;
      const freq = 0.08 + rng() * 0.08;
      const phase = rng() * Math.PI * 2;
      const middle = (u) => Math.round(base + amplitude * Math.sin(u * freq + phase));
      // Each column spans from its own middle to the previous one's so the river has no diagonal gaps
      const columns = [];
      for (let u = 0; u < MAP_TILES; u++) {
        const lo = Math.min(middle(u), middle(Math.max(0, u - 1))) - Math.floor(RIVER_WIDTH / 2);
        const hi = Math.max(middle(u), middle(Math.max(0, u - 1))) + Math.ceil(RIVER_WIDTH / 2) - 1;
        columns.push([lo, hi]);
      }
      const cells = columns.flatMap(([lo, hi], u) => Array.from({ length: hi - lo + 1 }, (_, k) => toTile(u, lo + k)));
      if (cells.some(([tx, ty]) => distToClear(tx, ty) < RIVER_CLEARANCE)) continue;
      for (const [tx, ty] of cells) tiles[ty * MAP_TILES + tx] = Terrain.WATER;

      // Bridges spread along the river, skipping spots where the other river crosses
      const spacing = MAP_TILES / RIVER_BRIDGES;
      for (let b = 0; b < RIVER_BRIDGES; b++) {
        let start = Math.round(spacing * (b + 0.5) - BRIDGE_WIDTH / 2);
        const crossesOther = (u) => {
          const [lo, hi] = columns[u];
          const [x0, y0] = toTile(u, lo - 1);
          const [x1, y1] = toTile(u, hi + 1);
          return [[x0, y0], [x1, y1]].some(([x, y]) => x >= 0 && y >= 0 && x < MAP_TILES && y < MAP_TILES && isWet(x, y));
        };
        while (start < MAP_TILES - BRIDGE_WIDTH && [...Array(BRIDGE_WIDTH).keys()].some((k) => crossesOther(start + k))) start++;
        for (let u = start; u < start + BRIDGE_WIDTH && u < MAP_TILES; u++) {
          const [lo, hi] = columns[u];
          for (let v = lo; v <= hi; v++) {
            const [tx, ty] = toTile(u, v);
            if (tileAt(tx, ty) === Terrain.WATER) tiles[ty * MAP_TILES + tx] = Terrain.BRIDGE;
          }
          for (let v = lo - 2; v <= hi + 2; v++) nearBridge.add(toTile(u, v).join(','));
        }
      }
      return;
    }
  }

  // Terrain + forests
  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (isWet(tx, ty)) continue;
      const h = height(tx, ty);
      const nearSpawn = distToClear(tx, ty) <= SPAWN_CLEAR_RADIUS || nearBridge.has(`${tx},${ty}`);
      if (Math.abs(h) < ROAD_WIDTH && !nearSpawn) tiles[ty * MAP_TILES + tx] = Terrain.SAND;
      else if (h > TREE_HEIGHT && !nearSpawn) addResource(ResourceType.WOOD, tx, ty);
    }
  }

  // Gold mines are 2x2 tile clusters; they replace any trees under them
  const placeGoldMine = (tx, ty) => {
    if (tx < 1 || ty < 1 || tx + 2 >= MAP_TILES || ty + 2 >= MAP_TILES) return false;
    const cells = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]];
    if (cells.some(([x, y]) => resourceAt.get(`${x},${y}`)?.type === ResourceType.GOLD || isWet(x, y))) return false;
    for (const [x, y] of cells) {
      tiles[y * MAP_TILES + x] = Terrain.GRASS;
      addResource(ResourceType.GOLD, x, y);
    }
    return true;
  };

  // Fair mines per player near their base, the first toward the map centre; nudged until they land on dry ground
  const center = MAP_TILES / 2;
  for (const s of spawnTiles) {
    const toCenter = Math.atan2(center - s.ty, center - s.tx);
    for (let m = 0; m < BASE_GOLD_MINES; m++) {
      for (let tries = 0; tries < 20; tries++) {
        const angle = toCenter + (m ? (m % 2 ? 1 : -1) * 1.6 : 0) + (rng() - 0.5) * 1.2;
        const d = 6 + rng() * 2;
        if (placeGoldMine(Math.round(s.tx + Math.cos(angle) * d), Math.round(s.ty + Math.sin(angle) * d))) break;
      }
    }
  }

  const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < MAP_TILES && ty < MAP_TILES;
  const isFree = (tx, ty) => inMap(tx, ty) && !resourceAt.has(`${tx},${ty}`) && !isWet(tx, ty);

  // Two radial strips of trees per base, mirrored around the direction to the map centre
  for (const s of spawnTiles) {
    const toCenter = Math.atan2(center - s.ty, center - s.tx);
    for (const side of [-1, 1]) {
      const a = toCenter + side * STRIP_ANGLE;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      for (let d = STRIP_START; d < STRIP_START + STRIP_LENGTH; d++) {
        for (let w = 0; w < STRIP_WIDTH; w++) {
          const tx = Math.round(s.tx + dir.x * d - dir.y * w * side);
          const ty = Math.round(s.ty + dir.y * d + dir.x * w * side);
          if (!isFree(tx, ty)) continue;
          tiles[ty * MAP_TILES + tx] = Terrain.GRASS;
          addResource(ResourceType.WOOD, tx, ty);
        }
      }
    }
    // Sheep behind the town center, away from the map centre
    for (let i = 0; i < BASE_SHEEP; i++) {
      const a = toCenter + Math.PI + (i - (BASE_SHEEP - 1) / 2) * 0.45;
      const tx = Math.round(s.tx + Math.cos(a) * 4);
      const ty = Math.round(s.ty + Math.sin(a) * 4);
      if (isFree(tx, ty)) addResource(ResourceType.FOOD, tx, ty);
    }
  }

  // Random mines elsewhere, away from bases
  for (let placed = 0, tries = 0; placed < RANDOM_GOLD_MINES && tries < 500; tries++) {
    const tx = Math.floor(rng() * MAP_TILES);
    const ty = Math.floor(rng() * MAP_TILES);
    if (distToClear(tx, ty) < GOLD_MIN_DISTANCE_FROM_SPAWN) continue;
    if (placeGoldMine(tx, ty)) placed++;
  }

  // Wandering sheep and decorative (but choppable) bushes on open grass
  const scatter = (count, minDistance, place) => {
    for (let placed = 0, tries = 0; placed < count && tries < 2000; tries++) {
      const tx = Math.floor(rng() * MAP_TILES);
      const ty = Math.floor(rng() * MAP_TILES);
      if (!isFree(tx, ty) || tiles[ty * MAP_TILES + tx] !== Terrain.GRASS || distToClear(tx, ty) < minDistance) continue;
      place(tx, ty);
      placed++;
    }
  };
  scatter(RANDOM_SHEEP, GOLD_MIN_DISTANCE_FROM_SPAWN, (tx, ty) => addResource(ResourceType.FOOD, tx, ty));
  scatter(BUSHES, SPAWN_CLEAR_RADIUS - 1, (tx, ty) => addResource(ResourceType.WOOD, tx, ty, 'bush'));

  // Trees are solid, so a forest can wall a base off: cut the cheapest road through the trees from the
  // first base to every other base and to the centre
  const [first, ...others] = clearTiles;
  for (const target of others) {
    for (const [tx, ty] of cheapestRoad(first, target)) {
      const r = resourceAt.get(`${tx},${ty}`);
      if (r?.type === ResourceType.WOOD) resourceAt.delete(`${tx},${ty}`);
    }
  }

  // Dijkstra over 4-connected tiles: open ground costs 1, a tree costs TREE_CUT_COST, water and gold
  // can't be crossed (bridges can). Returns the tiles of the path.
  function cheapestRoad(from, to) {
    const n = MAP_TILES * MAP_TILES;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const start = from.ty * MAP_TILES + from.tx;
    const goal = to.ty * MAP_TILES + to.tx;
    const buckets = [[start]];
    dist[start] = 0;
    for (let d = 0; d < buckets.length; d++) {
      for (const cur of buckets[d] ?? []) {
        if (dist[cur] !== d) continue;
        if (cur === goal) break;
        const cx = cur % MAP_TILES;
        const cy = Math.floor(cur / MAP_TILES);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inMap(nx, ny) || tileAt(nx, ny) === Terrain.WATER) continue;
          const r = resourceAt.get(`${nx},${ny}`);
          if (r?.type === ResourceType.GOLD) continue;
          const nd = d + (r?.type === ResourceType.WOOD && r.variant !== 'bush' ? TREE_CUT_COST : 1);
          const ni = ny * MAP_TILES + nx;
          if (nd >= dist[ni]) continue;
          dist[ni] = nd;
          prev[ni] = cur;
          (buckets[nd] ??= []).push(ni);
        }
      }
      if (dist[goal] <= d) break;
    }
    const path = [];
    for (let i = goal; i !== -1; i = prev[i]) path.push([i % MAP_TILES, Math.floor(i / MAP_TILES)]);
    return path;
  }

  return { seed, tiles, resources: [...resourceAt.values()] };
}
