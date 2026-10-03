import { SPAWN_MARGIN } from '../shared/constants.js';

// Corners first (opposite corners for 2 players), then edge midpoints, for a square map of side `size` px
const spawnPoints = (size) => {
  const m = SPAWN_MARGIN;
  return [
    { x: m, y: m },
    { x: size - m, y: size - m },
    { x: size - m, y: m },
    { x: m, y: size - m },
    { x: size / 2, y: m },
    { x: size / 2, y: size - m },
    { x: m, y: size / 2 },
    { x: size - m, y: size / 2 },
  ];
};

// Returns one spawn point per player, in a shuffled player order
export function assignSpawns(playerIds, size) {
  const points = spawnPoints(size);
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  return new Map(shuffled.map((id, i) => [id, points[i]]));
}
