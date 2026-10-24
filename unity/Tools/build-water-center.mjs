// Builds the water civilization's town center: a low-poly ice palace in a polar style
// (an ice-block platform, a stepped temple of shrinking storeys with arched windows crowned by a dome,
// a stair up its front, two halls under barrel vaults and a pair of totem pillars), paints it in
// pixel art with a normal map and writes the game's copy (Assets/Resources/models/center_water.bytes).
// The dome and vaults use the team green, which the game swaps for the player's colour. Front is +z.
// Run from the repo root: node unity/Tools/build-water-center.mjs
import { writeFileSync } from 'node:fs';
import { hex, team, isTeam, hash, norm, paintAtlas, normalMap, projectFaces, writeGlb, MeshBuilder, writeAges, useDensity } from './model-kit.mjs';

// One file per age: center_water_a1, center_water, center_water_a3
const OUT = (suffix) => new URL(`../Assets/Resources/models/center_water${suffix}.bytes`, import.meta.url);
const PREVIEW = new URL('models/center_water_paint.png', import.meta.url);
const NORMAL_PREVIEW = new URL('models/center_water_normal.png', import.meta.url);
const D = 10; // texels per model unit, as in the other town centers
const ATLAS = 256;

// ---------- Palette ----------
const P = {
  ice: hex(0xe6f0f7), iceLight: hex(0xf8fbfd), iceShade: hex(0xc4d6e4), iceDark: hex(0x93adc4), iceDeep: hex(0x5f7f9c),
  window: hex(0x24384f), windowLight: hex(0x3f6185),
  snow: hex(0xf4f7fa), snowShade: hex(0xdbe5ee),
  water: hex(0x4a8fc4), waterLight: hex(0x8cc8ee),
  wood: hex(0x7a5a3c), woodDark: hex(0x553d27),
};

// ---------- Painters ----------

// Ice blocks: offset courses with blue-grey joints
function iceBlocks(r, course = 4, block = 8) {
  for (let y = 0; y < r.h; y++) {
    const row = Math.floor(y / course);
    for (let x = 0; x < r.w; x++) {
      const bx = x + (row % 2) * (block / 2);
      const n = hash(Math.floor(bx / block), row);
      let c = n < 0.2 ? P.iceShade : n > 0.8 ? P.iceLight : P.ice;
      if (y % course === course - 1 || bx % block === 0) c = P.iceDark;
      r.set(x, y, c);
    }
  }
}

// Arched window: dark opening with a lighter arch line and a pale sill
function arch(r, cx, y, w = 3, h = 5) {
  const x0 = cx - Math.floor(w / 2);
  r.fill(x0, y, w, h - 1, P.window);
  r.fill(x0 + 1, y + h - 1, w - 2, 1, P.window);
  r.fill(x0, y + h - 2, 1, 1, P.windowLight);
  r.fill(x0 + w - 1, y + h - 2, 1, 1, P.windowLight);
  r.fill(x0 - 1, y - 1, w + 2, 1, P.iceLight);
}

// Platform walls: big ice blocks with a frozen waterfall channel at the front middle
function platform(r) {
  iceBlocks(r, 5, 10);
  r.fill(0, r.h - 2, r.w, 2, P.snow);
  for (let k = -4; k <= 4; k++) r.fill(r.w / 2 + k * 10 - 1, 0, 2, r.h - 2, P.iceDark);
}

// Temple storeys: ice blocks with a row of arched windows and a snowy ledge on top
function templeWall(r, door) {
  iceBlocks(r);
  r.fill(0, r.h - 2, r.w, 1, P.iceShade);
  r.fill(0, r.h - 1, r.w, 1, P.iceLight);
  const cx = r.w / 2;
  for (let k = -6; k <= 6; k++) if (!door || Math.abs(k) > 1) arch(r, cx + k * 6, 3);
  if (door) {
    // Big arched doorway with a water emblem over it
    for (let y = 0; y < 10; y++)
      for (let x = -4; x <= 4; x++) {
        const top = y - 6;
        if (top > 0 && Math.hypot(x, top) > 4.4) continue;
        r.set(cx + x, y, top > 0 && Math.hypot(x, top) > 3.4 || Math.abs(x) === 4 ? P.iceDark : P.window);
      }
    r.fill(cx - 2, 10, 4, 1, team(0.86));
    r.fill(cx - 1, 11, 2, 1, team(1));
  }
}

// Hall walls: ice with tall arched windows; the front has a round door
function hallWall(r, door) {
  iceBlocks(r);
  r.fill(0, r.h - 1, r.w, 1, P.iceLight);
  const cx = r.w / 2;
  for (let k = -3; k <= 3; k++) if (!door || k !== 0) arch(r, cx + k * 7, 3, 3, 6);
  if (door)
    for (let y = 0; y < 9; y++)
      for (let x = -4; x <= 4; x++) {
        const d = Math.hypot(x, y - 4);
        if (d <= 4.6) r.set(cx + x, y, d > 3.6 ? P.iceDeep : P.window);
      }
}

