import { SPAWN_RING, TILE_SIZE } from '../shared/constants.js';

// Bases sit on a ring around the map centre, evenly spaced and turned at random (like Age of
// Empires' land maps): well inside the map, with room behind them for woodlines. Snapped to the
// middle of a tile. `size` is the map side in px.
const spawnPoints = (size, count) => {
  const turn = Math.random() * Math.PI * 2;
  const r = size * SPAWN_RING;
  return Array.from({ length: count }, (_, i) => {
    const a = turn + (i / count) * Math.PI * 2;
    const snap = (v) => (Math.floor(v / TILE_SIZE) + 0.5) * TILE_SIZE;
    return { x: snap(size / 2 + Math.cos(a) * r), y: snap(size / 2 + Math.sin(a) * r) };
  });
};

// Returns one spawn point per player, in a shuffled player order
export function assignSpawns(playerIds, size) {
  const points = spawnPoints(size, playerIds.length);
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  return new Map(shuffled.map((id, i) => [id, points[i]]));
}
