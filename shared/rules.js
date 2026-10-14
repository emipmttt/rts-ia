import {
  ENTITY_STATS, TILE_SIZE, RESOURCE_NAMES,
} from './constants.js';

export const isBuildingType = (type) => ENTITY_STATS[type]?.kind === 'building';
export const isUnitType = (type) => ENTITY_STATS[type]?.kind === 'unit';

export const buildingSize = (type) => ENTITY_STATS[type].tiles * TILE_SIZE;

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

// Top-left tiles of the pieces of a wall dragged from (x0, y0) to (x1, y1): pieces `step` tiles wide
// joined side to side in an 8-connected line (diagonal steps touch at the corners, which units can't
// squeeze through), at most `max` pieces
export function wallLine(x0, y0, x1, y1, max = 20, step = 2) {
  const cells = [];
  const ex = Math.round((x1 - x0) / step), ey = Math.round((y1 - y0) / step);
  const n = Math.max(Math.abs(ex), Math.abs(ey));
  for (let i = 0; i <= n && cells.length < max; i++) {
    const t = n ? i / n : 0;
    cells.push([x0 + step * Math.round(ex * t), y0 + step * Math.round(ey * t)]);
  }
  return cells.filter(([x, y], i) => i === 0 || x !== cells[i - 1][0] || y !== cells[i - 1][1]);
}