// Vault and dome: courses of curved tiles in team green with pale ribs
function vault(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const k = y % 3;
      let c = k === 2 ? team(1) : k === 1 ? team(0.86) : team(0.72);
      if (x % 8 === 0) c = P.iceLight;
      r.set(x, y, c);
    }
  r.fill(0, 0, r.w, 1, P.iceShade);
}

// Packed snow with a water channel along the processional way
function snow(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, hash(x >> 2, y >> 2) < 0.25 ? P.snowShade : P.snow);
  const cx = r.w / 2;
  for (const ox of [-9, 7]) {
    r.fill(cx + ox, 0, 2, r.h / 2, P.water);
    r.fill(cx + ox, 0, 1, r.h / 2, P.waterLight);
  }
}

function stairs(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, y % 2 ? P.iceLight : P.iceShade);
  r.fill(0, 0, 2, r.h, P.iceDark);
  r.fill(r.w - 2, 0, 2, r.h, P.iceDark);
}

// Totem pillars: carved bands and a wave emblem
function pillarBands(r) {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, y % 6 < 1 ? P.iceDark : y % 6 < 2 ? P.iceLight : P.iceShade);
  for (let y = 8; y < r.h - 4; y += 12) {
    r.fill(1, y, r.w - 2, 3, P.iceDeep);
    r.fill(2, y + 1, r.w - 4, 1, P.water);
  }
}

const REGIONS = {
  // Third-age banners (writeAges)
  post: { w: 10, h: 40, paint: (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 ? hex(0x6a5240) : hex(0x4e3c30)); } },
  banner: { w: 12, h: 14, paint: (r) => { r.fill(0, 0, r.w, r.h, team(0.85)); r.fill(0, 0, r.w, 1, team(0.6)); r.fill(4, 5, 4, 4, team(1)); } },
  snow: { w: 96, h: 92, paint: snow },
  platform: { w: 96, h: 14, paint: platform },
  temple: { w: 80, h: 14, paint: (r) => templeWall(r, false) },
  templeFront: { w: 80, h: 14, paint: (r) => templeWall(r, true) },
  hall: { w: 46, h: 22, paint: (r) => hallWall(r, false) },
  hallFront: { w: 46, h: 22, paint: (r) => hallWall(r, true) },
  vault: { w: 46, h: 24, paint: vault },
  stairs: { w: 26, h: 30, paint: stairs },
  pillar: { w: 6, h: 34, paint: pillarBands },
};

// Relief per palette colour (1 = proud, 0 = deep opening)
function heightOf(c) {
  const is = (k) => c[0] === k[0] && c[1] === k[1] && c[2] === k[2];
  if (is(P.window)) return 0;
  if (is(P.windowLight) || is(P.water)) return 0.2;
  if (is(P.iceDark) || is(P.iceDeep)) return 0.4;
  if (is(P.iceShade) || is(P.snowShade)) return 0.7;
  if (isTeam(c)) return Math.max(0.3, (c[1] / 255 - 0.6) * 1.75);
  return 0.9;
}

// ---------- Geometry ----------
const mesh = new MeshBuilder();
const { tri } = mesh;

// Rectangle ring counter-clockwise from the front-right corner
const rect = (cx, cz, hw, hd, y) => [[cx + hw, y, cz + hd], [cx - hw, y, cz + hd], [cx - hw, y, cz - hd], [cx + hw, y, cz - hd]];
// Round ring of `n` points with a face toward +z
function ring(cx, cz, radius, y, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + Math.PI / n + i * 2 * Math.PI / n;
    pts.push([cx + radius * Math.cos(a), y, cz + radius * Math.sin(a)]);
  }
  return pts;
}

// Stepped temple: storeys shrinking upward with snowy ledges, crowned by a team-coloured dome
function temple(cx, cz, y, storeys) {
  mesh.part++;
  const center = [cx, 0, cz];
  storeys.forEach(({ hw, hd, height }, i) => {
    mesh.band(rect(cx, cz, hw, hd, y), rect(cx, cz, hw, hd, y + height), center, (n) => i === 0 && n[2] > 0.9 ? 'templeFront' : 'temple');
    y += height;
    mesh.cap(rect(cx, cz, hw, hd, y), 'snow');
  });
  // Dome: rings narrowing to a point, then a small team finial
  const r0 = Math.min(storeys.at(-1).hw, storeys.at(-1).hd) * 0.9;
  let prev = ring(cx, cz, r0, y, 10);
  for (const [k, dy] of [[0.92, 0.35], [0.7, 0.35], [0.38, 0.3]]) {
    const next = ring(cx, cz, r0 * k, y + dy, 10);
    mesh.band(prev, next, center, () => 'vault');
    prev = next;
    y += dy;
  }
  const tip = [cx, y + 0.9, cz];
  prev.forEach((p, k, a) => {
    const q = a[(k + 1) % a.length];
    tri(p, q, tip, 'vault', norm([p[0] + q[0] - 2 * cx, 0.6, p[2] + q[2] - 2 * cz]));
  });
}

