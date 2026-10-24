// Builds the small 3D models, painted in pixel art with a normal map, into Assets/Resources/models:
//   gold_1..3, stone_1..3        resource piles (one per map tile)
//   house, farm, lumber          air version, plus _fire, _earth and _water for the other civilizations
// Every civilization's building of a kind keeps the same silhouette so it reads at a glance (house:
// stone plinth, walls, front door, side window, chimney, hipped roof; farm: barn with a big double
// door and hay bales; lumber camp: roof on four posts over a log pile, a stump with an axe), while
// walls, trims and eaves follow the civilization (air: white plaster, saffron trim, steep roof with a
// spire; fire: red lacquer, black beams, gold ridge, upturned eaves; earth: plaster over brick, jade
// trim, curled eaves; water: ice blocks, navy trim, snow on the ridge). Roofs use the team green,
// which the game swaps for the player's colour. Model units are tiles; front is +z.
// Run from the repo root: node unity/Tools/build-props.mjs
import { writeFileSync } from 'node:fs';
import { hex, team, isTeam, hash, norm, sub, cross, centroid, paintAtlas, normalMap, projectFaces, writeGlb, MeshBuilder, midPivot, AGE_SUFFIX, ageTris, ageTint, useDensity, fineRock } from './model-kit.mjs';

const OUT = (name) => new URL(`../Assets/Resources/models/${name}.bytes`, import.meta.url);
const PREVIEW = (name) => new URL(`models/${name}_paint.png`, import.meta.url);
const D = 20; // texels per tile: a little finer than the trees (16) so doors and windows read
const ATLAS = 128;

// ---------- Geometry helpers ----------

// Rectangle ring counter-clockwise from the front-right corner, with edge midpoints when `mids`;
// `lift` raises the corners (upturned eaves)
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

// Upright box; `side(normal)` picks each wall's region
function box(m, cx, y, cz, hw, hd, h, side, top) {
  m.part++;
  m.band(rect(cx, cz, hw, hd, y), rect(cx, cz, hw, hd, y + h), [cx, 0, cz], side);
  if (top) m.cap(rect(cx, cz, hw, hd, y + h), top);
}

// Hipped roof over walls (hw, hd) at height y: eave overhang, underside, slopes to a short ridge
function hipRoof(m, cx, y, cz, hw, hd, { eave, lift, rise }, regions) {
  m.part++;
  const center = [cx, 0, cz];
  const edge = rect(cx, cz, hw + eave, hd + eave, y - 0.03, lift, true);
  m.band(edge, rect(cx, cz, hw, hd, y, 0, true), center, () => regions.under, true, undefined, midPivot(edge));
  const ridge = Math.max(0.02, hw - hd);
  const top = rect(cx, cz, ridge, 0.02, y + rise, 0, true);
  m.band(edge, top, center, () => regions.roof, false, undefined, midPivot(edge));
  m.cap(top, regions.ridge);
  return { top: y + rise, ridge };
}

// Spike from a small square to a point (spires, finials)
function spike(m, cx, y, cz, r, h, region) {
  m.part++;
  const tip = [cx, y + h, cz];
  rect(cx, cz, r, r, y).forEach((p, k, a) => {
    const q = a[(k + 1) % 4];
    m.tri(p, q, tip, region, norm([p[0] + q[0] - 2 * cx, 0.2, p[2] + q[2] - 2 * cz]));
  });
}

// Prism along a→b (logs, posts, handles): `sides` faces of `side`, `cap` on both ends
function prism(m, a, b, r, sides, side, cap) {
  m.part++;
  const axis = norm(sub(b, a));
  const u = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : norm(cross(axis, [0, 1, 0]));
  const v = cross(axis, u);
  const ring = (o) => Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2 + Math.PI / sides;
    return [0, 1, 2].map((k) => o[k] + (u[k] * Math.cos(t) + v[k] * Math.sin(t)) * r);
  });
  const ra = ring(a), rb = ring(b);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const out = norm(sub(centroid(ra[i], ra[j], rb[i], rb[j]), centroid(a, b)));
    m.tri(ra[i], ra[j], rb[j], side, out);
    m.tri(ra[i], rb[j], rb[i], side, out);
    if (cap) {
      m.tri(a, ra[i], ra[j], cap, axis.map((x) => -x));
      m.tri(b, rb[i], rb[j], cap, axis);
    }
  }
}

// Low-poly boulder: jittered rings narrowing to a jittered apex, flat bottom (`simple`: one ring
// fewer)
function boulder(m, cx, cz, r, h, seed, region, sides = 7, simple = false) {
  m.part++;
  const rnd = (k) => hash(seed * 31 + k, seed * 17 + k * 7);
  const ring = (y, s, k0) => Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2 + rnd(k0) * 2;
    const rr = r * s * (0.8 + rnd(k0 + i + 1) * 0.35);
    return [cx + Math.cos(t) * rr, y, cz + Math.sin(t) * rr];
  });
  const lo = ring(0, 1, 1), mid = simple ? lo : ring(h * 0.45, 1.05, 20), hi = ring(h * (simple ? 0.6 : 0.82), simple ? 0.7 : 0.62, 40);
  const center = [cx, 0, cz];
  if (!simple) m.band(lo, mid, center, () => region);
  // Upper band leans inward: hint upward so the faces keep pointing out
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const c = centroid(mid[i], mid[j], hi[i], hi[j]);
    const out = norm([c[0] - cx, 0.6, c[2] - cz]);
    m.tri(mid[i], mid[j], hi[j], region, out);
    m.tri(mid[i], hi[j], hi[i], region, out);
  }
  const apex = [cx + (rnd(60) - 0.5) * r * 0.3, h, cz + (rnd(61) - 0.5) * r * 0.3];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const c = centroid(hi[i], hi[j], apex);
    m.tri(hi[i], hi[j], apex, region, norm([c[0] - cx, 1.2, c[2] - cz]));
  }
}

// ---------- Painting helpers ----------

const shade = (c, k) => c.map((x) => Math.max(0, Math.min(255, Math.round(x * k))));
const lum = (c) => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255;

// Relief from brightness, with dark openings (doors, windows, seams) sunk deep
function heightOf(c) {
  if (isTeam(c)) return Math.max(0.3, (c[1] / 255 - 0.6) * 1.75);
  return Math.min(1, lum(c) * 1.3);
}

// Writes the model once per age in `ages` (see AGE_SUFFIX). `parts`: extra named meshes kept as
// their own nodes (a gate's door, animated by the game). `strength` 0 = no normal map.
function build(name, regions, mesh, label, strength = 0.7, atlas = ATLAS, ages = [2], parts = []) {
  if (ages.includes(3)) {
    regions.banner ??= { w: 6, h: 8, paint: teamPaint };
    regions.post ??= { w: 16, h: 16, paint: (r) => r.fill(0, 0, r.w, r.h, hex(0x6a5240)) };
  }
  for (const age of ages) {
    AGE = age;
    const file = name + AGE_SUFFIX[age];
    const tris = ageTris(mesh.tris, age);
    if (age === 3) tris.push(...ageBanners(tris, mesh.part));
    useDensity(name, tris, D);
    const rgba = paintAtlas(atlas, regions);
    const faces = projectFaces(tris, regions, D, atlas, label);
    const extra = parts.map((part) => ({ name: part.name, ...projectFaces(ageTris(part.mesh.tris, age), regions, D, atlas, label) }));
    const { texture } = writeGlb(OUT(file), file, [{ name, ...faces }, ...extra], atlas, rgba, strength ? normalMap(rgba, atlas, regions, heightOf, strength) : null);
    writeFileSync(PREVIEW(file), texture);
    const xs = faces.positions.map((q) => q[0]), zs = faces.positions.map((q) => q[2]), ys = faces.positions.map((q) => q[1]);
    const width = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    console.log(`${file.padEnd(18)} ${String(tris.length).padStart(4)} triangles, ${width.toFixed(2)} x ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} tiles`);
  }
  AGE = 2;
}

