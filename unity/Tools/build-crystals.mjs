// Builds the spirit dimension's crystal outcrops, low-poly and painted in pixel art, into
// Assets/Resources/models:
//   crystal_big_1..5     mountains of crystal on a rock mound (the outcrops of 80 tiles and more)
//   crystal_mid_1..5     the same shapes, not stretched, for the 9..79 tile outcrops
//   crystal_small_1..5   clusters for the smaller outcrops and the cliff walls
// Each crystal is a hexagonal prism with a pointed tip, leaning out from its cluster like the
// reference crystal (unity/Tools/references): one pale aqua all over, with light streaks running
// straight up the faces and a few sparkles. Model units: the rock mound has radius 1; the game
// scales each model to its outcrop's footprint.
// Run from the repo root: node unity/Tools/build-crystals.mjs
import { writeFileSync } from 'node:fs';
import { hex, hash, norm, sub, cross, centroid, paintAtlas, projectFaces, writeGlb, MeshBuilder, useDensity, fineRock } from './model-kit.mjs';

const OUT = (name) => new URL(`../Assets/Resources/models/${name}.bytes`, import.meta.url);
const PREVIEW = (name) => new URL(`models/${name}_paint.png`, import.meta.url);

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => a.map((x) => x * k);

// ---------- Palette ----------

// The spirit dimension's grey mountain stone
const ROCK = { base: hex(0x7c7883), dark: hex(0x5c5864), light: hex(0x9a96a0), moss: hex(0x6e6270) };

// ---------- Painting ----------

// One blue for every crystal, big or small: the pale aqua of the tips
const ICE = { body: hex(0x63c4d8), edge: hex(0x8fdcec), streak: hex(0xc8f4fb), root: hex(0x4fb0c6), spark: hex(0xffffff) };

// Crystal side face, row 0 at its root. Each face is mapped with its columns across the face and its
// rows up the crystal, centred on the region's middle column, so the art follows the crystal's own
// axis: one flat blue, light streaks running straight up the length, a slightly deeper root and a
// few sparkles
const sidePaint = (seed) => (r) => {
  const mid = Math.floor(r.w / 2), soft = -Math.round(r.w * 0.1), thin = Math.round(r.w * 0.13);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const d = x - mid;
      let c = y < 3 ? ICE.root : ICE.body;
      if (d === soft || d === soft + 1) c = ICE.edge; // a broad soft highlight up the face
      if (d === thin && y > 4) c = ICE.streak; // and a thin bright one
      if (hash(x + seed * 31, y) > 0.988 && y > 5) c = ICE.spark;
      r.set(x, y, c);
    }
};

// Tip facet, row 0 at the shoulder: the same blue, its middle line lit, brightening at the point
const tipPaint = () => (r) => {
  const mid = Math.floor(r.w / 2);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      let c = ICE.body;
      if (x - mid === -1 || x - mid === 0) c = ICE.edge;
      if (y > r.h * 0.4 && Math.abs(x - mid) <= 1) c = ICE.streak;
      r.set(x, y, c);
    }
};

// Rock mound: the spirit cliffs' grey stone (model-kit fineRock)
const rockPaint = fineRock({ dark: ROCK.dark, base: ROCK.base, light: ROCK.light, high: hex(0xb6b2bc), crack: hex(0x47434e) }, 7);

// ---------- Geometry ----------

