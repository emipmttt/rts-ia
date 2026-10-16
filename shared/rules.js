import {
  ENTITY_STATS, TILE_SIZE, RESOURCE_NAMES, AGE_RANGE_BONUS,
} from './constants.js';

export const isBuildingType = (type) => ENTITY_STATS[type]?.kind === 'building';
export const isUnitType = (type) => ENTITY_STATS[type]?.kind === 'unit';

export const buildingSize = (type) => ENTITY_STATS[type].tiles * TILE_SIZE;

// Range of a building that shoots, grown with its owner's age (1..3)
export const buildingRange = (type, age = 1) => ENTITY_STATS[type].attack.range + AGE_RANGE_BONUS * Math.max(0, (age ?? 1) - 1);

// World-space centre of a building whose top-left tile is (tx, ty)
export function buildingCenter(type, tx, ty) {
  const half = ENTITY_STATS[type].tiles / 2;
  return { x: (tx + half) * TILE_SIZE, y: (ty + half) * TILE_SIZE };
}

// Top-left tile for a building centred as close as possible to (x, y)
export function tileForCenter(type, x, y) {
  const half = ENTITY_STATS[type].tiles / 2;
  return { tx: Math.round(x / TILE_SIZE - half), ty: Math.round(y / TILE_SIZE - half) };
}

export function footprint(type, tx, ty) {
  const n = ENTITY_STATS[type].tiles;
  const cells = [];
  for (let y = ty; y < ty + n; y++) for (let x = tx; x < tx + n; x++) cells.push([x, y]);
  return cells;
}

// isBlocked(x, y) -> true when the tile has a resource or building
export function canPlace(type, tx, ty, isBlocked, mapTiles) {
  return footprint(type, tx, ty).every(([x, y]) => (
    x >= 0 && y >= 0 && x < mapTiles && y < mapTiles && !isBlocked(x, y)
  ));
}

export const canAfford = (stock, cost) => Object.entries(cost).every(([k, v]) => (stock?.[k] ?? 0) >= v);

export const formatCost = (cost) => Object.entries(cost).map(([k, v]) => `${v} ${RESOURCE_NAMES[k] ?? k}`).join(', ');

// Wall pieces and gates sit on a fixed grid of `step` x `step` cells, so pieces placed apart (or a
// gate dropped into a wall) always line up and join
export const snapWall = (v, step = 2) => Math.floor(v / step) * step;

// Tiles a wall piece at (tx, ty) takes: the free ones of its cell. A piece fills round trees, mines,
// water and buildings so a wall run up against them leaves no gap; isWallBlocked(x, y) -> true for those
export function wallCells(tx, ty, isWallBlocked, mapTiles) {
  return footprint('wall', tx, ty).filter(([x, y]) => x >= 0 && y >= 0 && x < mapTiles && y < mapTiles && !isWallBlocked(x, y));
}

// Top-left tiles of the pieces of a wall dragged from (x0, y0) to (x1, y1): pieces `step` tiles wide
// on the wall grid, joined side to side in an 8-connected line (diagonal steps touch at the corners,
// which units can't squeeze through), at most `max` pieces
export function wallLine(x0, y0, x1, y1, max = 20, step = 2) {
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map((v) => snapWall(v, step));
  const cells = [];
  const ex = Math.round((x1 - x0) / step), ey = Math.round((y1 - y0) / step);
  const n = Math.max(Math.abs(ex), Math.abs(ey));
  for (let i = 0; i <= n && cells.length < max; i++) {
    const t = n ? i / n : 0;
    cells.push([x0 + step * Math.round(ex * t), y0 + step * Math.round(ey * t)]);
  }
  return cells.filter(([x, y], i) => i === 0 || x !== cells[i - 1][0] || y !== cells[i - 1][1]);
}
