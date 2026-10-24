// Builds the small low-poly decorations scattered over the generated maps (purely cosmetic, placed by
// World/Decor.cs) into Assets/Resources/models, painted in pixel art like the other props:
//   decor_rocks, decor_stump, decor_log, decor_mushrooms, decor_flowers         classic valley
//   spirit_shards, spirit_mushrooms, spirit_lantern, spirit_cairn, spirit_stump,
//   spirit_flowers                                                              spirit dimension
// Model units are tiles; each prop is about half a tile wide (the game draws them about twice that).
// Run from the repo root: node unity/Tools/build-decor.mjs
import { writeFileSync } from 'node:fs';
import { hex, hash, norm, sub, cross, centroid, paintAtlas, projectFaces, writeGlb, MeshBuilder, useDensity, fineRock } from './model-kit.mjs';

const OUT = (name) => new URL(`../Assets/Resources/models/${name}.bytes`, import.meta.url);
const PREVIEW = (name) => new URL(`models/${name}_paint.png`, import.meta.url);
const D = 24; // texels per tile: the props are small, so a little finer than the ground
const ATLAS = 64;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => a.map((x) => x * k);

// ---------- Geometry ----------

// Low-poly rock with a flat, slightly tilted top (see build-props.mjs), standing at height y0
function lowRock(m, cx, cz, r, h, seed, region, sides = 6, y0 = 0, topRegion = region) {
  m.part++;
  const rnd = (k) => hash(seed * 37 + k, seed * 11 + k * 13);
  const turn = rnd(0) * Math.PI * 2;
  const radii = Array.from({ length: sides }, (_, i) => 0.82 + rnd(i + 1) * 0.36);
  const angles = Array.from({ length: sides }, (_, i) => turn + ((i + (rnd(i + 30) - 0.5) * 0.5) / sides) * Math.PI * 2);
  const tx = (rnd(60) - 0.5) * 0.4, tz = (rnd(61) - 0.5) * 0.4;
  const ring = (y, s, tilt) => angles.map((a, i) => {
    const x = Math.cos(a) * r * s * radii[i], z = Math.sin(a) * r * s * radii[i];
    return [cx + x, y0 + y + (tilt ? (x * tx + z * tz) * h / r : 0), cz + z];
  });
  const lo = ring(0, 1, false), mid = ring(h * 0.5, 1.06, false), top = ring(h, 0.62, true);
  m.band(lo, mid, [cx, 0, cz], () => region);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const c = centroid(mid[i], mid[j], top[i], top[j]);
    const out = norm([c[0] - cx, 0.7, c[2] - cz]);
    m.tri(mid[i], mid[j], top[j], region, out);
    m.tri(mid[i], top[j], top[i], region, out);
  }
  m.cap(top, topRegion);
}

// Prism from a to b: `sides` faces, radius ra at a and rb at b, capped at b (and at a when `capA`)
function prism(m, a, b, ra, rb, sides, side, cap, capA = false) {
  m.part++;
  const axis = norm(sub(b, a));
  const u = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : norm(cross(axis, [0, 1, 0]));
  const v = cross(axis, u);
  const ring = (o, r) => Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2 + Math.PI / sides;
    return add(o, add(scale(u, Math.cos(t) * r), scale(v, Math.sin(t) * r)));
  });
  const A = ring(a, ra), B = ring(b, rb);
  const mid = centroid(a, b);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const out = norm(sub(centroid(A[i], A[j], B[i], B[j]), mid));
    m.tri(A[i], A[j], B[j], side, out);
    m.tri(A[i], B[j], B[i], side, out);
    if (cap) m.tri(b, B[i], B[j], cap, axis);
    if (capA) m.tri(a, A[i], A[j], capA, scale(axis, -1));
  }
}