// One crystal: a six-sided prism from `base` along `dir` (radius r, body length len) closing to a
// point `tip` beyond it; the root is sunk below the ground so leaning crystals never show their end
function crystal(m, base, dir, r, len, tip, palette, turn = 0) {
  m.part++;
  dir = norm(dir);
  const u = Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : norm(cross(dir, [0, 1, 0]));
  const v = cross(dir, u);
  const root = sub(base, scale(dir, 0.35));
  const ring = (o, rr) => Array.from({ length: 6 }, (_, i) => {
    const t = (i / 6) * Math.PI * 2 + turn;
    return add(o, add(scale(u, Math.cos(t) * rr), scale(v, Math.sin(t) * rr)));
  });
  const lo = ring(root, r), hi = ring(add(base, scale(dir, len)), r * 0.9);
  const apex = add(base, scale(dir, len + tip));
  const axis = (p) => { const d = sub(p, root), s = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]; return add(root, scale(dir, s)); };
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const c = centroid(lo[i], lo[j], hi[i], hi[j]);
    const out = norm(sub(c, axis(c)));
    const anchor = { o: centroid(lo[i], lo[j]), a: norm(sub(lo[j], lo[i])) };
    m.tri(lo[i], lo[j], hi[j], 'side', out, 0, anchor);
    m.tri(lo[i], hi[j], hi[i], 'side', out, 0, anchor);
    const ct = centroid(hi[i], hi[j], apex);
    m.tri(hi[i], hi[j], apex, 'tip', norm(sub(ct, axis(ct))), 0, { o: centroid(hi[i], hi[j]), a: norm(sub(hi[j], hi[i])) });
  }
}

// Low rock mound the crystals grow out of: a jittered ring, a narrower shoulder and a flattened top
function mound(m, radius, height, seed, sides = 9) {
  m.part++;
  const rnd = (k) => hash(seed * 29 + k, seed * 13 + k * 5);
  const ring = (y, s, k0) => Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2 + rnd(k0) * 0.6;
    const rr = radius * s * (0.86 + rnd(k0 + i + 1) * 0.24);
    return [Math.cos(t) * rr, y, Math.sin(t) * rr];
  });
  const lo = ring(-0.05, 1, 1), mid = ring(height * 0.55, 0.78, 20), top = ring(height, 0.45, 40);
  const c = [0, 0, 0];
  m.band(lo, mid, c, () => 'rock');
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const cc = centroid(mid[i], mid[j], top[i], top[j]);
    const out = norm([cc[0], 0.8, cc[2]]);
    m.tri(mid[i], mid[j], top[j], 'rock', out);
    m.tri(mid[i], top[j], top[i], 'rock', out);
  }
  m.cap(top, 'rock');
}

// Crystal size factor of the model being built (the small clusters' crystals are chunkier)
let SIZE = 1;

// A crystal standing at polar (angle, dist) on the mound, leaning `lean` (radians) away from the
// middle, or toward `toward` (angle) when given
function grow(m, rnd, { angle, dist, lean, r, len, tip, palette = 'a', toward = null, y = 0 }) {
  const base = [Math.cos(angle) * dist, y, Math.sin(angle) * dist];
  const away = toward ?? angle;
  const dir = [Math.cos(away) * Math.sin(lean), Math.cos(lean), Math.sin(away) * Math.sin(lean)];
  crystal(m, base, dir, r * SIZE, len * SIZE, tip * SIZE, palette, rnd() * Math.PI);
}

// ---------- Models ----------

const rndOf = (seed) => { let k = 0; return () => hash(seed * 7919 + k++, seed * 104729 + k * 3); };

