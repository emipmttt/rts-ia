// Builds the fire civilization's town center: a low-poly pagoda palace (stone platform, four red tiers with upturned eaves, a gold spire, two small towers on
// carved pedestals in front), paints it in pixel art with a normal map and writes the game's copy
// (Assets/Resources/models/center_fire.bytes). Roof tiles use the team green, which the game swaps
// for the player's colour; walls stay red, black and gold. Front is +z.
// Run from the repo root: node unity/Tools/build-fire-center.mjs
import { writeFileSync } from 'node:fs';
import { hex, team, isTeam, hash, norm, paintAtlas, normalMap, projectFaces, writeGlb, MeshBuilder, midPivot, writeAges, useDensity } from './model-kit.mjs';

// One file per age: center_fire_a1, center_fire, center_fire_a3
const OUT = (suffix) => new URL(`../Assets/Resources/models/center_fire${suffix}.bytes`, import.meta.url);
const PREVIEW = new URL('models/center_fire_paint.png', import.meta.url);
const NORMAL_PREVIEW = new URL('models/center_fire_normal.png', import.meta.url);
const D = 10; // texels per model unit, as in the air model (both are ~9 units wide)
const ATLAS = 256;

// ---------- Palette ----------
const P = {
  red: hex(0xa3241f), redLight: hex(0xc4382c), redDark: hex(0x6e1414),
  black: hex(0x1c1414), lattice: hex(0x3a2420), glow: hex(0xffb347),
  gold: hex(0xffd34d), goldDark: hex(0xc99a2e), goldLight: hex(0xfff3b0),
  stone: hex(0xb59a72), stoneLight: hex(0xcab08a), stoneDark: hex(0x8a7152), seam: hex(0x6e5a40),
  flame: hex(0xff8a2a), flameCore: hex(0xffd34d),
};

// ---------- Painters ----------

// Red wall between gold pillars, with black lattice windows and a beam on top
function wall(r, door) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, hash(x, y) < 0.05 ? P.redLight : P.red);
  r.fill(0, 0, r.w, 2, P.black);
  r.fill(0, r.h - 2, r.w, 1, P.goldDark);
  r.fill(0, r.h - 1, r.w, 1, P.gold);
  const cx = r.w / 2;
  // Pillars every 8 px from the centre, lattice panels between them
  for (let k = -3; k <= 3; k++) {
    const px = cx + k * 8;
    r.fill(px - 1, 2, 2, r.h - 4, P.goldDark);
    r.fill(px - 1, 2, 1, r.h - 4, P.gold);
    if (k === 3) continue;
    const x0 = px + 2, x1 = px + 6;
    for (let y = 5; y < r.h - 4; y++)
      for (let x = x0; x <= x1; x++) r.set(x, y, (x - x0) % 2 === 0 || (y - 5) % 3 === 0 ? P.lattice : P.black);
  }
  if (!door) return;
  // Gate: dark opening in a gold frame with a flame emblem above it
  const dw = 10, dh = 11;
  r.fill(cx - dw / 2 - 1, 0, dw + 2, dh + 1, P.goldDark);
  r.fill(cx - dw / 2, 0, dw, dh, P.black);
  r.fill(cx - 1, 0, 1, dh, P.redDark);
  for (let y = 0; y < 5; y++)
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) > 2 - Math.floor(y / 2)) continue;
      r.set(cx + x, dh + 2 + y, Math.abs(x) < 1 && y < 3 ? P.flameCore : P.flame);
    }
}

// Rows of tiles in team green, lit at the top of each row; gold eave edge
function roof(r) {
  for (let y = 0; y < r.h; y++) {
    const row = Math.floor(y / 3), k = y % 3;
    for (let x = 0; x < r.w; x++) {
      const seam = (x + (row % 2) * 2) % 4 === 0;
      r.set(x, y, k === 2 ? team(1) : seam ? team(0.66) : k === 1 ? team(0.86) : team(0.74));
    }
  }
  r.fill(0, 0, r.w, 1, P.goldDark);
  r.fill(0, 1, r.w, 2, P.gold);
  r.fill(0, 3, r.w, 1, P.redDark);
}

