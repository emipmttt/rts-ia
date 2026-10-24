// Builds the air civilization's town center: a low-poly mountain temple (a rocky peak with
// a paved terrace, a tall white tower wrapped by a spiral band and capped by a flared conical roof and
// a needle spire, slimmer towers around it and white houses with hipped roofs), paints it in pixel
// art with a normal map and writes the game's copy (Assets/Resources/models/center.bytes). Roofs use
// the team green, which the game swaps for the player's colour. Front is +z.
// Run from the repo root: node unity/Tools/build-air-center.mjs
import { writeFileSync } from 'node:fs';
import { hex, team, isTeam, hash, norm, paintAtlas, normalMap, projectFaces, writeGlb, MeshBuilder, writeAges, useDensity, fineRock } from './model-kit.mjs';

// One file per age: center_a1, center, center_a3
const OUT = (suffix) => new URL(`../Assets/Resources/models/center${suffix}.bytes`, import.meta.url);
const PREVIEW = new URL('models/center_air_paint.png', import.meta.url);
const NORMAL_PREVIEW = new URL('models/center_air_normal.png', import.meta.url);
const D = 10; // texels per model unit, as in the fire model
const ATLAS = 256;
const SPIRAL = 18; // texels the spiral band climbs per turn around a tower

// ---------- Palette ----------
const P = {
  white: hex(0xf2efe6), whiteShade: hex(0xdcd8cc), whiteDark: hex(0xb9b5aa), band: hex(0xc9d2da), bandDark: hex(0x9aa7b3),
  window: hex(0x2a2f3a), windowLight: hex(0x47506a),
  rock: hex(0x9a7b5c), rockLight: hex(0xb8977164 >>> 8), rockDark: hex(0x6f553d), crack: hex(0x4e3a29),
  moss: hex(0x5f8a4a), mossDark: hex(0x456b38),
  pave: hex(0xd9d2c2), paveDark: hex(0xb3aa96), seam: hex(0x9a907c),
  wood: hex(0x8b5a2b), woodDark: hex(0x5d3a1e), woodDeep: hex(0x3f2714),
  slate: hex(0x46505c), slateLight: hex(0x6a7684),
  gold: hex(0xffd34d), goldDark: hex(0xc99a2e), goldLight: hex(0xfff3b0),
};

// ---------- Painters ----------

// White plaster with a few shaded patches
function plaster(r, y0 = 0, y1 = r.h) {
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < r.w; x++) {
      const n = hash(x >> 1, y >> 1);
      r.set(x, y, n < 0.08 ? P.whiteShade : P.white);
    }
}

// Tower wall: plaster wrapped by a blue-grey spiral band, with small windows following it. Rows
// repeat every SPIRAL texels so faces shifted by the builder join up into one spiral
function towerWall(r) {
  plaster(r);
  const slope = 0.32;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const k = (((y - x * slope) % SPIRAL) + SPIRAL) % SPIRAL;
      if (k < 1) r.set(x, y, P.bandDark);
      else if (k < 3) r.set(x, y, P.band);
      else if (k >= 7 && k < 9 && x % 3 === 1) r.set(x, y, k < 8 ? P.window : P.windowLight);
    }
  r.fill(0, 0, r.w, 2, P.whiteDark);
}

// Lantern under a tower roof: windows between gold bands
function drum(r) {
  plaster(r);
  r.fill(0, 0, r.w, 1, P.goldDark);
  r.fill(0, r.h - 2, r.w, 1, P.gold);
  r.fill(0, r.h - 1, r.w, 1, P.goldLight);
  for (let x = 1; x < r.w; x += 3) r.fill(x, 2, 1, r.h - 5, P.window);
}

// Rows of tiles in team green, lit at the top of each row; gold-trimmed eave
function roof(r) {
  for (let y = 0; y < r.h; y++) {
    const row = Math.floor(y / 3), k = y % 3;
    for (let x = 0; x < r.w; x++) {
      const seam = (x + (row % 2) * 2) % 4 === 0;
      r.set(x, y, k === 2 ? team(1) : seam ? team(0.66) : k === 1 ? team(0.86) : team(0.74));
    }
  }
  r.fill(0, 0, r.w, 1, team(0.6));
  r.fill(0, 1, r.w, 1, P.gold);
}