// Mushroom: a stem and a faceted cap (flat underside, rising to a low point)
function mushroom(m, x, z, h, r, lean, capRegion, stemRegion = 'stem', underRegion = 'gill') {
  const top = [x + lean[0], h, z + lean[1]];
  prism(m, [x, 0, z], top, r * 0.28, r * 0.22, 5, stemRegion, null);
  m.part++;
  const sides = 7;
  const rim = Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2;
    return [top[0] + Math.cos(t) * r, h - r * 0.15, top[2] + Math.sin(t) * r];
  });
  const shoulder = rim.map((p) => [top[0] + (p[0] - top[0]) * 0.6, h + r * 0.35, top[2] + (p[2] - top[2]) * 0.6]);
  const apex = [top[0], h + r * 0.55, top[2]];
  m.band(rim, shoulder, top, () => capRegion);
  for (let i = 0; i < sides; i++) m.tri(shoulder[i], shoulder[(i + 1) % sides], apex, capRegion, norm([shoulder[i][0] - top[0], 1.5, shoulder[i][2] - top[2]]));
  m.cap(rim, underRegion, false);
}

// Flower: a thin stem and a flat five-petal star of a colour, with a centre
function flower(m, x, z, h, r, petal, centre = 'centre') {
  prism(m, [x, 0, z], [x, h, z], 0.012, 0.01, 4, 'stem', null);
  m.part++;
  const pts = Array.from({ length: 10 }, (_, i) => {
    const t = (i / 10) * Math.PI * 2, rr = i % 2 ? r * 0.45 : r;
    return [x + Math.cos(t) * rr, h + (i % 2 ? 0 : r * 0.25), z + Math.sin(t) * rr];
  });
  const c = [x, h + 0.01, z];
  for (let i = 0; i < 10; i++) m.tri(c, pts[i], pts[(i + 1) % 10], petal, [0, 1, 0]);
  lowRock(m, x, z, r * 0.3, r * 0.2, Math.round(x * 100 + z * 37), centre, 5, h);
}

// Crystal shard (six-sided prism with a point), leaning out
function shard(m, x, z, r, len, tip, lean, angle, side, point) {
  const dir = norm([Math.cos(angle) * Math.sin(lean), Math.cos(lean), Math.sin(angle) * Math.sin(lean)]);
  const base = [x, -0.04, z];
  prism(m, base, add(base, scale(dir, len)), r, r * 0.9, 6, side, null);
  m.part++;
  const u = Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : norm(cross(dir, [0, 1, 0]));
  const v = cross(dir, u);
  const end = add(base, scale(dir, len)), apex = add(base, scale(dir, len + tip));
  const ring = Array.from({ length: 6 }, (_, i) => {
    const t = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return add(end, add(scale(u, Math.cos(t) * r * 0.9), scale(v, Math.sin(t) * r * 0.9)));
  });
  for (let i = 0; i < 6; i++) m.tri(ring[i], ring[(i + 1) % 6], apex, point, norm(sub(centroid(ring[i], ring[(i + 1) % 6], apex), end)));
}

// ---------- Painting ----------

const fill = (c) => (r) => r.fill(0, 0, r.w, r.h, hex(c));
// Base colour with a darker bottom row and scattered 2x1 highlights / 1 px shadows
const speckle = (base, light, dark) => (r) => {
  r.fill(0, 0, r.w, r.h, hex(base));
  r.fill(0, 0, r.w, 1, hex(dark));
  for (let y = 1; y < r.h; y += 2)
    for (let x = (y % 4 === 1 ? 0 : 2); x < r.w; x += 3) {
      const n = hash(x + r.w, y + r.h);
      if (n > 0.78) r.fill(x, y, 2, 1, hex(light));
      else if (n < 0.22) r.set(x, y, hex(dark));
    }
};
// Wood end: growth rings around the middle
const rings = (light, dark) => (r) => {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const d = Math.hypot(x + 0.5 - r.w / 2, y + 0.5 - r.h / 2);
      r.set(x, y, hex(Math.floor(d / 1.6) % 2 ? dark : light));
    }
};
// Bark: vertical grooves
const bark = (base, dark) => (r) => {
  r.fill(0, 0, r.w, r.h, hex(base));
  for (let x = 0; x < r.w; x += 3) for (let y = 0; y < r.h; y++) if (hash(x, y >> 1) > 0.35) r.set(x, y, hex(dark));
};
// Mushroom cap with pale dots
const dotted = (base, dot, dark) => (r) => {
  r.fill(0, 0, r.w, r.h, hex(base));
  r.fill(0, 0, r.w, 1, hex(dark));
  for (let y = 1; y < r.h; y += 3) for (let x = (y % 2) * 2; x < r.w; x += 4) if (hash(x, y) > 0.45) r.fill(x, y, 2, 2, hex(dot));
};
// Crystal: deep at the root, pale toward the tip
const glassy = (stops) => (r) => {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) r.set(x, y, hex(stops[Math.min(stops.length - 1, Math.floor((y / r.h) * stops.length + (((x >> 1) + (y >> 1)) & 1) * 0.4))]));
};

