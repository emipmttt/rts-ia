// Builds the earth civilization's town center: a low-poly walled-city palace (a red-brown
// brick terrace with jade panels and front stairs, a three-storey hall under stacked hipped roofs with
// upturned corners, and two tapered watchtowers at the front corners), paints it in pixel art with a
// normal map and writes the game's copy (Assets/Resources/models/center_earth.bytes). Roofs use the
// team green, which the game swaps for the player's colour. Front is +z.
// Run from the repo root: node unity/Tools/build-earth-center.mjs
import { writeFileSync } from 'node:fs';
import { hex, team, isTeam, hash, norm, paintAtlas, normalMap, projectFaces, writeGlb, MeshBuilder, midPivot, writeAges, useDensity } from './model-kit.mjs';

// One file per age: center_earth_a1, center_earth, center_earth_a3
const OUT = (suffix) => new URL(`../Assets/Resources/models/center_earth${suffix}.bytes`, import.meta.url);
const PREVIEW = new URL('models/center_earth_paint.png', import.meta.url);
const NORMAL_PREVIEW = new URL('models/center_earth_normal.png', import.meta.url);
const D = 10; // texels per model unit, as in the other town centers
const ATLAS = 256;

// ---------- Palette ----------
const P = {
  brick: hex(0x8a4a32), brickLight: hex(0xa35a3c), brickDark: hex(0x6b3624), mortar: hex(0x55291b),
  jade: hex(0x5f9a6e), jadeLight: hex(0x86bf8f), jadeDark: hex(0x3e6e4c),
  column: hex(0xe9e2cf), columnShade: hex(0xc8bea6),
  window: hex(0x2a1d16), lattice: hex(0x5a3b26),
  stone: hex(0xbfb6a3), stoneLight: hex(0xd6cebd), stoneDark: hex(0x958b78), seam: hex(0x7a705e),
  wood: hex(0x6b4423), woodDark: hex(0x4a2e17),
  gold: hex(0xffd34d), goldDark: hex(0xc99a2e), goldLight: hex(0xfff3b0),
};

// ---------- Painters ----------

function bricks(r, y0 = 0, y1 = r.h) {
  for (let y = y0; y < y1; y++) {
    const row = Math.floor(y / 2);
    for (let x = 0; x < r.w; x++) {
      const n = hash(Math.floor((x + (row % 2) * 2) / 4), row);
      let c = n < 0.2 ? P.brickDark : n > 0.85 ? P.brickLight : P.brick;
      if (y % 2 === 1 || (x + (row % 2) * 2) % 4 === 0) c = P.mortar;
      r.set(x, y, c);
    }
  }
}

// Jade panel with a gold frame and a gold medallion in the middle
function jadePanel(r, cx, y0, w, h) {
  r.fill(cx - w / 2 - 1, y0 - 1, w + 2, h + 2, P.goldDark);
  r.fill(cx - w / 2, y0, w, h, P.jade);
  r.fill(cx - w / 2, y0 + h - 1, w, 1, P.jadeLight);
  r.fill(cx - w / 2, y0, w, 1, P.jadeDark);
  const my = y0 + Math.floor(h / 2);
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (Math.abs(x) + Math.abs(y) < 2) r.set(cx + x, my + y, P.gold);
}

// Terrace walls: brick with a row of jade panels and a stone coping
function terrace(r) {
  bricks(r);
  r.fill(0, r.h - 2, r.w, 1, P.stoneDark);
  r.fill(0, r.h - 1, r.w, 1, P.stoneLight);
  for (let k = -4; k <= 4; k++) jadePanel(r, r.w / 2 + k * 10, 3, 5, r.h - 7);
}

// Hall walls: brick between white columns, dark lattice windows, gold beam on top. The front has
// the jade gate with a gold medallion
function hallWall(r, gate) {
  bricks(r);
  r.fill(0, r.h - 2, r.w, 1, P.goldDark);
  r.fill(0, r.h - 1, r.w, 1, P.gold);
  r.fill(0, 0, r.w, 1, P.stoneDark);
  const cx = r.w / 2;
  for (let k = -5; k <= 5; k++) {
    const px = cx + k * 6;
    r.fill(px - 1, 1, 2, r.h - 3, P.column);
    r.fill(px, 1, 1, r.h - 3, P.columnShade);
    if (k === 5) continue;
    for (let y = 4; y < r.h - 4; y++)
      for (let x = px + 2; x <= px + 4; x++) r.set(x, y, (x + y) % 2 ? P.window : P.lattice);
  }
  if (!gate) return;
  const gw = 8, gh = 9;
  r.fill(cx - gw / 2 - 1, 1, gw + 2, gh + 2, P.goldDark);
  r.fill(cx - gw / 2, 1, gw, gh, P.jadeDark);
  r.fill(cx - gw / 2 + 1, 1, gw - 2, gh - 1, P.jade);
  r.fill(cx - 1, 1, 1, gh - 1, P.jadeDark);
  r.fill(cx - 2, gh - 3, 4, 2, P.gold);
}

