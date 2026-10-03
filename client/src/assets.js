import { Assets, Rectangle, Texture } from 'pixi.js';
import { FACTIONS } from '../../shared/constants.js';

const BASE = '/assets';

// Unit sprite sheets: horizontal strips of square frames (frame count = width / frame size)
const UNIT_SHEETS = {
  pawn_idle: 192, pawn_run: 192, pawn_run_wood: 192, pawn_run_gold: 192,
  pawn_run_meat: 192, pawn_axe: 192, pawn_pickaxe: 192, pawn_hammer: 192, pawn_knife: 192,
  warrior_idle: 192, warrior_run: 192, warrior_attack: 192,
  archer_idle: 192, archer_run: 192, archer_shoot: 192,
  lancer_idle: 320, lancer_run: 320, lancer_attack: 320,
};
const BUILDINGS = ['castle', 'barracks', 'archery', 'monastery', 'tower', 'house1', 'house2', 'house3'];
const TREE_COUNT = 4;
const GOLD_COUNT = 6;
const BUSH_COUNT = 4;
// Particle strips: name -> frame size
const FX = {
  dust1: 64, dust2: 64, fire1: 64, fire2: 64, fire3: 64, explosion1: 192, explosion2: 192,
};

// Splits a horizontal strip into frames of frameWidth x full height
function sliceStrip(texture, frameWidth) {
  const count = Math.floor(texture.width / frameWidth);
  return Array.from({ length: count }, (_, i) => new Texture({
    source: texture.source,
    frame: new Rectangle(i * frameWidth, 0, frameWidth, texture.height),
  }));
}

/**
 * Loads every texture the game needs.
 * @returns {{
 *   units: Record<string, Record<string, Texture[]>>,  // faction -> sheet -> frames
 *   buildings: Record<string, Record<string, Texture>>, // faction -> building -> texture
 *   trees: Texture[][], bushes: Texture[][], gold: Texture[], sheep: { idle, grass: Texture[] },
 *   fx: Record<string, Texture[]>, grass: Texture, arrow: Texture
 * }}
 */
export async function loadAssets() {
  const urls = [];
  for (const { id } of FACTIONS) {
    for (const sheet of Object.keys(UNIT_SHEETS)) urls.push(`${BASE}/${id}/${sheet}.png`);
    for (const b of BUILDINGS) urls.push(`${BASE}/${id}/${b}.png`);
  }
  for (let i = 1; i <= TREE_COUNT; i++) urls.push(`${BASE}/terrain/tree${i}.png`);
  for (let i = 1; i <= GOLD_COUNT; i++) urls.push(`${BASE}/terrain/gold${i}.png`);
  for (let i = 1; i <= BUSH_COUNT; i++) urls.push(`${BASE}/terrain/bush${i}.png`);
  for (const name of Object.keys(FX)) urls.push(`${BASE}/fx/${name}.png`);
  urls.push(
    `${BASE}/terrain/tilemap.png`, `${BASE}/terrain/arrow.png`,
    `${BASE}/terrain/sheep_idle.png`, `${BASE}/terrain/sheep_grass.png`,
  );

  const tex = await Assets.load(urls);

  const units = {};
  const buildings = {};
  for (const { id } of FACTIONS) {
    units[id] = {};
    for (const [sheet, frame] of Object.entries(UNIT_SHEETS)) {
      units[id][sheet] = sliceStrip(tex[`${BASE}/${id}/${sheet}.png`], frame);
    }
    buildings[id] = Object.fromEntries(BUILDINGS.map((b) => [b, tex[`${BASE}/${id}/${b}.png`]]));
  }

  const trees = [];
  for (let i = 1; i <= TREE_COUNT; i++) trees.push(sliceStrip(tex[`${BASE}/terrain/tree${i}.png`], 192));
  const gold = [];
  for (let i = 1; i <= GOLD_COUNT; i++) gold.push(tex[`${BASE}/terrain/gold${i}.png`]);
  const bushes = [];
  for (let i = 1; i <= BUSH_COUNT; i++) bushes.push(sliceStrip(tex[`${BASE}/terrain/bush${i}.png`], 128));
  const sheep = {
    idle: sliceStrip(tex[`${BASE}/terrain/sheep_idle.png`], 128),
    grass: sliceStrip(tex[`${BASE}/terrain/sheep_grass.png`], 128),
  };
  const fx = Object.fromEntries(Object.entries(FX).map(([name, size]) => [name, sliceStrip(tex[`${BASE}/fx/${name}.png`], size)]));

  // Plain grass tile from the middle of the tileset's flat-ground block
  const tilemap = tex[`${BASE}/terrain/tilemap.png`];
  const grass = new Texture({ source: tilemap.source, frame: new Rectangle(64, 64, 64, 64) });

  return {
    units, buildings, trees, bushes, gold, sheep, fx, grass, arrow: tex[`${BASE}/terrain/arrow.png`],
  };
}