// Third-age pomp: a team banner on a pole at each front corner of the model
function ageBanners(tris, part) {
  const m = new MeshBuilder();
  m.part = part + 100;
  const pts = tris.flatMap((t) => t.w);
  const minX = Math.min(...pts.map((q) => q[0])), maxX = Math.max(...pts.map((q) => q[0]));
  const maxZ = Math.max(...pts.map((q) => q[2])), maxY = Math.max(...pts.map((q) => q[1]));
  const width = maxX - minX, h = Math.min(maxY * 0.75, 0.25 + width * 0.35);
  for (const x of [minX + width * 0.06, maxX - width * 0.06]) {
    const z = maxZ - width * 0.05;
    prism(m, [x, 0, z], [x, h, z], 0.012 + width * 0.006, 4, 'post', 'post');
    plate(m, [x + Math.sign(x - (minX + maxX) / 2) * -0.06, h - 0.1, z], [1, 0, 0], [0, 1, 0], 0.05, 0.09, 0.006, 'banner');
  }
  return m.tris;
}

// ---------- Resources ----------

const ROCK = { base: hex(0x7d7468), light: hex(0x9a9184), dark: hex(0x5a5249), crack: hex(0x3f3933), high: hex(0xb3aa9c) };
const GOLD = { base: hex(0xffd34d), light: hex(0xfff3b0), dark: hex(0xc99a2e) };
const STONE = { base: hex(0xa9a69c), light: hex(0xcac7bd), dark: hex(0x7e7b72), crack: hex(0x5d5a53), high: hex(0xe0ddd4) };

// Cliff-like rock (model-kit fineRock), veined with gold for the mines
const rockPaint = (p, veins) => fineRock({ ...p, high: p.high, vein: veins ? GOLD.base : null, veinLight: GOLD.light }, veins ? 5 : 6);

function goldPaint(r) {
  r.fill(0, 0, r.w, r.h, GOLD.base);
  r.fill(0, 0, r.w, 1, GOLD.dark);
  r.fill(1, r.h - 2, 2, 1, GOLD.light);
}

function blockPaint(r) {
  r.fill(0, 0, r.w, r.h, STONE.base);
  r.fill(0, 0, r.w, 1, STONE.dark);
  r.fill(0, r.h - 1, r.w, 1, STONE.light);
}

// Low-poly rock with a flat top: a jittered ring on the ground, a bulging shoulder half way up and a
// narrower top face, tilted a little (every face flat, no box corners)
function lowRock(m, cx, cz, r, h, seed, region, sides = 7, y0 = 0) {
  m.part++;
  const rnd = (k) => hash(seed * 37 + k, seed * 11 + k * 13);
  const turn = rnd(0) * Math.PI * 2;
  const radii = Array.from({ length: sides }, (_, i) => 0.82 + rnd(i + 1) * 0.36);
  const angles = Array.from({ length: sides }, (_, i) => turn + ((i + (rnd(i + 30) - 0.5) * 0.5) / sides) * Math.PI * 2);
  const tx = (rnd(60) - 0.5) * 0.5, tz = (rnd(61) - 0.5) * 0.5; // top tilt, height per unit across
  const ring = (y, s, tilt) => angles.map((a, i) => {
    const x = Math.cos(a) * r * s * radii[i], z = Math.sin(a) * r * s * radii[i];
    return [cx + x, y0 + y + (tilt ? (x * tx + z * tz) * h / r : 0), cz + z];
  });
  const lo = ring(0, 1, false), mid = ring(h * (0.45 + rnd(62) * 0.15), 1.06, false), top = ring(h, 0.62, true);
  const center = [cx, 0, cz];
  m.band(lo, mid, center, () => region);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const c = centroid(mid[i], mid[j], top[i], top[j]);
    const out = norm([c[0] - cx, 0.7, c[2] - cz]);
    m.tri(mid[i], mid[j], top[j], region, out);
    m.tri(mid[i], top[j], top[i], region, out);
  }
  m.cap(top, region);
}

function goldPile(variant) {
  const m = new MeshBuilder();
  const r = (k) => hash(variant * 13 + k, k * 7);
  // A big rock shot with gold, a smaller one beside it and gold nuggets lying around
  lowRock(m, -0.08, -0.06, 0.27, 0.32, variant * 10 + 1, 'rock', 7);
  lowRock(m, 0.22, 0.12, 0.15, 0.2, variant * 10 + 2, 'rock', 6);
  lowRock(m, -0.02 + r(3) * 0.06, 0.3, 0.085, 0.08, variant * 10 + 3, 'gold', 5);
  lowRock(m, 0.2, 0.34, 0.065, 0.06, variant * 10 + 4, 'gold', 5);
  lowRock(m, -0.3, 0.2, 0.06, 0.055, variant * 10 + 5, 'gold', 5);
  lowRock(m, -0.1 + r(5) * 0.04, -0.08, 0.09, 0.07, variant * 10 + 6, 'gold', 5, 0.28); // a nugget on top
  build(`gold_${variant}`, {
    rock: { w: 16, h: 16, paint: rockPaint(ROCK, true) },
    gold: { w: 6, h: 6, paint: goldPaint },
  }, m, 'gold', 0, 64);
}

function stonePile(variant) {
  const m = new MeshBuilder();
  const r = (k) => hash(variant * 17 + k, k * 5 + 3);
  // A wide, low rock, a taller one leaning against it and a couple of loose stones
  lowRock(m, -0.1, -0.08, 0.3, 0.2, variant * 10 + 21, 'stone', 8);
  lowRock(m, 0.0, -0.12, 0.2, 0.36 + r(1) * 0.06, variant * 10 + 22, 'stone', 6);
  lowRock(m, 0.25, 0.16, 0.14, 0.15, variant * 10 + 23, 'stone', 6);
  lowRock(m, 0.04 + (variant - 2) * 0.05, 0.33, 0.08, 0.08, variant * 10 + 24, 'block', 5);
  build(`stone_${variant}`, {
    stone: { w: 16, h: 16, paint: rockPaint(STONE, false) },
    block: { w: 6, h: 6, paint: blockPaint },
  }, m, 'stone', 0, 64);
}

// ---------- Civilizations ----------

// Muted, slightly pastel palettes so every civilization sits in the same soft colour range
const CIVS = {
  air: {
    wall: 0xece4d4, wallDark: 0xd3c9b4, trim: 0xd99a5b, trimDark: 0xae7444, base: 0xb7b4ab, baseDark: 0x918e86,
    wood: 0xb08a66, woodDark: 0x86684c, door: 0x7c5e44, window: 0x3a3f4f, ridge: 0xd99a5b, cloth: 0xf1d9a8,
    lift: 0.02, steep: 1.35, spire: true, pattern: 'plaster',
  },
  fire: {
    wall: 0xa8544a, wallDark: 0x8a4038, trim: 0x3e3236, trimDark: 0x2a2226, base: 0x5c5052, baseDark: 0x433a3c,
    wood: 0x4e3e3a, woodDark: 0x382c2a, door: 0x3e3236, window: 0x2a2226, ridge: 0xd8b25e, cloth: 0xc9706a,
    lift: 0.09, steep: 1, pattern: 'beams',
  },
  earth: {
    wall: 0xcdb48e, wallDark: 0xb09872, trim: 0x74a58a, trimDark: 0x557f69, base: 0x9a6654, baseDark: 0x7a4e40,
    wood: 0x7d5c42, woodDark: 0x5e4432, door: 0x557f69, window: 0x3a2e28, ridge: 0xd6b45e, cloth: 0xe0d2b0,
    lift: 0.06, steep: 0.9, pattern: 'brick',
  },
  water: {
    wall: 0xe2eef4, wallDark: 0xb6d0de, trim: 0x4c6a8e, trimDark: 0x3a5274, base: 0xa6bac6, baseDark: 0x7e94a2,
    wood: 0x7a6a5c, woodDark: 0x5a4e44, door: 0x3a5274, window: 0x3a5274, ridge: 0xf4f8fa, cloth: 0x9cbcd6,
    lift: 0.0, steep: 1.05, snow: true, pattern: 'ice',
  },
};

