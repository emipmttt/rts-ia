import { MAP_WIDTH, MAP_HEIGHT, SPAWN_MARGIN } from '../shared/constants.js';

const m = SPAWN_MARGIN;
const W = MAP_WIDTH;
const H = MAP_HEIGHT;

// Corners first (opposite corners for 2 players), then edge midpoints
const SPAWN_POINTS = [
  { x: m, y: m },
  { x: W - m, y: H - m },
  { x: W - m, y: m },
  { x: m, y: H - m },
  { x: W / 2, y: m },
  { x: W / 2, y: H - m },
  { x: m, y: H / 2 },
  { x: W - m, y: H / 2 },
];

// Returns one spawn point per player, in a shuffled player order
export function assignSpawns(playerIds) {
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  return new Map(shuffled.map((id, i) => [id, SPAWN_POINTS[i]]));
}