// Watchtowers: tapered brick with a tall jade panel
function towerWall(r) {
  bricks(r);
  r.fill(0, r.h - 2, r.w, 2, P.stoneLight);
  r.fill(0, 0, r.w, 2, P.stoneDark);
  jadePanel(r, r.w / 2, 5, 7, r.h - 12);
}

// Rows of tiles in team green, lit at the top of each row; gold ridge trim at the eave
function roof(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const k = y % 3, seam = x % 3 === 0;
      r.set(x, y, k === 2 ? team(1) : seam ? team(0.66) : k === 1 ? team(0.86) : team(0.74));
    }
  r.fill(0, 0, r.w, 1, P.goldDark);
  r.fill(0, 1, r.w, 1, P.gold);
}

function under(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x % 4 === 0 ? P.woodDark : P.wood);
}

// Courtyard paving with a jade-edged processional way down the middle
function pave(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const n = hash(x >> 3, y >> 2);
      r.set(x, y, x % 8 === 0 || y % 4 === 0 ? P.seam : n < 0.25 ? P.stoneDark : P.stone);
    }
  const cx = r.w / 2;
  r.fill(cx - 7, 0, 14, r.h, P.stoneLight);
  r.fill(cx - 9, 0, 2, r.h, P.jade);
  r.fill(cx + 7, 0, 2, r.h, P.jade);
}

function stairs(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, y % 2 ? P.stoneLight : P.stoneDark);
  r.fill(0, 0, 2, r.h, P.stoneDark);
  r.fill(r.w - 2, 0, 2, r.h, P.stoneDark);
}

function gold(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, x < r.w / 3 ? P.goldLight : P.gold);
}

const REGIONS = {
  // Third-age banners (writeAges)
  post: { w: 10, h: 40, paint: (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 ? hex(0x6a5240) : hex(0x4e3c30)); } },
  banner: { w: 12, h: 14, paint: (r) => { r.fill(0, 0, r.w, r.h, team(0.85)); r.fill(0, 0, r.w, 1, team(0.6)); r.fill(4, 5, 4, 4, team(1)); } },
  pave: { w: 96, h: 92, paint: pave },
  terrace: { w: 96, h: 14, paint: terrace },
  roof: { w: 84, h: 24, paint: roof },
  under: { w: 84, h: 24, paint: under },
  wall: { w: 68, h: 18, paint: (r) => hallWall(r, false) },
  gate: { w: 68, h: 18, paint: (r) => hallWall(r, true) },
  tower: { w: 22, h: 42, paint: towerWall },
  stairs: { w: 26, h: 22, paint: stairs },
  gold: { w: 14, h: 10, paint: gold },
};

// Relief per palette colour (1 = proud, 0 = deep opening)
function heightOf(c) {
  const is = (k) => c[0] === k[0] && c[1] === k[1] && c[2] === k[2];
  if (is(P.window)) return 0;
  if (is(P.lattice) || is(P.mortar)) return 0.3;
  if (is(P.seam) || is(P.woodDark) || is(P.jadeDark)) return 0.4;
  if (is(P.stoneDark) || is(P.goldDark) || is(P.brickDark)) return 0.6;
  if (is(P.column) || is(P.gold) || is(P.goldLight) || is(P.jadeLight)) return 1;
  if (isTeam(c)) return Math.max(0.3, (c[1] / 255 - 0.6) * 1.75);
  return 0.8;
}

// ---------- Geometry ----------
const mesh = new MeshBuilder();
const { tri } = mesh;

// Rectangle ring counter-clockwise from the front-right corner: 4 corners, or 8 points with the
// edge midpoints when `mids` is set; `lift` raises the corners (upturned eaves)
function rect(cx, cz, hw, hd, y, lift = 0, mids = false) {
  const c = [[hw, hd], [-hw, hd], [-hw, -hd], [hw, -hd]];
  const pts = [];
  c.forEach(([x, z], i) => {
    pts.push([cx + x, y + lift, cz + z]);
    if (mids) {
      const [nx, nz] = c[(i + 1) % 4];
      pts.push([cx + (x + nx) / 2, y, cz + (z + nz) / 2]);
    }
  });
  return pts;
}