// The age being painted (build() sets it): 1 = austere wood, 2 = the civilization's materials with
// plain finishes, 3 = the same materials dressed in gold trims, friezes and finials
let AGE = 2;
const GILT = [hex(0xd8b25e), hex(0xf0dc9a), hex(0xa8843e)]; // gold trims: base, light, dark
// First-age roofs: thatch or shingles in the civilization's way (team colour only along the eave)
const RUSTIC_ROOF = { air: [0xc9b06a, 0xa88f52], fire: [0x5e4a3c, 0x46372d], earth: [0xb59a62, 0x8f7748], water: [0xb39a7a, 0x8c7558] };
const mix = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));

function painters(civ) {
  const c = Object.fromEntries(Object.entries(civ).map(([k, v]) => [k, typeof v === 'number' ? hex(v) : v]));
  const civName = Object.keys(CIVS).find((k) => CIVS[k] === civ);
  const plank = mix(c.wood, hex(0xc9a77a), 0.35), plankDark = mix(c.woodDark, hex(0x3a2a20), 0.2);

  // Walls. Age 1: vertical boards with dark seams and knots under a plain beam. Age 2: the
  // civilization's material with a trim band. Age 3: the same with a gold-and-trim frieze.
  function wall(r) {
    if (AGE === 1) {
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const board = Math.floor(x / 3), seam = x % 3 === 2;
          let col = seam ? plankDark : hash(board, y >> 2) < 0.3 ? mix(plank, plankDark, 0.3) : plank;
          if (!seam && hash(x * 7, y * 3) < 0.025) col = plankDark; // knots
          r.set(x, y, col);
        }
      r.fill(0, r.h - 2, r.w, 2, c.woodDark);
      r.fill(0, 0, r.w, 1, plankDark);
      return;
    }
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const n = hash(x, y);
        let col = n < 0.15 ? c.wallDark : c.wall;
        if (c.pattern === 'beams' && x % 7 === 0) col = c.trim;
        if (c.pattern === 'brick' && y < r.h * 0.4) {
          const row = y >> 1, off = (row % 2) * 2;
          col = y % 2 === 1 || (x + off) % 4 === 0 ? c.baseDark : hash((x + off) >> 2, row) < 0.25 ? c.baseDark : c.base;
        }
        if (c.pattern === 'ice') {
          const row = Math.floor(y / 3), off = (row % 2) * 3;
          col = y % 3 === 2 || (x + off) % 6 === 0 ? c.wallDark : n < 0.1 ? hex(0xffffff) : c.wall;
        }
        r.set(x, y, col);
      }
    if (AGE === 3) {
      // Frieze: a gold zigzag on the trim colour, gold mouldings above and at the foot
      const fy = r.h - 5;
      r.fill(0, fy, r.w, 3, c.trim);
      for (let x = 0; x < r.w; x++) r.set(x, fy + (x % 4 < 2 ? x % 2 : 1 - (x % 2)) + 1 - (x % 4 >= 2 ? 1 : 0), GILT[0]);
      r.fill(0, r.h - 2, r.w, 1, GILT[2]);
      r.fill(0, r.h - 1, r.w, 1, GILT[1]);
      r.fill(0, 0, r.w, 1, GILT[2]);
      return;
    }
    r.fill(0, r.h - 2, r.w, 1, c.trimDark);
    r.fill(0, r.h - 1, r.w, 1, c.trim);
    r.fill(0, 0, r.w, 1, c.wallDark);
  }
  // Front wall: centred door (double doors when `wide`): planks in a wood frame, framed in the trim,
  // or in gold with gold studs
  const front = (dw, dh, wide = false) => (r) => {
    wall(r);
    const x0 = Math.round(r.w / 2 - dw / 2);
    const frame = AGE === 1 ? c.woodDark : AGE === 3 ? GILT[0] : c.trim;
    r.fill(x0 - 1, 0, dw + 2, dh + 1, frame);
    r.fill(x0, 0, dw, dh, AGE === 1 ? plankDark : c.door);
    if (AGE === 1) for (let x = x0 + 1; x < x0 + dw; x += 2) r.fill(x, 0, 1, dh, mix(plankDark, plank, 0.4));
    if (wide) {
      r.fill(x0 + dw / 2, 0, 1, dh, c.woodDark);
      for (let k = 0; k < dh; k++) {
        r.set(x0 + Math.round((k / dh) * (dw / 2 - 1)), k, c.wood);
        r.set(x0 + dw - 1 - Math.round((k / dh) * (dw / 2 - 1)), k, c.wood);
      }
    } else r.set(x0 + dw - 2, Math.floor(dh / 2), AGE === 3 ? GILT[1] : frame);
    if (AGE === 3) for (let y = 1; y < dh; y += 3) { r.set(x0 + 1, y, GILT[1]); r.set(x0 + dw - 2, y, GILT[1]); }
  };
  // Side wall: a window; shutters in the first age, a gold frame in the third
  const side = (r) => {
    wall(r);
    const x0 = Math.round(r.w / 2 - 2), y0 = Math.round(r.h / 2 - 1);
    if (AGE === 1) {
      r.fill(x0 - 1, y0 - 1, 5, 5, c.woodDark);
      r.fill(x0, y0, 3, 3, c.window);
      r.fill(x0 - 2, y0, 1, 3, plank); r.fill(x0 + 3, y0, 1, 3, plank); // open shutters
      return;
    }
    r.fill(x0 - 1, y0 - 1, 5, 5, AGE === 3 ? GILT[0] : c.trim);
    r.fill(x0, y0, 3, 3, c.window);
    r.fill(x0 + 1, y0, 1, 3, AGE === 3 ? GILT[2] : c.trimDark);
    if (AGE === 3) r.fill(x0 - 1, y0 + 4, 5, 1, GILT[1]);
  };
  // Roofs. Age 1: thatch/shingle rows with only a band of team colour along the eave. Ages 2 and 3:
  // team tiles; the eave in the trim colour, or gold rows in the third age. Snow on water's.
  const roof = (r) => {
    if (AGE === 1) {
      const [light, dark] = RUSTIC_ROOF[civName].map(hex);
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const row = y % 3, n = hash(x, y >> 1);
          r.set(x, y, row === 2 ? dark : n < 0.3 ? mix(light, dark, 0.4) : light);
        }
      r.fill(0, 0, r.w, 2, team(0.8));
      r.fill(0, 2, r.w, 1, team(0.6));
    } else {
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const k = y % 2, seam = (x + (Math.floor(y / 2) % 2)) % 3 === 0;
          r.set(x, y, k ? team(0.95) : seam ? team(0.62) : team(0.78));
        }
      if (AGE === 3) { r.fill(0, 0, r.w, 1, GILT[2]); r.fill(0, 1, r.w, 1, GILT[0]); for (let x = 1; x < r.w; x += 3) r.set(x, 2, GILT[1]); }
      else r.fill(0, 0, r.w, 1, c.trim);
    }
    if (c.snow) for (let y = Math.floor(r.h * 0.55); y < r.h; y++) for (let x = 0; x < r.w; x++) if (hash(x, y) < 0.75 + (y - r.h * 0.55) / r.h) r.set(x, y, y % 2 ? hex(0xffffff) : hex(0xe8f6ff));
  };
  const under = (r) => {
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 === 0 ? c.woodDark : AGE === 1 ? plank : c.wood);
    if (AGE === 3) for (let x = 0; x < r.w; x += 6) r.fill(x, 0, 1, r.h, GILT[0]);
  };
  // Foundations: packed earth and loose stones; the civilization's stonework; polished, gold-edged
  const base = (r) => {
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        if (AGE === 1) {
          const n = hash(x >> 1, y >> 1);
          r.set(x, y, n < 0.2 ? hex(0x8a8178) : n < 0.35 ? hex(0x6b6058) : n < 0.7 ? hex(0x7a6248) : hex(0x6a5440));
          continue;
        }
        r.set(x, y, (x + (y % 2) * 2) % 4 === 0 || y === 0 ? c.baseDark : AGE === 2 && hash(x >> 1, y) < 0.3 ? c.baseDark : c.base);
      }
    if (AGE === 3) r.fill(0, r.h - 1, r.w, 1, GILT[0]);
  };
  // Ridges and finials: wood, the trim colour, or gold
  const ridge = (r) => r.fill(0, 0, r.w, r.h, AGE === 1 ? c.woodDark : AGE === 3 ? GILT[0] : c.trim);
  const wood = (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 2 ? (AGE === 1 ? plank : c.wood) : c.woodDark); };
  return { c, wall, front, side, roof, under, base, ridge, wood };
}