// Big outcrops: a mound of radius 1, crystals up to ~2.6 tall
const BIG = [
  // 1 Spire: one towering crystal in the middle, a skirt of shorter ones leaning out
  (m, rnd) => {
    mound(m, 1, 0.35, 1);
    grow(m, rnd, { angle: 0, dist: 0.05, lean: 0.06, r: 0.34, len: 2.2, tip: 0.55 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd() * 0.4;
      grow(m, rnd, { angle: a, dist: 0.45 + rnd() * 0.25, lean: 0.35 + rnd() * 0.3, r: 0.13 + rnd() * 0.1, len: 0.7 + rnd() * 0.8, tip: 0.25, palette: i % 2 ? 'b' : 'a' });
    }
  },
  // 2 Twins: two tall crystals side by side, small ones at their feet
  (m, rnd) => {
    mound(m, 1, 0.3, 2);
    grow(m, rnd, { angle: 0.3, dist: 0.28, lean: 0.14, r: 0.28, len: 1.9, tip: 0.45 });
    grow(m, rnd, { angle: Math.PI + 0.2, dist: 0.3, lean: 0.2, r: 0.24, len: 1.5, tip: 0.4, palette: 'b' });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.6;
      grow(m, rnd, { angle: a, dist: 0.6 + rnd() * 0.2, lean: 0.45 + rnd() * 0.3, r: 0.1 + rnd() * 0.08, len: 0.45 + rnd() * 0.55, tip: 0.2, palette: i % 3 ? 'a' : 'b' });
    }
  },
  // 3 Fan: like the reference, a spray of crystals all leaning the same way, longest at the back
  (m, rnd) => {
    mound(m, 1, 0.32, 3);
    const toward = 0.4;
    for (let i = 0; i < 9; i++) {
      const k = i / 8;
      const a = toward + Math.PI + (k - 0.5) * 2.4;
      grow(m, rnd, { angle: a, dist: 0.15 + rnd() * 0.45, lean: 0.25 + k * 0.1 + rnd() * 0.15, toward: toward + (rnd() - 0.5) * 0.6, r: 0.14 + rnd() * 0.14, len: 0.9 + (1 - Math.abs(k - 0.5)) * 1.3 + rnd() * 0.3, tip: 0.35, palette: i % 2 ? 'a' : 'b' });
    }
  },
  // 4 Crown: a ring of crystals leaning out around a short, thick one
  (m, rnd) => {
    mound(m, 1, 0.38, 4);
    grow(m, rnd, { angle: 0, dist: 0, lean: 0, r: 0.3, len: 0.9, tip: 0.5, palette: 'b' });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      grow(m, rnd, { angle: a, dist: 0.42, lean: 0.4 + rnd() * 0.15, r: 0.15 + rnd() * 0.06, len: 1.2 + rnd() * 0.9, tip: 0.35, palette: i % 2 ? 'a' : 'b' });
    }
  },
  // 5 Ridge: a long, jagged wall of crystals across the mound, tallest in the middle
  (m, rnd) => {
    mound(m, 1, 0.3, 5, 11);
    for (let i = 0; i < 9; i++) {
      const k = i / 8 - 0.5;
      const side = i % 2 ? 1 : -1;
      grow(m, rnd, { angle: k < 0 ? Math.PI : 0, dist: Math.abs(k) * 1.5, lean: 0.12 + Math.abs(k) * 0.5, toward: (k < 0 ? Math.PI : 0) + side * 0.5, r: 0.15 + rnd() * 0.1, len: 0.8 + (0.5 - Math.abs(k)) * 2.6 + rnd() * 0.3, tip: 0.35, palette: i % 3 ? 'a' : 'b' });
    }
  },
];

// Small clusters: a mound of radius 1, crystals up to ~1.6 tall (they're scaled to ~2 tiles)
const SMALL = [
  // 1 One crystal and two shards
  (m, rnd) => {
    mound(m, 1, 0.25, 11, 7);
    grow(m, rnd, { angle: 0, dist: 0.1, lean: 0.12, r: 0.32, len: 1.1, tip: 0.4 });
    grow(m, rnd, { angle: 2.2, dist: 0.5, lean: 0.55, r: 0.17, len: 0.55, tip: 0.22, palette: 'b' });
    grow(m, rnd, { angle: 4.0, dist: 0.55, lean: 0.5, r: 0.15, len: 0.45, tip: 0.2 });
  },
  // 2 Trio leaning apart
  (m, rnd) => {
    mound(m, 1, 0.22, 12, 7);
    for (let i = 0; i < 3; i++) grow(m, rnd, { angle: (i / 3) * Math.PI * 2 + 0.3, dist: 0.25, lean: 0.35, r: 0.22, len: 0.8 + i * 0.2, tip: 0.3, palette: i ? 'a' : 'b' });
  },
  // 3 A low bed of short crystals
  (m, rnd) => {
    mound(m, 1, 0.2, 13, 8);
    for (let i = 0; i < 6; i++) grow(m, rnd, { angle: (i / 6) * Math.PI * 2 + rnd(), dist: 0.2 + rnd() * 0.45, lean: 0.3 + rnd() * 0.4, r: 0.15 + rnd() * 0.07, len: 0.35 + rnd() * 0.4, tip: 0.2, palette: i % 2 ? 'a' : 'b' });
  },
  // 4 Leaning pair, like a broken arch
  (m, rnd) => {
    mound(m, 1, 0.24, 14, 7);
    grow(m, rnd, { angle: 0.4, dist: 0.3, lean: 0.5, r: 0.26, len: 1.2, tip: 0.35 });
    grow(m, rnd, { angle: 0.4 + Math.PI, dist: 0.32, lean: 0.4, r: 0.22, len: 0.9, tip: 0.3, palette: 'b' });
    grow(m, rnd, { angle: 1.9, dist: 0.55, lean: 0.6, r: 0.12, len: 0.4, tip: 0.18 });
  },
  // 5 Star: shards splaying out in every direction around a stub
  (m, rnd) => {
    mound(m, 1, 0.22, 15, 8);
    grow(m, rnd, { angle: 0, dist: 0, lean: 0, r: 0.25, len: 0.6, tip: 0.4, palette: 'b' });
    for (let i = 0; i < 5; i++) grow(m, rnd, { angle: (i / 5) * Math.PI * 2, dist: 0.3, lean: 0.75 + rnd() * 0.2, r: 0.13, len: 0.6 + rnd() * 0.3, tip: 0.22 });
  },
];

