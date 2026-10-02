import {
  MAP_TILES, TILE_SIZE, Terrain, ResourceType, RESOURCE_STATS,
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
const RANDOM_GOLD_MINES = 6;
const GOLD_MIN_DISTANCE_FROM_SPAWN = 9;

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
  const addResource = (type, tx, ty) => {
    const r = {
      id: nextId++,
      type,
      tx,
      ty,
      x: (tx + 0.5) * TILE_SIZE,
      y: (ty + 0.5) * TILE_SIZE,
      amount: RESOURCE_STATS[type].amount,
    };
    resourceAt.set(`${tx},${ty}`, r);
  };

  // Terrain + forests
  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      const h = height(tx, ty);
      const nearSpawn = distToClear(tx, ty) <= SPAWN_CLEAR_RADIUS;
      if (Math.abs(h) < ROAD_WIDTH && !nearSpawn) tiles[ty * MAP_TILES + tx] = Terrain.SAND;
      else if (h > TREE_HEIGHT && !nearSpawn) addResource(ResourceType.WOOD, tx, ty);
    }
  }

  // Gold mines are 2x2 tile clusters; they replace any trees under them
  const placeGoldMine = (tx, ty) => {
    if (tx < 1 || ty < 1 || tx + 2 >= MAP_TILES || ty + 2 >= MAP_TILES) return false;
    const cells = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]];
    if (cells.some(([x, y]) => resourceAt.get(`${x},${y}`)?.type === ResourceType.GOLD)) return false;
    for (const [x, y] of cells) {
      tiles[y * MAP_TILES + x] = Terrain.GRASS;
      addResource(ResourceType.GOLD, x, y);
    }
    return true;
  };

  // One fair mine per player, between their base and the map centre
  const center = MAP_TILES / 2;
  for (const s of spawnTiles) {
    const angle = Math.atan2(center - s.ty, center - s.tx) + (rng() - 0.5) * 1.2;
    placeGoldMine(Math.round(s.tx + Math.cos(angle) * 7), Math.round(s.ty + Math.sin(angle) * 7));
  }

  // Random mines elsewhere, away from bases
  for (let placed = 0, tries = 0; placed < RANDOM_GOLD_MINES && tries < 500; tries++) {
    const tx = Math.floor(rng() * MAP_TILES);
    const ty = Math.floor(rng() * MAP_TILES);
    if (distToClear(tx, ty) < GOLD_MIN_DISTANCE_FROM_SPAWN) continue;
    if (placeGoldMine(tx, ty)) placed++;
  }

  return { seed, tiles, resources: [...resourceAt.values()] };
}