// Logs: bark around, rings on the cut ends
const BARK = [hex(0x5d3a1e), hex(0x7a4f2a), hex(0x4a2e17)];
const bark = (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, BARK[(x % 3 === 0 ? 2 : hash(x, y >> 1) < 0.5 ? 0 : 1)]); };
const logEnd = (r) => {
  const cx = (r.w - 1) / 2, cy = (r.h - 1) / 2;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      r.set(x, y, d > r.w / 2 - 1 ? BARK[0] : Math.round(d) % 2 ? hex(0xc89b62) : hex(0xe0bb85));
    }
};
const hay = (r) => {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, y % 4 === 0 ? hex(0xb8902e) : hash(x, y) < 0.3 ? hex(0xf0d27a) : hex(0xdcb54a));
};
const metal = (r) => { for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, y === r.h - 1 ? hex(0xe6ecf0) : hex(0x9aa4ac)); };

// ---------- Shapes for each civilization's architecture ----------

// Regular polygon ring with one face looking straight at the front (+z)
function ngon(cx, cz, r, y, n, lift = 0) {
  const step = (Math.PI * 2) / n, rot = Math.PI / 2 - step / 2;
  return Array.from({ length: n }, (_, i) => [cx + Math.cos(rot + i * step) * r, y + lift, cz + Math.sin(rot + i * step) * r]);
}

// Round walls (air towers): `side(normal)` picks each face's region
function roundWalls(m, cx, y, cz, r, h, n, side) {
  m.part++;
  m.band(ngon(cx, cz, r, y, n), ngon(cx, cz, r * 0.97, y + h, n), [cx, 0, cz], side);
}

// Conical roof over round walls: eave underside, slopes to a point
function coneRoof(m, cx, y, cz, r, { eave, rise }, regions, n) {
  m.part++;
  const center = [cx, 0, cz];
  const edge = ngon(cx, cz, r + eave, y - 0.03, n);
  m.band(edge, ngon(cx, cz, r, y, n), center, () => regions.under, true);
  m.band(edge, ngon(cx, cz, 0.015, y + rise, n), center, () => regions.roof);
  m.cap(ngon(cx, cz, 0.015, y + rise, n), regions.roof);
  return y + rise;
}

// Two hipped roofs one over the other with a short upper storey between (fire pagodas)
function pagodaRoof(m, cx, y, cz, hw, hd, civ, regions, upperWall) {
  const low = hipRoof(m, cx, y, cz, hw, hd, { eave: EAVE + 0.04, lift: civ.lift + 0.05, rise: 0.16 }, regions);
  const uw = hw * 0.55, ud = hd * 0.55, uh = 0.13;
  box(m, cx, y + 0.1, cz, uw, ud, uh + 0.06, () => upperWall);
  const up = hipRoof(m, cx, y + 0.16 + uh, cz, uw, ud, { eave: EAVE * 0.9, lift: civ.lift + 0.04, rise: 0.2 }, regions);
  for (const x of [-up.ridge, up.ridge]) spike(m, cx + x, up.top, cz, 0.025, 0.1, regions.ridge);
  return up.top;
}

// Hemisphere of `rings` bands; the top `teamRings` take the roof region
function dome(m, cx, y, cz, r, n, rings, side, roof, teamRings = 1) {
  m.part++;
  let prev = ngon(cx, cz, r, y, n);
  for (let k = 1; k <= rings; k++) {
    const a = (k / (rings + 0.6)) * Math.PI / 2;
    const next = ngon(cx, cz, r * Math.cos(a), y + r * Math.sin(a), n);
    const region = k > rings - teamRings ? roof : side;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, c = centroid(prev[i], prev[j], next[i], next[j]);
      const out = norm([c[0] - cx, (c[1] - y) / r, c[2] - cz]);
      const anchor = { o: centroid(prev[i], prev[j]), a: norm(sub(prev[j], prev[i])) };
      m.tri(prev[i], prev[j], next[j], region, out, 0, anchor);
      m.tri(prev[i], next[j], next[i], region, out, 0, anchor);
    }
    prev = next;
  }
  m.cap(prev, roof);
}

// Half-round vault along z from z0 to z1 (water halls, tunnels), its front end painted `front`
function vault(m, cx, y, z0, z1, r, n, side, roofRegion, front, back = side) {
  m.part++;
  const arc = (z) => Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI;
    return [cx + Math.cos(a) * r, y + Math.sin(a) * r, z];
  });
  const a0 = arc(z0), a1 = arc(z1);
  for (let i = 0; i < n; i++) {
    const c = centroid(a0[i], a0[i + 1], a1[i], a1[i + 1]);
    const out = norm([c[0] - cx, c[1] - y, 0]);
    const region = i === 0 || i === n - 1 ? side : roofRegion;
    const anchor = { o: centroid(a0[i], a1[i]), a: [0, 0, 1] };
    m.tri(a0[i], a0[i + 1], a1[i + 1], region, out, 0, anchor);
    m.tri(a0[i], a1[i + 1], a1[i], region, out, 0, anchor);
  }
  const mid1 = [cx, y, z1], mid0 = [cx, y, z0];
  for (let i = 0; i < n; i++) {
    m.tri(mid1, a1[i], a1[i + 1], front, [0, 0, 1]);
    m.tri(mid0, a0[i], a0[i + 1], back, [0, 0, -1]);
  }
}

// Post (round for air, square stone pillars for earth, lacquered for fire, bone-white for water)
function post(m, x, y, z, h, civName) {
  if (civName === 'earth') box(m, x, y, z, 0.06, 0.06, h, () => 'base', 'base');
  else prism(m, [x, y, z], [x, y + h, z], 0.04, civName === 'air' ? 6 : 4, 'post', 'post');
}

const EAVE = 0.1;
const fileName = (kind, civName) => `${kind}${civName === 'air' ? '' : '_' + civName}`;
const wallRegion = (n) => n[2] > 0.9 ? 'front' : Math.abs(n[0]) > 0.9 ? 'side' : 'wall';
const ROOF = { roof: 'roof', under: 'under', ridge: 'ridge' };

// Common regions of a civilization's building, at sizes that fit every shape below
function regionsFor(p, extra = {}) {
  return {
    front: { w: 20, h: 12, paint: p.front(4, 6) },
    side: { w: 20, h: 12, paint: p.side },
    wall: { w: 20, h: 12, paint: p.wall },
    roof: { w: 34, h: 18, paint: p.roof },
    under: { w: 34, h: 12, paint: p.under },
    base: { w: 30, h: 26, paint: p.base },
    ridge: { w: 10, h: 8, paint: p.ridge },
    post: { w: 16, h: 16, paint: p.wood },
    ...extra,
  };
}