function under(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 === 0 ? P.woodDeep : P.woodDark);
}

// Slate needle with gold rings and tip
function spire(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x < r.w / 2 ? P.slateLight : P.slate);
  for (let y = 4; y < r.h - 4; y += 7) r.fill(0, y, r.w, 1, P.gold);
  r.fill(0, r.h - 3, r.w, 3, P.gold);
}

// Weathered rock: pillared cliff stone with crevices and ledges (model-kit fineRock)
const rock = fineRock({ dark: P.rockDark, base: P.rock, light: P.rockLight, high: hex(0xd2b48c), crack: P.crack }, 3);

// Terrace paving: light slabs with a winding path of darker stones
function pave(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const slab = hash(x / 5 | 0, y / 5 | 0);
      r.set(x, y, x % 5 === 0 || y % 5 === 0 ? P.seam : slab < 0.25 ? P.paveDark : P.pave);
    }
  // Path from the front edge winding up to the centre
  for (let y = 0; y < r.h / 2; y++) {
    const cx = r.w / 2 + Math.sin(y / 7) * 8;
    r.fill(Math.round(cx) - 2, y, 4, 1, y % 3 ? P.paveDark : P.seam);
  }
}

// House walls: plaster, wooden lintel band, dark windows; the front has a door
function houseWall(r, door) {
  plaster(r);
  r.fill(0, 0, r.w, 2, P.whiteDark);
  r.fill(0, r.h - 2, r.w, 1, P.woodDark);
  r.fill(0, r.h - 1, r.w, 1, P.wood);
  const cx = r.w / 2;
  for (const dx of [-8, -4, 4, 8]) r.fill(cx + dx - 1, 5, 2, 3, P.window);
  if (door) {
    r.fill(cx - 2, 0, 4, 7, P.wood);
    r.fill(cx - 2, 0, 1, 7, P.woodDark);
    r.fill(cx - 2, 7, 4, 1, P.goldDark);
  } else r.fill(cx - 1, 5, 2, 3, P.window);
}

function gold(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x < r.w / 3 ? P.goldLight : P.gold);
}

const REGIONS = {
  // Third-age banners (writeAges)
  post: { w: 10, h: 40, paint: (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 ? hex(0x6a5240) : hex(0x4e3c30)); } },
  banner: { w: 12, h: 14, paint: (r) => { r.fill(0, 0, r.w, r.h, team(0.85)); r.fill(0, 0, r.w, 1, team(0.6)); r.fill(4, 5, 4, 4, team(1)); } },
  pave: { w: 96, h: 96, paint: pave },
  towerWall: { w: 12, h: 86 + SPIRAL, paint: towerWall },
  rock: { w: 32, h: 26, paint: rock },
  roof: { w: 30, h: 12, paint: roof },
  drum: { w: 12, h: 8, paint: drum },
  under: { w: 30, h: 30, paint: under },
  spire: { w: 6, h: 32, paint: spire },
  houseWall: { w: 24, h: 12, paint: (r) => houseWall(r, false) },
  houseFront: { w: 24, h: 12, paint: (r) => houseWall(r, true) },
  houseRoof: { w: 30, h: 10, paint: roof },
  gold: { w: 6, h: 6, paint: gold },
};

// Relief per palette colour (1 = proud, 0 = deep opening)
function heightOf(c) {
  const is = (k) => c[0] === k[0] && c[1] === k[1] && c[2] === k[2];
  if (is(P.window) || is(P.crack)) return 0;
  if (is(P.windowLight)) return 0.15;
  if (is(P.seam) || is(P.woodDeep) || is(P.rockDark)) return 0.4;
  if (is(P.bandDark) || is(P.paveDark) || is(P.woodDark) || is(P.goldDark)) return 0.6;
  if (is(P.band) || is(P.moss) || is(P.mossDark) || is(P.rockLight)) return 0.95;
  if (isTeam(c)) return Math.max(0.3, (c[1] / 255 - 0.6) * 1.75);
  return 0.8;
}