// Dark red rafters under the eaves
function under(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x % 4 === 0 ? P.black : x % 4 === 1 ? P.redDark : hex(0x4a0f0f));
}

// Wide stone steps around the platform, gold rail at the top
function platform(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const step = y % 3;
      r.set(x, y, step === 0 ? P.seam : step === 2 ? P.stoneLight : hash(x >> 2, y) < 0.2 ? P.stoneDark : P.stone);
    }
  r.fill(0, r.h - 2, r.w, 1, P.goldDark);
  r.fill(0, r.h - 1, r.w, 1, P.gold);
}

// Courtyard paving: big stone slabs
function floor(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const slab = hash(x >> 3, y >> 3);
      r.set(x, y, x % 8 === 0 || y % 8 === 0 ? P.seam : slab < 0.25 ? P.stoneDark : slab > 0.8 ? P.stoneLight : P.stone);
    }
}

// Pedestals carved with gold meanders
function pedestal(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, P.stone);
  r.fill(0, 0, r.w, 2, P.stoneDark);
  r.fill(0, r.h - 2, r.w, 2, P.goldDark);
  r.fill(0, r.h - 1, r.w, 1, P.gold);
  // Interlocking hooks
  for (let y = 4; y < r.h - 4; y++)
    for (let x = 2; x < r.w - 2; x++) {
      const u = (x - 2) % 6, v = (y - 4) % 6;
      const line = (v === 0 && u < 5) || (u === 4 && v < 4) || (v === 3 && u > 1 && u < 5) || (u === 2 && v === 2);
      if (line) r.set(x, y, P.gold);
      else if (u === 5 || v === 5) r.set(x, y, P.stoneDark);
    }
}

function gold(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x < r.w / 3 ? P.goldLight : y % 5 === 0 ? P.goldDark : P.gold);
}

const REGIONS = {
  // Third-age banners (writeAges)
  post: { w: 10, h: 40, paint: (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 ? hex(0x6a5240) : hex(0x4e3c30)); } },
  banner: { w: 12, h: 14, paint: (r) => { r.fill(0, 0, r.w, r.h, team(0.85)); r.fill(0, 0, r.w, 1, team(0.6)); r.fill(4, 5, 4, 4, team(1)); } },
  floor: { w: 86, h: 86, paint: floor },
  platform: { w: 92, h: 16, paint: platform },
  roof: { w: 68, h: 26, paint: roof },
  under: { w: 68, h: 30, paint: under },
  wall: { w: 48, h: 24, paint: (r) => wall(r, false) },
  gate: { w: 48, h: 24, paint: (r) => wall(r, true) },
  pedestal: { w: 26, h: 20, paint: pedestal },
  gold: { w: 12, h: 26, paint: gold },
};

// Relief per palette colour (1 = proud, 0 = deep opening)
function heightOf(c) {
  const is = (k) => c[0] === k[0] && c[1] === k[1] && c[2] === k[2];
  if (is(P.black)) return 0;
  if (is(P.lattice)) return 0.3;
  if (is(P.seam) || is(P.redDark)) return 0.35;
  if (is(P.stoneDark) || is(P.goldDark)) return 0.6;
  if (is(P.gold) || is(P.goldLight)) return 1;
  if (isTeam(c)) return Math.max(0.3, (c[1] / 255 - 0.6) * 1.75);
  return 0.8;
}

// ---------- Geometry ----------
const mesh = new MeshBuilder();
const { tri } = mesh;

// Square ring (corners at 45 degrees, faces toward +-x and +-z): 4 corners, or 8 points with the
// mid-edges when `mids` is set. `lift` raises the corners (upturned eaves)
function ring(cx, cz, half, y, lift = 0, mids = false) {
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    pts.push([cx + Math.SQRT2 * half * Math.cos(a), y + lift, cz + Math.SQRT2 * half * Math.sin(a)]);
    if (mids) {
      const m = a + Math.PI / 4;
      pts.push([cx + half * Math.cos(m), y, cz + half * Math.sin(m)]);
    }
  }
  return pts;
}

const band = (...a) => mesh.band(...a);
const cap = (...a) => mesh.cap(...a);