// House: somewhere to live with a door and a team roof; the shape is the civilization's own
function house(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  if (civName === 'air') {
    // Air civilization tower hut: round white walls, tall cone roof, spire
    box(m, 0, 0, 0, 0.4, 0.4, 0.07, () => 'base', 'base');
    roundWalls(m, 0, 0.07, 0, 0.3, 0.46, 8, (n) => n[2] > 0.95 ? 'front' : n[2] < -0.5 ? 'wall' : 'side');
    const top = coneRoof(m, 0, 0.53, 0, 0.3, { eave: EAVE, rise: 0.55 }, ROOF, 8);
    spike(m, 0, top - 0.04, 0, 0.03, 0.22, 'ridge');
  } else if (civName === 'fire') {
    // Fire civilization: dark raised platform, red walls, two-tier pagoda roof
    box(m, 0, 0, 0, 0.42, 0.4, 0.13, () => 'base', 'base');
    box(m, 0, 0.13, 0, 0.32, 0.3, 0.36, wallRegion);
    pagodaRoof(m, 0, 0.49, 0, 0.32, 0.3, civ, ROOF, 'wall');
  } else if (civName === 'earth') {
    // Earth civilization: wide and low, walls leaning in, gentle curled hip roof, chimney
    box(m, 0, 0, 0, 0.44, 0.36, 0.06, () => 'base', 'base');
    m.part++;
    m.band(rect(0, 0, 0.38, 0.3, 0.06), rect(0, 0, 0.34, 0.27, 0.42), [0, 0, 0], wallRegion);
    box(m, -0.22, 0.3, -0.15, 0.06, 0.06, 0.45, () => 'base', 'base');
    const roof = hipRoof(m, 0, 0.42, 0, 0.34, 0.27, { eave: EAVE + 0.02, lift: civ.lift, rise: 0.26 }, ROOF);
    for (const x of [-roof.ridge, roof.ridge]) spike(m, x, roof.top, 0, 0.03, 0.08, 'ridge');
  } else {
    // Water civilization igloo: dome of ice blocks with a team cap and an entrance tunnel
    box(m, 0, 0, -0.04, 0.42, 0.4, 0.04, () => 'base', 'base');
    dome(m, 0, 0.04, -0.06, 0.36, 10, 3, 'wall', 'roof', 1);
    vault(m, 0, 0.04, 0.2, 0.42, 0.15, 5, 'wall', 'wall', 'front');
  }
  build(fileName('house', civName), regionsFor(p, { front: { w: 20, h: 12, paint: p.front(4, civName === 'water' ? 4 : 6) } }), m, `house ${civName}`, 0.7, ATLAS, [1, 2, 3]);
}

// Box along arbitrary axes: centre, half sizes along unit vectors u, v and their normal (sails,
// spars, planks at an angle)
function plate(m, c, u, v, hu, hv, ht, region) {
  m.part++;
  const w = norm(cross(u, v));
  const P = (a, b, d) => [0, 1, 2].map((k) => c[k] + u[k] * hu * a + v[k] * hv * b + w[k] * ht * d);
  const quad = (p0, p1, p2, p3, n) => { m.tri(p0, p1, p2, region, n); m.tri(p0, p2, p3, region, n); };
  const neg = (x) => x.map((k) => -k);
  quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), w);
  quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), neg(w));
  quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), neg(v));
  quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), v);
  quad(P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1), neg(u));
  quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), u);
}

// Windmill sails on the front: four arms with cloth, turned 45 degrees
function sails(m, cx, cy, cz, len) {
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const u = [Math.cos(a), Math.sin(a), 0], v = [-Math.sin(a), Math.cos(a), 0];
    const at = (d, side) => [cx + u[0] * d + v[0] * side, cy + u[1] * d + v[1] * side, cz];
    plate(m, at(len / 2, 0), u, v, len / 2, 0.012, 0.012, 'post');
    plate(m, at(len * 0.6, 0.055), u, v, len * 0.36, 0.05, 0.006, 'sail');
  }
  plate(m, [cx, cy, cz - 0.03], [1, 0, 0], [0, 1, 0], 0.035, 0.035, 0.04, 'post');
}

// Cloth on a lattice, so it reads the same at any angle
const sailPaint = (c) => (r) => {
  r.fill(0, 0, r.w, r.h, c.cloth);
  for (let k = 0; k < r.w; k += 3) { r.fill(k, 0, 1, r.h, shade(c.cloth, 0.82)); r.fill(0, k, r.w, 1, shade(c.cloth, 0.82)); }
};

// Farm: a windmill on the farm's middle tile (taller than any house) with hay bales at its foot
function farm(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  const bale = (x, y, z) => box(m, x, y, z, 0.09, 0.07, 0.11, () => 'hay', 'hay');
  const towerH = 0.78, hub = 0.82;
  if (civName === 'air' || civName === 'water') {
    box(m, 0, 0, -0.05, 0.36, 0.36, 0.06, () => 'base', 'base');
    m.part++;
    m.band(ngon(0, -0.05, 0.27, 0.06, 8), ngon(0, -0.05, 0.2, 0.06 + towerH, 8), [0, 0, -0.05], (n) => n[2] > 0.95 ? 'front' : n[2] < -0.5 ? 'wall' : 'side');
    if (civName === 'air') {
      const top = coneRoof(m, 0, 0.06 + towerH, -0.05, 0.2, { eave: 0.07, rise: 0.36 }, ROOF, 8);
      spike(m, 0, top - 0.03, -0.05, 0.025, 0.14, 'ridge');
    } else dome(m, 0, 0.06 + towerH, -0.05, 0.22, 8, 2, 'roof', 'roof');
  } else {
    box(m, 0, 0, -0.05, 0.36, 0.34, civName === 'fire' ? 0.1 : 0.06, () => 'base', 'base');
    const y0 = civName === 'fire' ? 0.1 : 0.06;
    m.part++;
    m.band(rect(0, -0.05, 0.25, 0.23, y0), rect(0, -0.05, 0.18, 0.17, y0 + towerH), [0, 0, -0.05], wallRegion);
    if (civName === 'fire') pagodaRoof(m, 0, y0 + towerH, -0.05, 0.18, 0.17, civ, ROOF, 'wall');
    else {
      const roof = hipRoof(m, 0, y0 + towerH, -0.05, 0.18, 0.17, { eave: 0.08, lift: civ.lift, rise: 0.24 }, ROOF);
      spike(m, 0, roof.top, -0.05, 0.03, 0.08, 'ridge');
    }
  }
  sails(m, 0, hub, 0.2, 0.5);
  bale(0.3, 0, 0.32); bale(-0.3, 0, 0.3); bale(0.3, 0.11, 0.3);
  build(fileName('farm', civName), regionsFor(p, {
    front: { w: 20, h: 18, paint: p.front(4, 6) },
    side: { w: 20, h: 18, paint: p.side },
    wall: { w: 20, h: 18, paint: p.wall },
    hay: { w: 6, h: 6, paint: hay },
    sail: { w: 10, h: 10, paint: sailPaint(p.c) },
  }), m, `farm ${civName}`, 0.7, ATLAS, [2, 3]);
}