// ---------- Geometry ----------
const mesh = new MeshBuilder();
const { tri } = mesh;

// Round ring of `n` points; `jitter` roughens it (rock), starting angle puts a face toward +z
function ring(cx, cz, radius, y, n, jitter = 0, seed = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + Math.PI / n + i * 2 * Math.PI / n;
    const r = radius * (1 + (hash(i, seed) - 0.5) * jitter);
    const dy = jitter ? (hash(seed, i) - 0.5) * jitter * 0.8 : 0;
    pts.push([cx + r * Math.cos(a), y + dy, cz + r * Math.sin(a)]);
  }
  return pts;
}

// Rock outcrop with a paved top: a rugged mountainside of several jittered rings bulging out and
// pulling in as they climb, so it breaks into irregular rocky facets instead of one flat wall
function crag(cx, cz, r0, r1, y0, y1, n, seed) {
  mesh.part++;
  const sides = n * 2, steps = 4;
  const rings = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const radius = r0 + (r1 - r0) * Math.pow(t, 0.75);
    const y = y0 + (y1 - y0) * t;
    if (k === steps) { rings.push(ring(cx, cz, r1, y1, sides, 0.12, seed + 1).map((p) => [p[0], y1, p[2]])); continue; }
    // Lumps and hollows: radial jitter that grows toward the middle rows, rows shifted up and down
    const lumpy = ring(cx, cz, radius, y, sides, k ? 0.22 : 0.25, seed * 7 + k * 13);
    rings.push(lumpy.map((p, i) => [p[0], k ? p[1] + (hash(i * 3 + k, seed) - 0.5) * (y1 - y0) / steps * 0.6 : p[1], p[2]]));
  }
  for (let k = 0; k < steps; k++) mesh.band(rings[k], rings[k + 1], [cx, 0, cz], () => 'rock');
  mesh.cap(rings[steps], 'pave');
}

// White tower with the spiral band, a lantern, a flared conical roof and a needle spire
function tower(cx, cz, y, radius, height, sides, spire) {
  mesh.part++;
  const center = [cx, 0, cz];
  const width = 2 * radius * Math.sin(Math.PI / sides) * D; // texels per face
  // Each face starts the band where the previous one left it; the turn doesn't close exactly, so the
  // seam goes at the back (face 0 is in front)
  const shift = (i) => ((((i + sides / 2) % sides) * width * 0.32) % SPIRAL + SPIRAL) % SPIRAL;
  mesh.band(ring(cx, cz, radius, y, sides), ring(cx, cz, radius, y + height, sides), center, () => 'towerWall', false, shift);
  y += height;
  const lantern = 0.35 + radius * 0.2;
  mesh.band(ring(cx, cz, radius * 0.92, y, sides), ring(cx, cz, radius * 0.92, y + lantern, sides), center, () => 'drum');
  mesh.cap(ring(cx, cz, radius, y, sides), 'pave');
  y += lantern;
  // Roof: wide shallow eave, then a steeper cone; underside of the overhang
  const eave = ring(cx, cz, radius * 1.45, y - 0.12, sides);
  mesh.band(eave, ring(cx, cz, radius * 0.92, y, sides), center, () => 'under', true);
  const mid = ring(cx, cz, radius * 0.8, y + radius * 0.35, sides);
  mesh.band(eave, mid, center, () => 'roof');
  const apexY = y + radius * 0.35 + radius * 0.75;
  const top = ring(cx, cz, radius * 0.12, apexY, sides);
  mesh.band(mid, top, center, () => 'roof');
  mesh.cap(top, 'gold');
  // Needle: a slim cone
  const needle = [cx, apexY + spire, cz];
  ring(cx, cz, Math.max(0.05, radius * 0.08), apexY, 4).forEach((p, k, a) => {
    const q = a[(k + 1) % 4];
    tri(p, q, needle, 'spire', norm([p[0] + q[0] - 2 * cx, 0.05, p[2] + q[2] - 2 * cz]));
  });
}

