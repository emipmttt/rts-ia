import { Assets, Rectangle, Texture } from 'pixi.js';
import { FACTIONS } from '../../shared/constants.js';
import {
  buildRigFrames, FRAME_W, FRAME_H, RIG_NAMES,
} from './pixelRig.js';

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
const GOLD_COUNT = 6;
const STONE_COUNT = 4;
const BUSH_COUNT = 4;
// Particle strips: name -> frame size
const FX = {
  dust1: 64, dust2: 64, fire1: 64, fire2: 64, fire3: 64, explosion1: 192, explosion2: 192,
};

// Bakes a procedural rig's animations into one nearest-filtered strip texture per animation
function rigSheets(rig, teamColor) {
  return Object.fromEntries(Object.entries(buildRigFrames(rig, teamColor)).map(([name, frames]) => {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W * frames.length;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d');
    frames.forEach((f, i) => ctx.putImageData(new ImageData(f, FRAME_W, FRAME_H), i * FRAME_W, 0));
    const strip = Texture.from(canvas);
    strip.source.scaleMode = 'nearest';
    return [`${rig}_${name}`, sliceStrip(strip, FRAME_W)];
  }));
}

// Foliage variants: hue shift (degrees), saturation and lightness multipliers. The last ones are
// autumn orange; the game picks those for only a few trees.
export const TREE_TINTS = [
  { h: 0, s: 1, l: 1 },
  { h: -12, s: 1.05, l: 1.08 },
  { h: 14, s: 0.9, l: 0.92 },
  { h: 6, s: 1.15, l: 1.02 },
  { h: -118, s: 1.5, l: 1.25 },
  { h: -128, s: 1.6, l: 1.15 },
];
export const AUTUMN_TINTS = 2; // how many tints at the end of TREE_TINTS are orange

const rgbToHsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
const hslToRgb = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
};

// Copies a texture with only its green pixels (the leaves) shifted; the trunk keeps its colours
function recolorFoliage(texture, { h, s, l }) {
  const img = texture.source.resource;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3] || px[i + 1] < px[i] + 20) continue; // only clearly green pixels
    const [hh, ss, ll] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    [px[i], px[i + 1], px[i + 2]] = hslToRgb((hh + h + 360) % 360, Math.min(1, ss * s), Math.min(1, ll * l));
  }
  ctx.putImageData(data, 0, 0);
  const out = Texture.from(canvas);
  out.source.scaleMode = 'nearest';
  return out;
}

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
 *   trees: Texture[][], bushes: Texture[][], gold: Texture[], stone: Texture[], sheep: { idle, grass: Texture[] },
 *   fx: Record<string, Texture[]>, grass: Texture, sand: Texture, water: Texture[], arrow: Texture
 * }}
 */
export async function loadAssets() {
  const urls = [];
  for (const { id } of FACTIONS) {
    for (const sheet of Object.keys(UNIT_SHEETS)) urls.push(`${BASE}/${id}/${sheet}.png`);
    for (const b of BUILDINGS) urls.push(`${BASE}/${id}/${b}.png`);
  }
  const TREES = ['pine', 'oak'];
  for (const name of TREES) urls.push(`${BASE}/terrain/${name}.png`);
  for (let i = 1; i <= GOLD_COUNT; i++) urls.push(`${BASE}/terrain/gold${i}.png`);
  for (let i = 1; i <= STONE_COUNT; i++) urls.push(`${BASE}/terrain/stone${i}.png`);
  for (let i = 1; i <= BUSH_COUNT; i++) urls.push(`${BASE}/terrain/bush${i}.png`);
  for (const name of Object.keys(FX)) urls.push(`${BASE}/fx/${name}.png`);
  urls.push(`${BASE}/fx/air_blast.png`);
  urls.push(
    `${BASE}/terrain/grass_tile.png`, `${BASE}/terrain/sand_tile.png`, `${BASE}/terrain/water_tile.png`, `${BASE}/terrain/arrow.png`,
    `${BASE}/terrain/sheep_idle.png`, `${BASE}/terrain/sheep_grass.png`,
  );

  const tex = await Assets.load(urls);

  const units = {};
  const buildings = {};
  for (const { id, color } of FACTIONS) {
    units[id] = Object.assign({}, ...RIG_NAMES.map((rig) => rigSheets(rig, color)));
    for (const [sheet, frame] of Object.entries(UNIT_SHEETS)) {
      units[id][sheet] = sliceStrip(tex[`${BASE}/${id}/${sheet}.png`], frame);
    }
    buildings[id] = Object.fromEntries(BUILDINGS.map((b) => [b, tex[`${BASE}/${id}/${b}.png`]]));
  }

  // 16x32 pixel-art trees, each in several foliage colours: trees[kind][variant]
  const trees = TREES.map((name) => TREE_TINTS.map((tint) => recolorFoliage(tex[`${BASE}/terrain/${name}.png`], tint)));
  const gold = [];
  for (let i = 1; i <= GOLD_COUNT; i++) gold.push(tex[`${BASE}/terrain/gold${i}.png`]);
  const stone = [];
  for (let i = 1; i <= STONE_COUNT; i++) stone.push(tex[`${BASE}/terrain/stone${i}.png`]);
  const bushes = [];
  for (let i = 1; i <= BUSH_COUNT; i++) bushes.push(sliceStrip(tex[`${BASE}/terrain/bush${i}.png`], 128));
  const sheep = {
    idle: sliceStrip(tex[`${BASE}/terrain/sheep_idle.png`], 128),
    grass: sliceStrip(tex[`${BASE}/terrain/sheep_grass.png`], 128),
  };
  const fx = Object.fromEntries(Object.entries(FX).map(([name, size]) => [name, sliceStrip(tex[`${BASE}/fx/${name}.png`], size)]));
  // Pixel-art air explosion: 6 frames of 32px in a 2x3 grid, read row by row
  const airBlast = tex[`${BASE}/fx/air_blast.png`];
  airBlast.source.scaleMode = 'nearest';
  fx.airBlast = Array.from({ length: 6 }, (_, i) => new Texture({
    source: airBlast.source, frame: new Rectangle((i % 2) * 32, Math.floor(i / 2) * 32, 32, 32),
  }));

  // 16px pixel-art ground tiles, kept crisp when scaled up
  const grass = tex[`${BASE}/terrain/grass_tile.png`];
  const sand = tex[`${BASE}/terrain/sand_tile.png`];
  grass.source.scaleMode = 'nearest';
  // Water: 2 animation frames stacked vertically, copied out to their own textures so they tile
  const waterImg = tex[`${BASE}/terrain/water_tile.png`].source.resource;
  const water = [0, 1].map((i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.getContext('2d').drawImage(waterImg, 0, i * 16, 16, 16, 0, 0, 16, 16);
    const t = Texture.from(canvas);
    t.source.scaleMode = 'nearest';
    return t;
  });
  sand.source.scaleMode = 'nearest';

  return {
    units, buildings, trees, bushes, gold, stone, sheep, fx, grass, sand, water, arrow: tex[`${BASE}/terrain/arrow.png`],
  };
}