// Lumber camp: a wide, flat storage yard behind low walls; a shelter at the back over the log pile,
// a crate of stone and gold and a rack of hanging meat in the open yard
function lumber(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  const hw = 0.74, hd = 0.62;
  box(m, 0, 0, 0, hw, hd, 0.05, () => 'base', 'deck');
  // Low walls on three sides, open at the front
  box(m, -hw + 0.03, 0.05, 0, 0.03, hd, 0.12, () => 'wall', 'deck');
  box(m, hw - 0.03, 0.05, 0, 0.03, hd, 0.12, () => 'wall', 'deck');
  box(m, 0, 0.05, -hd + 0.03, hw, 0.03, 0.12, () => 'wall', 'deck');
  // Shelter over the back third
  const sw = 0.62, sd = 0.17, sz = -0.4, postH = 0.42;
  if (civName === 'air') {
    for (const x of [-sw, 0, sw]) for (const z of [sz - sd, sz + sd]) post(m, x, 0.05, z, postH, civName);
    const roof = hipRoof(m, 0, 0.05 + postH, sz, sw, sd, { eave: EAVE, lift: 0.02, rise: 0.3 }, ROOF);
    spike(m, 0, roof.top, sz, 0.03, 0.12, 'ridge');
  } else {
    for (const x of [-sw, 0, sw]) for (const z of [sz - sd, sz + sd]) post(m, x, 0.05, z, postH, civName);
    if (civName === 'fire') pagodaRoof(m, 0, 0.05 + postH, sz, sw, sd, civ, ROOF, 'post');
    else if (civName === 'earth') hipRoof(m, 0, 0.05 + postH, sz, sw, sd, { eave: EAVE, lift: civ.lift, rise: 0.18 }, ROOF);
    else vault(m, 0, 0.05 + postH - 0.02, sz - sd - 0.06, sz + sd + 0.06, sw + 0.06, 6, 'roof', 'roof', 'under', 'under');
  }
  // Logs under the shelter: 3 + 2
  const r = 0.065;
  [3, 2].forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      const z = sz + (i - (count - 1) / 2) * r * 2.05, y = 0.05 + r + row * r * 1.75;
      prism(m, [-0.5, y, z], [0.5, y, z], r, 6, 'bark', 'logEnd');
    }
  });
  // Crate of ore: stone blocks and gold nuggets heaped in it
  box(m, -0.36, 0.05, 0.22, 0.17, 0.13, 0.12, () => 'post', 'post');
  box(m, -0.42, 0.17, 0.2, 0.07, 0.06, 0.06, () => 'block', 'block');
  box(m, -0.3, 0.17, 0.26, 0.06, 0.05, 0.05, () => 'block', 'block');
  box(m, -0.3, 0.17, 0.15, 0.05, 0.04, 0.05, () => 'gold', 'gold');
  box(m, -0.42, 0.23, 0.22, 0.04, 0.03, 0.04, () => 'gold', 'gold');
  // Meat rack: two posts and a bar with hams hanging from it
  prism(m, [0.18, 0.05, 0.22], [0.18, 0.42, 0.22], 0.02, 4, 'post', 'post');
  prism(m, [0.58, 0.05, 0.22], [0.58, 0.42, 0.22], 0.02, 4, 'post', 'post');
  prism(m, [0.16, 0.41, 0.22], [0.6, 0.41, 0.22], 0.018, 4, 'post', 'post');
  for (const x of [0.27, 0.38, 0.49]) {
    prism(m, [x, 0.4, 0.22], [x, 0.33, 0.22], 0.006, 3, 'bone', null);
    prism(m, [x, 0.33, 0.22], [x, 0.2, 0.22], 0.04, 5, 'meat', 'meat');
  }
  build(fileName('lumber', civName), regionsFor(p, {
    deck: { w: 32, h: 26, paint: p.base },
    ridge: { w: 20, h: 8, paint: p.ridge },
    wall: { w: 32, h: 6, paint: p.wall },
    roof: { w: 34, h: 16, paint: p.roof },
    under: { w: 34, h: 18, paint: p.under },
    post: { w: 16, h: 16, paint: p.wood },
    bark: { w: 22, h: 6, paint: bark },
    logEnd: { w: 4, h: 4, paint: logEnd },
    block: { w: 4, h: 4, paint: blockPaint },
    gold: { w: 3, h: 3, paint: goldPaint },
    meat: { w: 6, h: 6, paint: meatPaint },
    bone: { w: 2, h: 3, paint: (rr) => rr.fill(0, 0, rr.w, rr.h, hex(0xf2e8d8)) },
  }), m, `lumber ${civName}`, 0.7, ATLAS, [1, 2, 3]);
}

const meatPaint = (r) => {
  r.fill(0, 0, r.w, r.h, hex(0xc4726a));
  for (let x = 0; x < r.w; x += 2) r.set(x, r.h - 1, hex(0xe6a89c));
  r.fill(0, 0, r.w, 1, hex(0x9c5650));
};

// ---------- Military and temple buildings ----------

const teamPaint = (r) => {
  r.fill(0, 0, r.w, r.h, team(0.82));
  r.fill(0, 0, r.w, 1, team(0.62));
  r.fill(Math.floor(r.w / 2) - 1, Math.floor(r.h / 2) - 1, 2, 2, team(1));
};
const targetPaint = (r) => {
  const cx = (r.w - 1) / 2, cy = (r.h - 1) / 2;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      r.set(x, y, d < 1 ? hex(0xd9776d) : d < 2.2 ? hex(0xf2ead8) : d < 3.4 ? hex(0xd9776d) : hex(0xb08a66));
    }
};
const sackPaint = (r) => { r.fill(0, 0, r.w, r.h, hex(0xcdb48e)); r.fill(0, 0, r.w, 1, hex(0xa98a60)); r.set(1, r.h - 2, hex(0x5e4432)); r.set(r.w - 2, r.h - 2, hex(0x5e4432)); };
const goldTrim = (r) => { r.fill(0, 0, r.w, r.h, hex(0xd8b25e)); r.fill(0, r.h - 1, r.w, 1, hex(0xf0dc9a)); };

// Roof of a rectangular hall in the civilization's style; returns the top height
function hallRoof(m, civName, civ, y, cz, hw, hd) {
  if (civName === 'fire') return pagodaRoof(m, 0, y, cz, hw, hd, civ, ROOF, 'wall');
  if (civName === 'water') { vault(m, 0, y - 0.02, cz - hd - 0.05, cz + hd + 0.05, hw + 0.05, 7, 'roof', 'roof', 'wall'); return y + hw; }
  const roof = hipRoof(m, 0, y, cz, hw, hd, { eave: EAVE + 0.02, lift: civ.lift, rise: (civName === 'air' ? 0.42 : 0.3) * (hd / 0.35) }, ROOF);
  if (civName === 'air') spike(m, 0, roof.top - 0.02, cz, 0.035, 0.18, 'ridge');
  else for (const x of [-roof.ridge, roof.ridge]) spike(m, x, roof.top, cz, 0.03, 0.09, 'ridge');
  return roof.top;
}

// Hall walls: straight for air and water, red lacquer on a raised plinth for fire, leaning for earth
function hallWalls(m, civName, y, cz, hw, hd, h, side) {
  m.part++;
  if (civName === 'earth') m.band(rect(0, cz, hw + 0.04, hd + 0.03, y), rect(0, cz, hw, hd, y + h), [0, 0, cz], side);
  else m.band(rect(0, cz, hw, hd, y), rect(0, cz, hw, hd, y + h), [0, 0, cz], side);
}

function bigRegions(p, extra = {}) {
  return regionsFor(p, {
    front: { w: 32, h: 12, paint: p.front(6, 8, true) },
    side: { w: 24, h: 12, paint: p.side },
    wall: { w: 36, h: 18, paint: p.wall },
    roof: { w: 40, h: 22, paint: p.roof },
    under: { w: 40, h: 16, paint: p.under },
    base: { w: 40, h: 40, paint: p.base },
    deck: { w: 40, h: 40, paint: p.base },
    post: { w: 24, h: 24, paint: p.wood },
    ridge: { w: 22, h: 8, paint: p.ridge },
    ...extra,
  });
}

// Barracks: a hall at the back of a training yard with a spear rack, a practice dummy, an archery
// target and the team's standard
function barracks(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  const cz = -0.38, hw = 0.68, hd = 0.36, h = 0.46;
  box(m, 0, 0, 0, 0.92, 0.9, 0.05, () => 'base', 'deck');
  const y0 = civName === 'fire' ? 0.12 : 0.05;
  if (civName === 'fire') box(m, 0, 0.05, cz, hw + 0.08, hd + 0.08, 0.07, () => 'base', 'base');
  hallWalls(m, civName, y0, cz, hw, hd, h, wallRegion);
  hallRoof(m, civName, civ, y0 + h, cz, hw, hd);
  if (civName === 'air') for (const x of [-hw - 0.02, hw + 0.02]) {
    roundWalls(m, x, 0.05, cz + hd, 0.13, 0.62, 8, () => 'side');
    const top = coneRoof(m, x, 0.67, cz + hd, 0.13, { eave: 0.05, rise: 0.3 }, ROOF, 8);
    spike(m, x, top - 0.02, cz + hd, 0.02, 0.1, 'ridge');
  }
  // Spear rack (left)
  for (const x of [-0.78, -0.42]) prism(m, [x, 0.05, 0.2], [x, 0.42, 0.2], 0.02, 4, 'post', 'post');
  prism(m, [-0.8, 0.36, 0.2], [-0.4, 0.36, 0.2], 0.015, 4, 'post', 'post');
  for (const x of [-0.7, -0.6, -0.5]) {
    prism(m, [x, 0.05, 0.26], [x + 0.02, 0.56, 0.18], 0.01, 3, 'post', null);
    spike(m, x + 0.02, 0.56, 0.18, 0.018, 0.07, 'metal');
  }
  // Practice dummy (middle)
  prism(m, [0.05, 0.05, 0.42], [0.05, 0.5, 0.42], 0.025, 4, 'post', 'post');
  prism(m, [-0.12, 0.38, 0.42], [0.22, 0.38, 0.42], 0.018, 4, 'post', 'post');
  box(m, 0.05, 0.22, 0.42, 0.07, 0.05, 0.14, () => 'sack', 'sack');
  box(m, 0.05, 0.5, 0.42, 0.05, 0.05, 0.08, () => 'sack', 'sack');
  // Archery target (right) on two legs
  prism(m, [0.58, 0.05, 0.38], [0.62, 0.4, 0.44], 0.015, 4, 'post', 'post');
  prism(m, [0.8, 0.05, 0.38], [0.76, 0.4, 0.44], 0.015, 4, 'post', 'post');
  plate(m, [0.69, 0.36, 0.46], [1, 0, 0], norm([0, 1, -0.25]), 0.13, 0.13, 0.02, 'target');
  // Team standard by the door
  prism(m, [0.3, 0.05, cz + hd + 0.1], [0.3, 0.95, cz + hd + 0.1], 0.015, 4, 'post', 'post');
  plate(m, [0.38, 0.8, cz + hd + 0.1], [1, 0, 0], [0, 1, 0], 0.08, 0.13, 0.008, 'banner');
  build(fileName('barracks', civName), bigRegions(p, {
    side: { w: 24, h: 16, paint: p.side },
    sack: { w: 4, h: 6, paint: sackPaint },
    target: { w: 8, h: 8, paint: targetPaint },
    banner: { w: 6, h: 8, paint: teamPaint },
    metal: { w: 3, h: 3, paint: metal },
  }), m, `barracks ${civName}`, 0.7, 256, [1, 2, 3]);
}

