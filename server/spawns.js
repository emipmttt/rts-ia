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

// Teammates take neighbouring spots on the ring (players without a team are shuffled in on their own)
export function assignSpawns(playerIds, size, teamOf = () => 0) {
  const points = spawnPoints(size, playerIds.length);
  const order = new Map(playerIds.map((id) => [id, Math.random()]));
  const teamKey = new Map([...new Set(playerIds.map(teamOf))].map((t) => [t, Math.random()]));
  const key = (id) => (teamOf(id) ? teamKey.get(teamOf(id)) : order.get(id));
  const shuffled = [...playerIds].sort((a, b) => key(a) - key(b) || order.get(a) - order.get(b));
  return new Map(shuffled.map((id, i) => [id, points[i]]));
}