// ---------- Models ----------

// `mute`: tone the colours down into the game's soft palette (off for the glowing crystal shards)
function build(name, regions, shape, mute = true) {
  const m = new MeshBuilder();
  shape(m);
  useDensity(name, m.tris, D);
  const rgba = paintAtlas(ATLAS, regions, mute);
  const faces = projectFaces(m.tris, regions, D, ATLAS, name);
  const { texture } = writeGlb(OUT(name), name, [{ name, ...faces }], ATLAS, rgba, null);
  writeFileSync(PREVIEW(name), texture);
  if (process.env.CRYSTAL_DUMP) writeFileSync(`${process.env.CRYSTAL_DUMP}/${name}.json`, JSON.stringify({ ...faces, atlas: ATLAS, rgba: Buffer.from(rgba).toString('base64') }));
  const xs = faces.positions.map((q) => q[0]), zs = faces.positions.map((q) => q[2]), ys = faces.positions.map((q) => q[1]);
  console.log(`${name.padEnd(17)} ${String(m.tris.length).padStart(4)} triangles, ${Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)).toFixed(2)} wide, ${Math.max(...ys).toFixed(2)} tall`);
}

// Classic valley

build('decor_rocks', {
  rock: { w: 16, h: 12, paint: fineRock({ base: hex(0x8c857a), light: hex(0xaaa396), dark: hex(0x655f56), high: hex(0xc4bdb0), crack: hex(0x4a453e) }, 9) },
  moss: { w: 16, h: 16, paint: speckle(0x6f8a4a, 0x8aa45c, 0x56703a) },
}, (m) => {
  lowRock(m, -0.08, 0, 0.16, 0.14, 1, 'rock', 6, 0, 'moss');
  lowRock(m, 0.15, 0.08, 0.1, 0.08, 2, 'rock', 6);
  lowRock(m, 0.04, -0.17, 0.07, 0.05, 3, 'rock', 5);
});

build('decor_stump', {
  bark: { w: 24, h: 10, paint: bark(0x6d4f37, 0x523a28) },
  rings: { w: 10, h: 10, paint: rings(0xc8a174, 0xa98457) },
  moss: { w: 8, h: 8, paint: speckle(0x6f8a4a, 0x8aa45c, 0x56703a) },
}, (m) => {
  prism(m, [0, 0, 0], [0, 0.17, 0], 0.15, 0.13, 7, 'bark', 'rings');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    prism(m, [Math.cos(a) * 0.1, 0.07, Math.sin(a) * 0.1], [Math.cos(a) * 0.24, -0.01, Math.sin(a) * 0.24], 0.04, 0.02, 4, 'bark', null);
  }
  lowRock(m, 0.2, -0.12, 0.05, 0.04, 9, 'moss', 5);
});

build('decor_log', {
  bark: { w: 30, h: 14, paint: bark(0x6d4f37, 0x523a28) },
  rings: { w: 8, h: 8, paint: rings(0xc8a174, 0xa98457) },
  cap: { w: 6, h: 6, paint: dotted(0xb8533d, 0xf3e6cf, 0x8a3a2a) },
  stem: { w: 6, h: 6, paint: fill(0xe9dcc0) },
  gill: { w: 6, h: 6, paint: fill(0xcdbb98) },
}, (m) => {
  prism(m, [-0.3, 0.08, -0.05], [0.3, 0.07, 0.06], 0.085, 0.075, 7, 'bark', 'rings', 'rings');
  prism(m, [0.05, 0.13, 0.0], [0.12, 0.25, -0.02], 0.025, 0.012, 4, 'bark', null); // broken branch
  mushroom(m, -0.12, 0.13, 0.08, 0.045, [0, 0], 'cap');
});