// Monastery: the civilization's tallest temple shape, with a golden bell hanging at the front
function monastery(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  box(m, 0, 0, 0, 0.9, 0.88, 0.06, () => 'base', 'deck');
  box(m, 0, 0.06, -0.12, 0.72, 0.62, 0.08, () => 'base', 'base');
  const y = 0.14, cz = -0.12;
  if (civName === 'air') {
    roundWalls(m, 0, y, cz, 0.42, 0.78, 10, (n) => n[2] > 0.95 ? 'front' : 'side');
    const top = coneRoof(m, 0, y + 0.78, cz, 0.42, { eave: 0.1, rise: 0.85 }, ROOF, 10);
    spike(m, 0, top - 0.03, cz, 0.04, 0.3, 'ridge');
    for (const x of [-0.6, 0.6]) {
      roundWalls(m, x, y, cz - 0.1, 0.13, 0.55, 8, () => 'side');
      const t = coneRoof(m, x, y + 0.55, cz - 0.1, 0.13, { eave: 0.05, rise: 0.32 }, ROOF, 8);
      spike(m, x, t - 0.02, cz - 0.1, 0.02, 0.12, 'ridge');
    }
  } else if (civName === 'fire') {
    hallWalls(m, civName, y, cz, 0.5, 0.45, 0.42, wallRegion);
    const t1 = pagodaRoof(m, 0, y + 0.42, cz, 0.5, 0.45, civ, ROOF, 'wall');
    box(m, 0, t1 - 0.04, cz, 0.18, 0.16, 0.16, () => 'wall');
    const t2 = hipRoof(m, 0, t1 + 0.12, cz, 0.18, 0.16, { eave: 0.12, lift: civ.lift + 0.04, rise: 0.22 }, ROOF);
    spike(m, 0, t2.top, cz, 0.03, 0.22, 'ridge');
  } else if (civName === 'earth') {
    // Stepped terraces up to a shrine
    box(m, 0, y, cz, 0.62, 0.52, 0.16, () => 'base', 'base');
    box(m, 0, y + 0.16, cz, 0.48, 0.4, 0.16, () => 'base', 'base');
    hallWalls(m, civName, y + 0.32, cz, 0.32, 0.27, 0.36, wallRegion);
    const roof = hipRoof(m, 0, y + 0.68, cz, 0.32, 0.27, { eave: 0.12, lift: civ.lift + 0.02, rise: 0.3 }, ROOF);
    for (const x of [-roof.ridge, roof.ridge]) spike(m, x, roof.top, cz, 0.03, 0.1, 'ridge');
  } else {
    // A great ice dome ringed by pillars
    box(m, 0, y, cz, 0.5, 0.5, 0.18, wallRegion);
    dome(m, 0, y + 0.18, cz, 0.56, 12, 4, 'wall', 'roof', 2);
    for (const [x, z] of [[-0.66, 0.28], [0.66, 0.28], [-0.66, -0.52], [0.66, -0.52]]) {
      prism(m, [x, y, z], [x, y + 0.6, z], 0.06, 6, 'wall', 'wall');
      dome(m, x, y + 0.6, z, 0.08, 6, 2, 'roof', 'roof', 2);
    }
  }
  // Bell frame at the front
  for (const x of [0.52, 0.8]) prism(m, [x, 0.06, 0.62], [x, 0.5, 0.62], 0.02, 4, 'post', 'post');
  prism(m, [0.5, 0.48, 0.62], [0.82, 0.48, 0.62], 0.02, 4, 'post', 'post');
  m.part++;
  dome(m, 0.66, 0.3, 0.62, 0.08, 8, 2, 'bell', 'bell', 0);
  box(m, 0.66, 0.24, 0.62, 0.08, 0.08, 0.06, () => 'bell');
  build(fileName('monastery', civName), bigRegions(p, {
    front: { w: 32, h: 18, paint: p.front(6, 9, true) },
    side: { w: 32, h: 18, paint: p.side },
    wall: { w: 36, h: 18, paint: p.wall },
    roof: { w: 48, h: 30, paint: p.roof },
    under: { w: 40, h: 16, paint: p.under },
    bell: { w: 8, h: 6, paint: goldTrim },
  }), m, `monastery ${civName}`, 0.7, 256, [2, 3]);
}

// Tower: a tall watchtower with arrow slits and a roof in the civilization's style
function tower(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  const H = 1.05;
  box(m, 0, 0, 0, 0.42, 0.42, 0.06, () => 'base', 'base');
  if (civName === 'air' || civName === 'water') {
    m.part++;
    m.band(ngon(0, 0, 0.3, 0.06, 8), ngon(0, 0, 0.25, 0.06 + H, 8), [0, 0, 0], (n) => n[2] > 0.95 ? 'front' : 'side');
    // Lookout ring
    m.part++;
    m.band(ngon(0, 0, 0.25, 0.06 + H, 8), ngon(0, 0, 0.33, 0.06 + H + 0.06, 8), [0, 0, 0], () => 'under', true);
    m.band(ngon(0, 0, 0.33, 0.06 + H + 0.06, 8), ngon(0, 0, 0.33, 0.06 + H + 0.14, 8), [0, 0, 0], () => 'wall');
    m.cap(ngon(0, 0, 0.33, 0.06 + H + 0.14, 8), 'base');
    if (civName === 'air') {
      roundWalls(m, 0, 0.06 + H + 0.14, 0, 0.22, 0.16, 8, () => 'side');
      const top = coneRoof(m, 0, 0.06 + H + 0.3, 0, 0.22, { eave: 0.08, rise: 0.42 }, ROOF, 8);
      spike(m, 0, top - 0.03, 0, 0.03, 0.16, 'ridge');
    } else dome(m, 0, 0.06 + H + 0.14, 0, 0.26, 8, 2, 'roof', 'roof', 2);
  } else {
    hallWalls(m, civName, 0.06, 0, 0.27, 0.27, H, (n) => n[2] > 0.9 ? 'front' : 'side');
    m.part++;
    m.band(rect(0, 0, 0.27, 0.27, 0.06 + H), rect(0, 0, 0.34, 0.34, 0.06 + H + 0.06), [0, 0, 0], () => 'under', true);
    box(m, 0, 0.06 + H + 0.06, 0, 0.34, 0.34, 0.08, () => 'wall', 'base');
    if (civName === 'earth') {
      // Crenellations
      for (const [x, z] of [[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28], [0, 0.28], [0, -0.28], [0.28, 0], [-0.28, 0]])
        box(m, x, 0.06 + H + 0.14, z, 0.05, 0.05, 0.08, () => 'base', 'base');
      box(m, 0, 0.06 + H + 0.14, 0, 0.16, 0.16, 0.14, () => 'wall');
      const roof = hipRoof(m, 0, 0.06 + H + 0.28, 0, 0.16, 0.16, { eave: 0.08, lift: civ.lift, rise: 0.2 }, ROOF);
      spike(m, 0, roof.top, 0, 0.025, 0.08, 'ridge');
    } else {
      box(m, 0, 0.06 + H + 0.14, 0, 0.2, 0.2, 0.12, () => 'wall');
      pagodaRoof(m, 0, 0.06 + H + 0.26, 0, 0.2, 0.2, civ, ROOF, 'wall');
    }
  }
  // Arrow slits down the shaft
  const slits = (r) => {
    p.wall(r);
    for (let y = 4; y < r.h - 4; y += 7) r.fill(Math.floor(r.w / 2), y, 1, 4, p.c.window);
  };
  build(fileName('tower', civName), regionsFor(p, {
    front: { w: 14, h: 24, paint: p.front(3, 5) },
    side: { w: 14, h: 24, paint: slits },
    wall: { w: 16, h: 6, paint: p.wall },
    roof: { w: 24, h: 16, paint: p.roof },
    under: { w: 16, h: 6, paint: p.under },
  }), m, `tower ${civName}`, 0.7, 128, [2, 3]);
}