// Stretches a model upward by k (normals and UV anchors follow)
function stretchY(m, k) {
  const sy = (p) => [p[0], p[1] * k, p[2]];
  m.tris = m.tris.map((t) => {
    const w = t.w.map(sy);
    let n = norm(cross(sub(w[1], w[0]), sub(w[2], w[0])));
    if (n[0] * t.n[0] + n[1] * t.n[1] + n[2] * t.n[2] < 0) n = n.map((x) => -x);
    const anchor = t.anchor && { ...t.anchor, o: sy(t.anchor.o), a: norm(sy(t.anchor.a)) };
    return { ...t, w, out: t.out.map(sy), n, normals: [n, n, n], anchor };
  });
}

function build(name, shape, seed, D, atlas, sideH, tipH, size = 1, tall = 1) {
  SIZE = size;
  const m = new MeshBuilder();
  shape(m, rndOf(seed));
  if (tall !== 1) stretchY(m, tall);
  const w = Math.round(D * 0.85); // wide enough for the thickest crystal's face
  const regions = {
    side: { w, h: sideH, paint: sidePaint(1) },
    tip: { w, h: tipH, paint: tipPaint() },
    rock: { w: Math.round(2.4 * D), h: Math.round(1.2 * D), paint: rockPaint },
  };
  useDensity(name, m.tris, D);
  const rgba = paintAtlas(atlas, regions, false);
  const faces = projectFaces(m.tris, regions, D, atlas, name);
  const { texture } = writeGlb(OUT(name), name, [{ name, ...faces }], atlas, rgba, null);
  writeFileSync(PREVIEW(name), texture);
  // CRYSTAL_DUMP=<dir>: also the raw mesh and atlas, for a quick look without Unity
  if (process.env.CRYSTAL_DUMP) writeFileSync(`${process.env.CRYSTAL_DUMP}/${name}.json`, JSON.stringify({ ...faces, atlas, rgba: Buffer.from(rgba).toString('base64') }));
  const ys = faces.positions.map((q) => q[1]);
  console.log(`${name.padEnd(16)} ${String(m.tris.length).padStart(4)} triangles, ${Math.max(...ys).toFixed(2)} tall`);
}

// Painted at D texels per model unit; the atlas scales them to the game's common density (model-kit
// useDensity). The mountains are built 1.3x taller than their footprint alone would make them
BIG.forEach((shape, i) => build(`crystal_big_${i + 1}`, shape, 100 + i, 32, 256, 128, 32, 1, 1.3));
BIG.forEach((shape, i) => build(`crystal_mid_${i + 1}`, shape, 100 + i, 32, 256, 128, 32));
SMALL.forEach((shape, i) => build(`crystal_small_${i + 1}`, shape, 200 + i, 20, 128, 48, 20, 1.35));