// Pagoda: tiers of walls, each under an upturned roof; ends in a gold spire. Returns the top y
function pagoda(cx, cz, y, tiers, front) {
  mesh.part++;
  const center = [cx, 0, cz];
  const wallRegion = (gate) => (n) => gate && n[2] > 0.9 ? 'gate' : 'wall';
  tiers.forEach(({ half, height, eave, lift, rise }, i) => {
    // Walls
    band(ring(cx, cz, half, y), ring(cx, cz, half, y + height), center, wallRegion(front && i === 0));
    y += height;
    // Underside of the eave and the roof above it, both from the upturned eave ring
    const edge = ring(cx, cz, half + eave, y - 0.1, lift, true);
    band(edge, ring(cx, cz, half, y, 0, true), center, () => 'under', true, undefined, midPivot(edge));
    const next = tiers[i + 1];
    const top = next ? next.half : half * 0.25;
    y += rise;
    band(edge, ring(cx, cz, top, y, 0, true), center, () => 'roof', false, undefined, midPivot(edge));
    if (!next) {
      // Gold finial: a small pyramid then a needle
      const base = ring(cx, cz, top, y);
      cap(base, 'roof');
      const apex = [cx, y + 0.5, cz];
      ring(cx, cz, top * 0.6, y).forEach((p, k, a) => tri(p, a[(k + 1) % 4], apex, 'gold', norm([p[0] + a[(k + 1) % 4][0] - 2 * cx, 0.5, p[2] + a[(k + 1) % 4][2] - 2 * cz])));
      const needle = [cx, y + 0.5 + tiers.spire, cz];
      ring(cx, cz, 0.06, y + 0.45).forEach((p, k, a) => tri(p, a[(k + 1) % 4], needle, 'gold', norm([p[0] + a[(k + 1) % 4][0] - 2 * cx, 0.1, p[2] + a[(k + 1) % 4][2] - 2 * cz])));
      y = needle[1];
    }
  });
  return y;
}

// Stone platform with sloped sides and a paved top
const PLATFORM = 4.3, PLATFORM_TOP = 3.9, PLATFORM_H = 1.1;
band(ring(0, 0, PLATFORM, 0), ring(0, 0, PLATFORM_TOP, PLATFORM_H), [0, 0, 0], () => 'platform');
cap(ring(0, 0, PLATFORM_TOP, PLATFORM_H), 'floor');

// Main pagoda, set back a little so the side towers flank its gate
const main = [
  { half: 2.2, height: 2.0, eave: 0.85, lift: 0.5, rise: 0.6 },
  { half: 1.75, height: 1.65, eave: 0.75, lift: 0.45, rise: 0.55 },
  { half: 1.35, height: 1.45, eave: 0.65, lift: 0.4, rise: 0.5 },
  { half: 1.0, height: 1.3, eave: 0.6, lift: 0.38, rise: 0.7 },
];
main.spire = 2.2;
pagoda(0, -0.9, PLATFORM_H, main, true);

// Side towers on carved pedestals at the front corners
for (const sx of [-2.85, 2.85]) {
  const cz = 2.5, ph = 1.3;
  mesh.part++;
  band(ring(sx, cz, 0.95, PLATFORM_H), ring(sx, cz, 0.82, PLATFORM_H + ph), [sx, 0, cz], () => 'pedestal');
  cap(ring(sx, cz, 0.82, PLATFORM_H + ph), 'floor');
  const side = [
    { half: 0.62, height: 1.0, eave: 0.4, lift: 0.28, rise: 0.35 },
    { half: 0.45, height: 0.85, eave: 0.34, lift: 0.24, rise: 0.45 },
  ];
  side.spire = 1.0;
  pagoda(sx, cz, PLATFORM_H + ph, side, false);
}

// ---------- Paint and write ----------
useDensity('center_fire', mesh.tris, D);
const rgba = paintAtlas(ATLAS, REGIONS);
const { texture, normalTexture } = writeAges(OUT, 'center_fire', 'FireCenter', mesh.tris, REGIONS, D, ATLAS, rgba, heightOf, 0.8, 'fire');
writeFileSync(PREVIEW, texture);
writeFileSync(NORMAL_PREVIEW, normalTexture);
console.log(`Built the fire town center: ${mesh.tris.length} triangles, ${ATLAS}x${ATLAS} atlas`);