// Round corner tower (air: cone and spire, water: dome)
function cornerTower(m, civName, x, z, r, h) {
  roundWalls(m, x, 0.06, z, r, h, 8, () => 'side');
  if (civName === 'air') {
    const t = coneRoof(m, x, 0.06 + h, z, r, { eave: r * 0.35, rise: r * 1.8 }, ROOF, 8);
    spike(m, x, t - 0.02, z, 0.02, 0.1, 'ridge');
  } else dome(m, x, 0.06 + h, z, r * 1.02, 8, 2, 'roof', 'roof', 2);
}

// Fortress: curtain walls with a gate, four corner towers and a central keep, team banners
function fortress(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder();
  const W = 1.38, wallH = 0.5, T = 0.1;
  box(m, 0, 0, 0, W + 0.06, W + 0.06, 0.06, () => 'base', 'deck');
  // Curtain walls; the front one has the gate
  box(m, 0, 0.06, -W + T, W, T, wallH, () => 'wall', 'base');
  box(m, -W + T, 0.06, 0, T, W, wallH, () => 'wall', 'base');
  box(m, W - T, 0.06, 0, T, W, wallH, () => 'wall', 'base');
  box(m, 0, 0.06, W - T, W, T, wallH, (n) => (n[2] > 0.9 ? 'gateWall' : 'wall'), 'base');
  // Battlements along the walls
  for (let i = -5; i <= 5; i++) {
    const o = (i / 5) * (W - 0.12);
    for (const [x, z] of [[o, -W + T], [o, W - T], [-W + T, o], [W - T, o]]) box(m, x, 0.06 + wallH, z, 0.045, 0.045, 0.07, () => 'base', 'base');
  }
  // Corner towers
  for (const [x, z] of [[-W, -W], [W, -W], [-W, W], [W, W]]) {
    if (civName === 'air' || civName === 'water') cornerTower(m, civName, x, z, 0.24, 0.85);
    else {
      box(m, x, 0.06, z, 0.24, 0.24, 0.85, () => 'side');
      if (civName === 'fire') pagodaRoof(m, x, 0.91, z, 0.24, 0.24, civ, ROOF, 'wall');
      else {
        const roof = hipRoof(m, x, 0.91, z, 0.24, 0.24, { eave: 0.08, lift: civ.lift, rise: 0.22 }, ROOF);
        spike(m, x, roof.top, z, 0.025, 0.07, 'ridge');
      }
    }
  }
  // Keep
  hallWalls(m, civName, 0.06, -0.25, 0.55, 0.48, 0.95, wallRegion);
  hallRoof(m, civName, civ, 1.01, -0.25, 0.55, 0.48);
  build(fileName('fortress', civName), bigRegions(p, {
    gateWall: { w: 60, h: 12, paint: p.front(10, 9, true) },
    wall: { w: 60, h: 22, paint: p.wall },
    side: { w: 26, h: 24, paint: p.side },
    front: { w: 26, h: 24, paint: p.front(6, 8, true) },
    roof: { w: 48, h: 26, paint: p.roof },
    under: { w: 40, h: 16, paint: p.under },
    base: { w: 60, h: 60, paint: p.base },
    deck: { w: 60, h: 60, paint: p.base },
    post: { w: 24, h: 32, paint: p.wood },
  }), m, `fortress ${civName}`, 0.7, 256, [2, 3]);
}

// Gate: two pillars and a lintel in the civilization's style; the door is its own node ("Door"),
// which the game lifts to open it for the owner's units
function gate(civName) {
  const civ = CIVS[civName], p = painters(civ), m = new MeshBuilder(), door = new MeshBuilder();
  const H = 0.62;
  for (const x of [-0.36, 0.36]) {
    box(m, x, 0, 0, 0.1, 0.12, H, () => 'side', 'base');
    if (civName === 'air') spike(m, x, H, 0, 0.1, 0.22, 'roof');
    else if (civName === 'water') dome(m, x, H, 0, 0.11, 6, 2, 'roof', 'roof', 2);
    else hipRoof(m, x, H, 0, 0.1, 0.12, { eave: 0.05, lift: civ.lift, rise: 0.12 }, ROOF);
  }
  box(m, 0, H - 0.12, 0, 0.3, 0.08, 0.1, () => 'base', 'base');
  // The door fills the opening between the pillars
  plate(door, [0, (H - 0.12) / 2, 0], [1, 0, 0], [0, 1, 0], 0.26, (H - 0.12) / 2, 0.03, 'door');
  const doorPaint = (r) => {
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) r.set(x, y, x % 3 === 0 ? p.c.woodDark : p.c.wood);
    r.fill(0, Math.floor(r.h * 0.3), r.w, 1, p.c.trim); r.fill(0, Math.floor(r.h * 0.7), r.w, 1, p.c.trim);
  };
  build(fileName('gate', civName), regionsFor(p, {
    side: { w: 8, h: 14, paint: p.side },
    door: { w: 12, h: 12, paint: doorPaint },
    roof: { w: 10, h: 8, paint: p.roof },
    under: { w: 10, h: 6, paint: p.under },
  }), m, `gate ${civName}`, 0.7, 128, [2, 3], [{ name: 'Door', mesh: door }]);
}

// Wall pieces the game joins along a wall line: a post on every tile and a span toward each
// neighbouring wall tile (straight or diagonal). Span: 1 unit long along +z from z = 0
function wallPieces(civName) {
  const civ = CIVS[civName], p = painters(civ);
  const post = new MeshBuilder();
  box(post, 0, 0, 0, 0.16, 0.16, 0.66, () => 'side', 'base');
  if (civName === 'air') spike(post, 0, 0.66, 0, 0.16, 0.2, 'roof');
  else if (civName === 'water') dome(post, 0, 0.66, 0, 0.17, 6, 2, 'roof', 'roof', 2);
  else hipRoof(post, 0, 0.66, 0, 0.16, 0.16, { eave: 0.04, lift: civ.lift, rise: 0.1 }, ROOF);
  const regions = regionsFor(p, {
    side: { w: 8, h: 18, paint: p.wall },
    wall: { w: 22, h: 12, paint: p.wall },
    roof: { w: 10, h: 8, paint: p.roof },
    under: { w: 10, h: 6, paint: p.under },
  });
  build(fileName('wall_post', civName), regions, post, `wall post ${civName}`, 0.7, 128, [2, 3]);
  const span = new MeshBuilder();
  box(span, 0, 0, 0.5, 0.11, 0.5, 0.5, () => 'wall', 'base');
  for (let i = 0; i < 4; i++) box(span, 0, 0.5, 0.125 + i * 0.25, 0.11, 0.05, 0.06, () => 'base', 'base');
  build(fileName('wall_span', civName), regions, span, `wall span ${civName}`, 0.7, 128, [2, 3]);
}

for (const civ of Object.keys(CIVS)) { barracks(civ); monastery(civ); tower(civ); fortress(civ); gate(civ); wallPieces(civ); }
for (let v = 1; v <= 3; v++) { goldPile(v); stonePile(v); }
for (const civ of Object.keys(CIVS)) { house(civ); farm(civ); lumber(civ); }