build('decor_mushrooms', {
  cap: { w: 8, h: 8, paint: dotted(0xc0503a, 0xf6ead4, 0x8e3626) },
  stem: { w: 6, h: 8, paint: fill(0xece0c6) },
  gill: { w: 8, h: 8, paint: fill(0xd2c09c) },
}, (m) => {
  mushroom(m, 0, 0, 0.16, 0.09, [0.01, 0], 'cap');
  mushroom(m, 0.13, 0.06, 0.1, 0.06, [0.02, 0.01], 'cap');
  mushroom(m, -0.09, 0.11, 0.07, 0.045, [-0.01, 0.01], 'cap');
  mushroom(m, 0.05, -0.12, 0.05, 0.035, [0, 0], 'cap');
});

build('decor_flowers', {
  stem: { w: 4, h: 6, paint: fill(0x4f7a36) },
  yellow: { w: 8, h: 8, paint: fill(0xf2cf4a) },
  white: { w: 8, h: 8, paint: fill(0xf3efe6) },
  lilac: { w: 8, h: 8, paint: fill(0xb79be0) },
  centre: { w: 6, h: 6, paint: fill(0xd88a2a) },
  leaf: { w: 10, h: 8, paint: speckle(0x5f8a3e, 0x79a44e, 0x4a6e2e) },
}, (m) => {
  const spots = [[0, 0, 'yellow'], [0.14, 0.05, 'white'], [-0.12, 0.08, 'lilac'], [0.05, -0.13, 'yellow'], [-0.06, -0.08, 'white'], [0.16, -0.1, 'lilac']];
  spots.forEach(([x, z, c], i) => flower(m, x, z, 0.1 + hash(i, 3) * 0.08, 0.045, c));
  lowRock(m, 0, 0.02, 0.12, 0.03, 4, 'leaf', 7); // leafy base
});

// Spirit dimension

const SPIRIT_STONE = fineRock({ base: hex(0x7c7883), light: hex(0x9a96a0), dark: hex(0x5c5864), high: hex(0xb6b2bc), crack: hex(0x47434e) }, 8);

build('spirit_shards', {
  side: { w: 12, h: 16, paint: glassy([0x123f50, 0x1c5d72, 0x2f8ea6, 0x63c4d8, 0xa9ecf6]) },
  point: { w: 8, h: 6, paint: glassy([0x63c4d8, 0xa9ecf6, 0xd4f8fd]) },
  rock: { w: 12, h: 8, paint: SPIRIT_STONE },
}, (m) => {
  shard(m, 0, 0, 0.06, 0.26, 0.09, 0.15, 0, 'side', 'point');
  shard(m, 0.1, 0.06, 0.045, 0.15, 0.07, 0.6, 0.5, 'side', 'point');
  shard(m, -0.08, 0.08, 0.04, 0.12, 0.06, 0.65, 2.6, 'side', 'point');
  shard(m, 0.02, -0.1, 0.035, 0.09, 0.05, 0.7, 4.6, 'side', 'point');
  lowRock(m, 0.12, -0.1, 0.06, 0.04, 21, 'rock', 5);
}, false);

build('spirit_mushrooms', {
  cap: { w: 8, h: 8, paint: dotted(0x5fc8d6, 0xe6fcff, 0x2f8ea6) },
  violet: { w: 8, h: 8, paint: dotted(0x9a7ad8, 0xf0e6ff, 0x6a52a8) },
  stem: { w: 6, h: 10, paint: fill(0xe8eef4) },
  gill: { w: 8, h: 8, paint: fill(0xbfe8f0) },
}, (m) => {
  mushroom(m, 0, 0, 0.26, 0.07, [0.02, 0], 'cap');
  mushroom(m, 0.12, 0.05, 0.18, 0.055, [0.03, 0.01], 'violet');
  mushroom(m, -0.09, 0.09, 0.12, 0.045, [-0.02, 0.01], 'cap');
  mushroom(m, 0.04, -0.11, 0.09, 0.035, [0, -0.01], 'violet');
});