// House: plastered box under a hipped roof with eaves, door on the front (+z) side
function house(cx, cz, y, hw, hd, height) {
  mesh.part++;
  const corners = (w, d, yy) => [[cx + w, yy, cz + d], [cx - w, yy, cz + d], [cx - w, yy, cz - d], [cx + w, yy, cz - d]];
  mesh.band(corners(hw, hd, y), corners(hw, hd, y + height), [cx, 0, cz], (n) => n[2] > 0.9 ? 'houseFront' : 'houseWall');
  const top = y + height, e = 0.22, rise = Math.min(hw, hd) * 0.75;
  const eave = corners(hw + e, hd + e, top - 0.08);
  mesh.cap(eave, 'under', false);
  // Ridge along the longer side
  const long = hw >= hd;
  const ridge = long ? [[cx + hw - hd, top + rise, cz], [cx - hw + hd, top + rise, cz]] : [[cx, top + rise, cz + hd - hw], [cx, top + rise, cz - hd + hw]];
  const [a, b, c, d] = eave;
  if (long) {
    // Front and back trapezoids, end triangles
    tri(a, b, ridge[1], 'houseRoof', [0, 0.6, 1]); tri(a, ridge[1], ridge[0], 'houseRoof', [0, 0.6, 1]);
    tri(c, d, ridge[0], 'houseRoof', [0, 0.6, -1]); tri(c, ridge[0], ridge[1], 'houseRoof', [0, 0.6, -1]);
    tri(b, c, ridge[1], 'houseRoof', [-1, 0.6, 0]);
    tri(d, a, ridge[0], 'houseRoof', [1, 0.6, 0]);
  } else {
    tri(d, a, ridge[0], 'houseRoof', [1, 0.6, 0]); tri(d, ridge[0], ridge[1], 'houseRoof', [1, 0.6, 0]);
    tri(b, c, ridge[1], 'houseRoof', [-1, 0.6, 0]); tri(b, ridge[1], ridge[0], 'houseRoof', [-1, 0.6, 0]);
    tri(a, b, ridge[0], 'houseRoof', [0, 0.6, 1]);
    tri(c, d, ridge[1], 'houseRoof', [0, 0.6, -1]);
  }
}

// The peak: a wide lower terrace and a higher crag behind it carrying the great tower
const LOW = 1.3, HIGH = 3.3;
crag(0, 0, 4.4, 3.8, 0, LOW, 11, 1);
crag(-0.4, -0.9, 2.6, 1.55, LOW, HIGH, 8, 5);
tower(-0.4, -0.9, HIGH, 1.0, 6.8, 10, 2.6);

// Slimmer towers on the lower terrace, houses in front
tower(-2.9, -0.6, LOW, 0.5, 3.4, 8, 1.4);
tower(2.7, -1.6, LOW, 0.55, 4.2, 8, 1.6);
tower(2.9, 1.5, LOW, 0.42, 2.5, 8, 1.1);
house(0.4, 2.3, LOW, 0.85, 0.55, 0.85);
house(-2.1, 2.0, LOW, 0.6, 0.5, 0.75);
house(1.6, 0.2, LOW, 0.5, 0.7, 0.8);

// ---------- Paint and write ----------
useDensity('center', mesh.tris, D);
const rgba = paintAtlas(ATLAS, REGIONS);
const { texture, normalTexture } = writeAges(OUT, 'center', 'AirTemple', mesh.tris, REGIONS, D, ATLAS, rgba, heightOf, 0.8, 'air');
writeFileSync(PREVIEW, texture);
writeFileSync(NORMAL_PREVIEW, normalTexture);
console.log(`Built the air temple: ${mesh.tris.length} triangles, ${ATLAS}x${ATLAS} atlas`);
