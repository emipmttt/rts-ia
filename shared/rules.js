import { ENTITY_STATS, MAP_TILES, TILE_SIZE } from './constants.js';

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
export function canPlace(type, tx, ty, isBlocked) {
  return footprint(type, tx, ty).every(([x, y]) => (
    x >= 0 && y >= 0 && x < MAP_TILES && y < MAP_TILES && !isBlocked(x, y)
  ));
}

export const canAfford = (stock, cost) => Object.entries(cost).every(([k, v]) => (stock?.[k] ?? 0) >= v);

export const formatCost = (cost) => Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ');
