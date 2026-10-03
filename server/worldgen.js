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
const RANDOM_GOLD_MINES = 6;
const GOLD_MIN_DISTANCE_FROM_SPAWN = 9;
// Every base gets two guaranteed tree strips, whatever the noise did around it
const STRIP_ANGLE = Math.PI / 3; // each strip sits this far to either side of the direction to the map centre
const STRIP_START = 6; // tiles from the town center
const STRIP_LENGTH = 6;
const STRIP_WIDTH = 2;
const BASE_SHEEP = 4;
const RANDOM_SHEEP = 10;
const BUSHES = 40;

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

  const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < MAP_TILES && ty < MAP_TILES;
  const isFree = (tx, ty) => inMap(tx, ty) && !resourceAt.has(`${tx},${ty}`);

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

  return { seed, tiles, resources: [...resourceAt.values()] };
}