build('spirit_lantern', {
  stone: { w: 16, h: 12, paint: SPIRIT_STONE },
  light: { w: 8, h: 8, paint: (r) => { r.fill(0, 0, r.w, r.h, hex(0xffe9a6)); r.fill(0, 0, r.w, 1, hex(0xf2b84a)); r.fill(2, 2, r.w - 4, r.h - 4, hex(0xfff8dc)); } },
  roof: { w: 16, h: 10, paint: speckle(0x6a6672, 0x8a8692, 0x4c4854) },
}, (m) => {
  lowRock(m, 0, 0, 0.13, 0.05, 31, 'stone', 6);
  prism(m, [0, 0.05, 0], [0, 0.22, 0], 0.045, 0.04, 4, 'stone', null);
  prism(m, [0, 0.22, 0], [0, 0.25, 0], 0.09, 0.09, 4, 'stone', 'stone');
  prism(m, [0, 0.25, 0], [0, 0.33, 0], 0.06, 0.06, 4, 'light', null);
  prism(m, [0, 0.33, 0], [0, 0.36, 0], 0.13, 0.12, 4, 'roof', null);
  prism(m, [0, 0.36, 0], [0, 0.44, 0], 0.12, 0.012, 4, 'roof', null);
});

build('spirit_cairn', {
  stone: { w: 16, h: 12, paint: SPIRIT_STONE },
  pale: { w: 16, h: 12, paint: speckle(0xb2aeb8, 0xcfcbd4, 0x8a8692) },
}, (m) => {
  lowRock(m, 0, 0, 0.15, 0.07, 41, 'stone', 7);
  lowRock(m, 0.01, 0.01, 0.11, 0.06, 42, 'pale', 6, 0.065);
  lowRock(m, -0.01, 0, 0.075, 0.05, 43, 'stone', 6, 0.12);
  lowRock(m, 0, 0.01, 0.045, 0.04, 44, 'pale', 5, 0.165);
  lowRock(m, 0.17, 0.1, 0.05, 0.04, 45, 'stone', 5);
});

build('spirit_stump', {
  bark: { w: 24, h: 14, paint: bark(0xd8d2c8, 0xa9a298) },
  rings: { w: 10, h: 10, paint: rings(0xeee8dc, 0xc8c0b2) },
}, (m) => {
  prism(m, [0, 0, 0], [0.01, 0.26, 0], 0.11, 0.08, 6, 'bark', 'rings');
  // Bare, twisted branches
  prism(m, [0, 0.2, 0], [0.16, 0.36, 0.04], 0.03, 0.008, 4, 'bark', null);
  prism(m, [0, 0.16, 0], [-0.14, 0.27, -0.06], 0.025, 0.007, 4, 'bark', null);
  prism(m, [0, 0.24, 0], [-0.03, 0.4, 0.09], 0.022, 0.006, 4, 'bark', null);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1;
    prism(m, [Math.cos(a) * 0.07, 0.05, Math.sin(a) * 0.07], [Math.cos(a) * 0.19, -0.01, Math.sin(a) * 0.19], 0.03, 0.015, 4, 'bark', null);
  }
});

build('spirit_flowers', {
  stem: { w: 4, h: 6, paint: fill(0x2f6e64) },
  lilac: { w: 8, h: 8, paint: fill(0xc6a8f0) },
  white: { w: 8, h: 8, paint: fill(0xf4f0ff) },
  aqua: { w: 8, h: 8, paint: fill(0x8fe4ee) },
  centre: { w: 6, h: 6, paint: fill(0xfff1a8) },
  leaf: { w: 10, h: 8, paint: speckle(0x2f6e64, 0x3f8a7c, 0x22544c) },
}, (m) => {
  const spots = [[0, 0, 'lilac'], [0.13, 0.06, 'white'], [-0.12, 0.07, 'aqua'], [0.04, -0.13, 'lilac'], [-0.07, -0.08, 'white']];
  spots.forEach(([x, z, c], i) => flower(m, x, z, 0.12 + hash(i, 5) * 0.1, 0.05, c));
  lowRock(m, 0, 0.0, 0.12, 0.03, 5, 'leaf', 7);
});