// Hall with a barrel vault running front to back; semicircular ends
function vaultHall(cx, cz, y, hw, hd, height) {
  mesh.part++;
  const center = [cx, 0, cz];
  mesh.band(rect(cx, cz, hw, hd, y), rect(cx, cz, hw, hd, y + height), center, (n) => n[2] > 0.9 ? 'hallFront' : 'hall');
  y += height;
  const steps = 6, arc = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI * i / steps;
    arc.push([cx + hw * 1.05 * Math.cos(a), y + hw * 0.8 * Math.sin(a)]);
  }
  for (let i = 0; i < steps; i++) {
    const [x0, y0] = arc[i], [x1, y1] = arc[i + 1];
    const out = norm([(x0 + x1) / 2 - cx, (y0 + y1) / 2 - y, 0]);
    const f0 = [x0, y0, cz + hd + 0.12], f1 = [x1, y1, cz + hd + 0.12], b0 = [x0, y0, cz - hd - 0.12], b1 = [x1, y1, cz - hd - 0.12];
    tri(f0, f1, b1, 'vault', out);
    tri(f0, b1, b0, 'vault', out);
  }
  // Semicircular ends
  for (const [z, dir] of [[cz + hd, 1], [cz - hd, -1]]) {
    const c = [cx, y, z];
    for (let i = 0; i < steps; i++) tri(c, [arc[i][0], arc[i][1], z], [arc[i + 1][0], arc[i + 1][1], z], 'hall', [0, 0, dir]);
  }
}

// Totem pillar: octagonal shaft with a wider cap
function pillar(cx, cz, y, h) {
  mesh.part++;
  const center = [cx, 0, cz];
  mesh.band(ring(cx, cz, 0.22, y, 8), ring(cx, cz, 0.22, y + h, 8), center, () => 'pillar');
  mesh.band(ring(cx, cz, 0.22, y + h, 8), ring(cx, cz, 0.32, y + h + 0.15, 8), center, () => 'pillar');
  mesh.band(ring(cx, cz, 0.32, y + h + 0.15, 8), ring(cx, cz, 0.32, y + h + 0.35, 8), center, () => 'pillar');
  mesh.cap(ring(cx, cz, 0.32, y + h + 0.35, 8), 'snow');
}

// Ice platform with a snowy top
const BASE = 1.0;
mesh.part++;
mesh.band(rect(0, 0, 4.4, 4.2, 0), rect(0, 0, 4.15, 3.95, BASE), [0, 0, 0], () => 'platform');
mesh.cap(rect(0, 0, 4.15, 3.95, BASE), 'snow');

const storeys = [
  { hw: 2.6, hd: 2.0, height: 1.2 },
  { hw: 2.2, hd: 1.7, height: 1.05 },
  { hw: 1.85, hd: 1.42, height: 0.95 },
  { hw: 1.5, hd: 1.15, height: 0.9 },
  { hw: 1.15, hd: 0.9, height: 0.85 },
  { hw: 0.85, hd: 0.68, height: 0.8 },
];
const TZ = -1.1;
temple(0, TZ, BASE, storeys);

// Stair from the front of the platform up to the second storey's ledge
mesh.part++;
{
  const w = 0.75, topY = BASE + storeys[0].height, z0 = TZ + storeys[0].hd, z1 = z0 + 2.2;
  const a = [w, topY, z0], b = [-w, topY, z0], c = [-w, BASE, z1], d = [w, BASE, z1];
  tri(a, b, c, 'stairs', [0, 0.7, 1]);
  tri(a, c, d, 'stairs', [0, 0.7, 1]);
  tri(a, d, [w, BASE, z0], 'platform', [1, 0, 0]);
  tri(b, [-w, BASE, z0], c, 'platform', [-1, 0, 0]);
}

vaultHall(-3.0, 1.9, BASE, 0.95, 1.5, 1.2);
vaultHall(3.0, 1.9, BASE, 0.95, 1.5, 1.2);
pillar(-1.35, 3.4, BASE, 1.6);
pillar(1.35, 3.4, BASE, 1.6);

// ---------- Paint and write ----------
useDensity('center_water', mesh.tris, D);
const rgba = paintAtlas(ATLAS, REGIONS);
const { texture, normalTexture } = writeAges(OUT, 'center_water', 'WaterPalace', mesh.tris, REGIONS, D, ATLAS, rgba, heightOf, 0.8, 'water');
writeFileSync(PREVIEW, texture);
writeFileSync(NORMAL_PREVIEW, normalTexture);
console.log(`Built the water palace: ${mesh.tris.length} triangles, ${ATLAS}x${ATLAS} atlas`);