// Hall storeys under stacked hipped roofs; the top roof closes on a short ridge with gold ends
function hall(cx, cz, y, storeys) {
  mesh.part++;
  const center = [cx, 0, cz];
  storeys.forEach(({ hw, hd, height, eave, lift, rise }, i) => {
    mesh.band(rect(cx, cz, hw, hd, y), rect(cx, cz, hw, hd, y + height), center, (n) => i === 0 && n[2] > 0.9 ? 'gate' : 'wall');
    y += height;
    const edge = rect(cx, cz, hw + eave, hd + eave, y - 0.1, lift, true);
    mesh.band(edge, rect(cx, cz, hw, hd, y, 0, true), center, () => 'under', true, undefined, midPivot(edge));
    const next = storeys[i + 1];
    y += rise;
    if (next) {
      mesh.band(edge, rect(cx, cz, next.hw, next.hd, y, 0, true), center, () => 'roof', false, undefined, midPivot(edge));
      return;
    }
    const ridgeW = Math.max(0.05, hw - hd), top = rect(cx, cz, ridgeW, 0.05, y, 0, true);
    mesh.band(edge, top, center, () => 'roof', false, undefined, midPivot(edge));
    mesh.cap(top, 'gold');
    // Gold pearl ornaments on the ridge ends and centre
    for (const ox of [-ridgeW, 0, ridgeW]) {
      const base = [cx + ox, y, cz], tip = [cx + ox, y + (ox ? 0.35 : 0.55), cz];
      rect(cx + ox, cz, 0.1, 0.1, y).forEach((p, k, a) => {
        const q = a[(k + 1) % 4];
        tri(p, q, tip, 'gold', norm([p[0] + q[0] - 2 * base[0], 0.3, p[2] + q[2] - 2 * base[2]]));
      });
    }
  });
}

// Tapered watchtower with a small hipped roof and a gold finial
function watchtower(cx, cz, y) {
  mesh.part++;
  const center = [cx, 0, cz], h = 3.4;
  mesh.band(rect(cx, cz, 0.85, 0.85, y), rect(cx, cz, 0.7, 0.7, y + h), center, () => 'tower');
  y += h;
  const edge = rect(cx, cz, 1.05, 1.05, y - 0.08, 0.25, true);
  mesh.band(edge, rect(cx, cz, 0.7, 0.7, y, 0, true), center, () => 'under', true, undefined, midPivot(edge));
  const mid = rect(cx, cz, 0.45, 0.45, y + 0.5, 0, true);
  mesh.band(edge, mid, center, () => 'roof', false, undefined, midPivot(edge));
  const edge2 = rect(cx, cz, 0.62, 0.62, y + 0.45, 0.18, true);
  const apex = rect(cx, cz, 0.05, 0.05, y + 1.05, 0, true);
  mesh.band(edge2, apex, center, () => 'roof', false, undefined, midPivot(edge2));
  mesh.band(edge2, mid, center, () => 'under', true, undefined, midPivot(edge2));
  const tip = [cx, y + 1.6, cz];
  rect(cx, cz, 0.06, 0.06, y + 1.05).forEach((p, k, a) => {
    const q = a[(k + 1) % 4];
    tri(p, q, tip, 'gold', norm([p[0] + q[0] - 2 * cx, 0.1, p[2] + q[2] - 2 * cz]));
  });
}

// Brick terrace with a paved top and a wide stair up the front
const TERRACE = 1.0;
mesh.part++;
mesh.band(rect(0, 0, 4.4, 4.2, 0), rect(0, 0, 4.1, 3.9, TERRACE), [0, 0, 0], () => 'terrace');
mesh.cap(rect(0, 0, 4.1, 3.9, TERRACE), 'pave');
mesh.part++;
{
  const w = 1.1, z0 = 3.9, z1 = 5.2;
  const a = [w, TERRACE, z0], b = [-w, TERRACE, z0], c = [-w, 0, z1], d = [w, 0, z1];
  tri(a, b, c, 'stairs', [0, 0.7, 1]);
  tri(a, c, d, 'stairs', [0, 0.7, 1]);
  // Sides of the stair
  tri(a, d, [w, 0, z0], 'terrace', [1, 0, 0]);
  tri(b, [-w, 0, z0], c, 'terrace', [-1, 0, 0]);
}

hall(0, -0.6, TERRACE, [
  { hw: 3.0, hd: 2.3, height: 1.45, eave: 0.7, lift: 0.3, rise: 0.55 },
  { hw: 2.35, hd: 1.75, height: 1.2, eave: 0.6, lift: 0.28, rise: 0.5 },
  { hw: 1.7, hd: 1.2, height: 1.05, eave: 0.55, lift: 0.28, rise: 1.05 },
]);
watchtower(-3.3, 2.9, TERRACE);
watchtower(3.3, 2.9, TERRACE);

// ---------- Paint and write ----------
useDensity('center_earth', mesh.tris, D);
const rgba = paintAtlas(ATLAS, REGIONS);
const { texture, normalTexture } = writeAges(OUT, 'center_earth', 'EarthPalace', mesh.tris, REGIONS, D, ATLAS, rgba, heightOf, 0.8, 'earth');
writeFileSync(PREVIEW, texture);
writeFileSync(NORMAL_PREVIEW, normalTexture);
console.log(`Built the earth palace: ${mesh.tris.length} triangles, ${ATLAS}x${ATLAS} atlas`);
