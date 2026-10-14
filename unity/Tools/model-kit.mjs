// Shared pieces of the pixel-art town center builders (build-*-center.mjs): palette
// helpers, an atlas of painted regions, a normal map derived from the painting, UV projection of flat
// faces at a fixed texel density, and a binary glTF writer.
import { writeFileSync } from 'node:fs';
import { png } from './png.mjs';

export const hex = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
// The rigs' team key (#93ff83); the game swaps it, in any shade, for the player's colour
export const TEAM = [147, 255, 131];
export const team = (k) => TEAM.map((c) => Math.round(c * k));
export const isTeam = (c) => c[1] > c[0] + 50 && c[1] > c[2] + 50;

// Deterministic per-pixel noise for dithering
export const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
export const centroid = (...p) => [0, 1, 2].map((i) => p.reduce((s, q) => s + q[i], 0) / p.length);

// Band pivot for a rectangle ring with edge midpoints (corner, mid, corner, ...): each half-side's
// pattern is mirrored around the side's midpoint, so trims run continuously along upturned eaves
export const midPivot = (ring) => (i) => (i % 2 ? ring[i] : ring[(i + 1) % ring.length]);

// Flat-shaded triangles for projectFaces. Each piece (`part`) keeps its own faces even when coplanar
// with another piece's
export class MeshBuilder {
  tris = [];
  part = 0;

  // Triangle with its normal facing `hint` (outward). `shift` offsets its rows in the atlas region
  // (texels), so patterns can run on from one face to the next (spirals). `anchor` ({ o, a }: a point
  // and a unit direction along the face's bottom edge) maps the region's rows parallel to that edge
  // (row 0 on it) with columns measured from `o`, instead of projecting the triangle's own plane
  tri = (a, b, c, region, hint, shift = 0, anchor = null) => {
    let n = norm(cross(sub(b, a), sub(c, a)));
    if (dot(n, hint) < 0) { [b, c] = [c, b]; n = n.map((x) => -x); }
    this.tris.push({ w: [a, b, c], out: [a, b, c], normals: [n, n, n], n, region, part: this.part, shift, anchor });
  };

  // Side surface between two rings with the same number of points, facing away from `center`'s
  // vertical axis (`down` for eave undersides). `regionFor(normal)` picks the region, `shiftFor(i)`
  // the row offset of face i. Each face's pixel rows run along its bottom edge (so eave trims follow
  // upturned corners), centred on the edge, or on `pivot(i)` when given (a point the pattern is
  // mirrored around, e.g. the middle of a roof side split at its midpoint)
  band(lo, hi, center, regionFor, down = false, shiftFor = () => 0, pivot = null) {
    for (let i = 0; i < lo.length; i++) {
      const j = (i + 1) % lo.length;
      const c = centroid(lo[i], lo[j], hi[i], hi[j]);
      const out = norm([c[0] - center[0], 0, c[2] - center[2]]);
      const hint = down ? [out[0] * 0.3, -1, out[2] * 0.3] : out;
      const o = pivot?.(i) ?? centroid(lo[i], lo[j]);
      const far = dot(sub(lo[i], o), sub(lo[i], o)) > dot(sub(lo[j], o), sub(lo[j], o)) ? lo[i] : lo[j];
      const anchor = { o, a: norm(sub(far, o)), mirror: !!pivot };
      this.tri(lo[i], lo[j], hi[j], regionFor(hint), hint, shiftFor(i), anchor);
      this.tri(lo[i], hi[j], hi[i], regionFor(hint), hint, shiftFor(i), anchor);
    }
  }

  // Flat cap over a ring
  cap(pts, region, up = true) {
    const c = centroid(...pts);
    for (let i = 0; i < pts.length; i++) this.tri(c, pts[i], pts[(i + 1) % pts.length], region, [0, up ? 1 : -1, 0]);
  }
}

// Base colours are toned down so every model shares one soft, slightly greyed palette (the team
// green stays as is: the game swaps it for the player's pastel colour)
export function muted([r, g, b]) {
  const l = (r * 0.3 + g * 0.59 + b * 0.11);
  const k = 0.72; // saturation kept
  return [r, g, b].map((c) => Math.round(Math.min(255, (l + (c - l) * k) * 0.94 + 10)));
}

// Packs `regions` ({ name: { w, h, paint(r) } }) into a size x size atlas and paints them. Painters
// draw with r.set(x, y, rgb) / r.fill(x, y, w, h, rgb), y = 0 being the region's bottom row; base
// colours are muted unless `mute` is false
export function paintAtlas(size, regions, mute = true) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  // Shelf packing with a 1 px gutter around each region
  let x = 1, y = 1, shelf = 0;
  for (const r of Object.values(regions).sort((a, b) => b.h - a.h)) {
    if (x + r.w + 1 > size) { x = 1; y += shelf + 2; shelf = 0; }
    Object.assign(r, { x, y });
    x += r.w + 2;
    shelf = Math.max(shelf, r.h);
    if (y + r.h + 1 > size) throw new Error('Atlas too small');
  }
  const at = (x, y) => ((y * size) + x) * 4;
  for (const r of Object.values(regions)) {
    r.set = (x, y, c) => {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
      const i = at(r.x + x, r.y + r.h - 1 - y);
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    };
    r.fill = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) r.set(x, y, c); };
    r.paint(r);
    if (mute) for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = at(x, y);
        const c = [rgba[i], rgba[i + 1], rgba[i + 2]];
        if (!isTeam(c)) rgba.set(muted(c), i);
      }
    // Gutter: repeat the edge pixels so point sampling at a face's border never picks a neighbour
    for (let y = r.y - 1; y <= r.y + r.h; y++)
      for (let x = r.x - 1; x <= r.x + r.w; x++) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
        const sx = Math.min(r.x + r.w - 1, Math.max(r.x, x)), sy = Math.min(r.y + r.h - 1, Math.max(r.y, y));
        rgba.copyWithin(at(x, y), at(sx, sy), at(sx, sy) + 4);
      }
  }
  return rgba;
}

// Tangent-space normals (OpenGL convention, +green = up in the image) from the relief `heightOf(rgb)`
// of each pixel's neighbours inside its own region
export function normalMap(rgba, size, regions, heightOf, strength) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) out.set([128, 128, 255, 255], i * 4);
  const h = (x, y) => heightOf(rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 3));
  for (const r of Object.values(regions)) {
    const at = (x, y) => h(Math.min(r.x + r.w - 1, Math.max(r.x, x)), Math.min(r.y + r.h - 1, Math.max(r.y, y)));
    for (let y = r.y - 1; y <= r.y + r.h; y++)
      for (let x = r.x - 1; x <= r.x + r.w; x++) {
        const cx = Math.min(r.x + r.w - 1, Math.max(r.x, x)), cy = Math.min(r.y + r.h - 1, Math.max(r.y, y));
        const dx = (at(cx + 1, cy) - at(cx - 1, cy)) * strength;
        const dy = (at(cx, cy - 1) - at(cx, cy + 1)) * strength; // image rows grow downward
        const l = Math.hypot(dx, dy, 1);
        out.set([(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
      }
  }
  return out;
}

// UVs for triangles { w: 3 points in model space, out: 3 vertex positions to write, normals: 3
// normals, n: face normal, region, part? }. Coplanar triangles of a region form a face, projected at `D`
// texels per unit into its region, anchored at the face's bottom and centred horizontally (flat caps
// are centred both ways), so pixels are the same size everywhere
export function projectFaces(tris, regions, D, size, label = '') {
  const faces = new Map();
  for (const t of tris) {
    const key = t.anchor
      ? ['A', t.part ?? '', t.shift ?? 0, t.region, ...t.anchor.o.map((x) => x.toFixed(3)), ...t.anchor.a.map((x) => x.toFixed(3))].join('|')
      : [t.part ?? '', t.shift ?? 0, t.region, ...t.n.map((x) => x.toFixed(2)), dot(t.n, t.w[0]).toFixed(2)].join('|');
    if (!faces.has(key)) faces.set(key, []);
    faces.get(key).push(t);
  }
  const positions = [], normals = [], uvs = [];
  for (const group of faces.values()) {
    if (group[0].anchor) {
      // Columns along the bottom edge from the anchor, rows = distance from the edge line
      const { region, anchor: { o, a, mirror } } = group[0];
      const r = regions[region];
      if (!r) throw new Error(`Unknown region ${region}`);
      const along = (p) => dot(sub(p, o), a);
      const away = (p) => { const d = sub(p, o), s = dot(d, a); return Math.hypot(d[0] - a[0] * s, d[1] - a[1] * s, d[2] - a[2] * s); };
      const pts = group.flatMap((t) => t.w);
      const s = pts.map(along), hTex = Math.max(...pts.map(away)) * D;
      const sMid = mirror ? 0 : (Math.min(...s) + Math.max(...s)) / 2;
      const wTex = (mirror ? 2 * Math.max(...s.map(Math.abs)) : Math.max(...s) - Math.min(...s)) * D;
      if (wTex > r.w + 0.5 || hTex + (group[0].shift ?? 0) > r.h + 0.5) console.warn(`${label} ${region}: face ${wTex.toFixed(1)}x${hTex.toFixed(1)} > region ${r.w}x${r.h}`);
      for (const tri of group)
        tri.w.forEach((p, k) => {
          positions.push(tri.out[k]);
          normals.push(tri.normals[k]);
          uvs.push([(r.x + r.w / 2 + (along(p) - sMid) * D) / size, (r.y + r.h - away(p) * D - (tri.shift ?? 0)) / size]);
        });
      continue;
    }
    const { n, region } = group[0];
    const r = regions[region];
    if (!r) throw new Error(`Unknown region ${region}`);
    const flat = Math.abs(n[1]) > 0.99;
    const sAxis = flat ? [1, 0, 0] : norm(cross([0, 1, 0], n));
    const tAxis = flat ? [0, 0, 1] : cross(n, sAxis);
    const pts = group.flatMap((t) => t.w);
    const s = pts.map((p) => dot(p, sAxis)), t = pts.map((p) => dot(p, tAxis));
    const sMid = (Math.min(...s) + Math.max(...s)) / 2, tMin = Math.min(...t), tMid = (tMin + Math.max(...t)) / 2;
    const wTex = (Math.max(...s) - Math.min(...s)) * D, hTex = (Math.max(...t) - tMin) * D;
    if (wTex > r.w + 0.5 || hTex + (group[0].shift ?? 0) > r.h + 0.5) console.warn(`${label} ${region}: face ${wTex.toFixed(1)}x${hTex.toFixed(1)} > region ${r.w}x${r.h}`);
    for (const tri of group)
      tri.w.forEach((p, k) => {
        const px = r.x + r.w / 2 + (dot(p, sAxis) - sMid) * D;
        const row = flat ? r.y + r.h / 2 - (dot(p, tAxis) - tMid) * D : r.y + r.h - (dot(p, tAxis) - tMin) * D - (tri.shift ?? 0);
        positions.push(tri.out[k]);
        normals.push(tri.normals[k]);
        uvs.push([px / size, row / size]);
      });
  }
  return { positions, normals, uvs };
}

// Writes a .glb with one double-sided material (base colour + normal map unless `normals` is null,
// nearest filtering) and a node per mesh ({ name, translation?, scale?, positions, normals, uvs })
export function writeGlb(url, name, meshList, atlasSize, rgba, normals) {
  const texture = png(atlasSize, atlasSize, rgba);
  const normalTexture = normals ? png(atlasSize, atlasSize, normals) : null;
  const chunks = [];
  let offset = 0;
  const views = [], accessors = [];
  function addView(buf, target) {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf);
    offset += buf.length;
    return views.length - 1;
  }
  function addFloats(list, type) {
    const n = list[0].length, buf = Buffer.alloc(list.length * n * 4);
    list.forEach((e, i) => e.forEach((x, c) => buf.writeFloatLE(x, (i * n + c) * 4)));
    const acc = { bufferView: addView(buf, 34962), componentType: 5126, count: list.length, type };
    if (type === 'VEC3') {
      acc.min = [0, 1, 2].map((c) => Math.min(...list.map((e) => e[c])));
      acc.max = [0, 1, 2].map((c) => Math.max(...list.map((e) => e[c])));
    }
    accessors.push(acc);
    return accessors.length - 1;
  }
  const meshes = meshList.map(({ name: meshName, positions, normals: nrm, uvs }) => {
    const big = positions.length > 65535;
    const indices = Buffer.alloc(positions.length * (big ? 4 : 2));
    for (let i = 0; i < positions.length; i++) big ? indices.writeUInt32LE(i, i * 4) : indices.writeUInt16LE(i, i * 2);
    const attributes = { POSITION: addFloats(positions, 'VEC3'), NORMAL: addFloats(nrm, 'VEC3'), TEXCOORD_0: addFloats(uvs, 'VEC2') };
    accessors.push({ bufferView: addView(indices, 34963), componentType: big ? 5125 : 5123, count: positions.length, type: 'SCALAR' });
    return { name: meshName, primitives: [{ attributes, indices: accessors.length - 1, material: 0 }] };
  });
  const imageView = addView(texture);
  const normalView = normalTexture ? addView(normalTexture) : null;
  const pad4 = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)]);
  const bin = pad4(Buffer.concat(chunks), 0);
  const out = {
    asset: { version: '2.0', generator: 'rts-ia model-kit.mjs' },
    scene: 0,
    scenes: [{ nodes: meshList.map((_, i) => i) }],
    nodes: meshList.map((m, i) => ({ name: m.name, mesh: i, ...(m.translation ? { translation: m.translation } : {}), ...(m.scale ? { scale: m.scale } : {}) })),
    meshes,
    materials: [{ name, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, ...(normalTexture ? { normalTexture: { index: 1 } } : {}) }],
    textures: [{ source: 0, sampler: 0 }, ...(normalTexture ? [{ source: 1, sampler: 0 }] : [])],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: imageView, mimeType: 'image/png' }, ...(normalTexture ? [{ bufferView: normalView, mimeType: 'image/png' }] : [])],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  const json = pad4(Buffer.from(JSON.stringify(out)), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHeader = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  writeFileSync(url, Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin]));
  return { texture, normalTexture };
}

// ---------- Ages ----------
// Every building comes in a look per age: rustic and low in the first, as designed in the second,
// taller and richer in the third. File names: `${name}_a1`, `${name}`, `${name}_a3`.
export const AGE_SUFFIX = { 1: '_a1', 2: '', 3: '_a3' };
const AGE_HEIGHT = { 1: 0.84, 2: 1, 3: 1.14 };

// The model's triangles for an age: heights scaled (normals and UV anchors follow)
export function ageTris(tris, age) {
  const k = AGE_HEIGHT[age];
  if (k === 1) return tris;
  const sy = (p) => [p[0], p[1] * k, p[2]];
  return tris.map((t) => {
    const w = t.w.map(sy);
    let n = norm(cross(sub(w[1], w[0]), sub(w[2], w[0])));
    if (dot(n, t.n) < 0) n = n.map((x) => -x);
    const anchor = t.anchor && { ...t.anchor, o: sy(t.anchor.o), a: norm(sy(t.anchor.a)) };
    return { ...t, w, out: t.out.map(sy), n, normals: [n, n, n], anchor };
  });
}

// Third-age banners for models with `post` and `banner` regions: a team banner on a pole at each
// front corner (front = +z)
export function bannerTris(tris) {
  const m = new MeshBuilder();
  m.part = 999;
  const pts = tris.flatMap((t) => t.w);
  const minX = Math.min(...pts.map((q) => q[0])), maxX = Math.max(...pts.map((q) => q[0]));
  const maxZ = Math.max(...pts.map((q) => q[2])), maxY = Math.max(...pts.map((q) => q[1]));
  const w = maxX - minX, h = Math.min(maxY * 0.6, w * 0.35), r = w * 0.008;
  const quad = (a, b, c, d, region, n) => { m.tri(a, b, c, region, n); m.tri(a, c, d, region, n); };
  for (const x of [minX + w * 0.05, maxX - w * 0.05]) {
    const z = maxZ - w * 0.04;
    m.part++;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const ox = dz ? r : 0, oz = dx ? r : 0;
      quad([x + dx * r - ox, 0, z + dz * r - oz], [x + dx * r + ox, 0, z + dz * r + oz], [x + dx * r + ox, h, z + dz * r + oz], [x + dx * r - ox, h, z + dz * r - oz], 'post', [dx, 0, dz]);
    }
    m.part++;
    const side = x < (minX + maxX) / 2 ? 1 : -1, bw = w * 0.07, bh = w * 0.11;
    const x0 = x + side * r, x1 = x + side * (r + bw);
    quad([x0, h - bh, z], [x1, h - bh, z], [x1, h - r, z], [x0, h - r, z], 'banner', [0, 0, 1]);
    quad([x0, h - bh, z], [x1, h - bh, z], [x1, h - r, z], [x0, h - r, z], 'banner', [0, 0, -1]);
  }
  return m.tris;
}

// The painted atlas for an age (town centers, which have their own painters): in the first age every
// surface but the team-coloured roofs turns to wood, its light and shade kept as grain; in the third
// the colours deepen and the brightest details turn to gold
const WOOD_RAMP = [0x3a2a20, 0x553e2e, 0x735640, 0x93724f, 0xb39064, 0xcdb084].map(hex);
const GILT_RAMP = [hex(0xa8843e), hex(0xd8b25e), hex(0xf0dc9a)];
export function ageTint(rgba, age) {
  if (age === 2) return rgba;
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const c = [out[i], out[i + 1], out[i + 2]];
    if (isTeam(c)) continue;
    const l = (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255;
    let t;
    if (age === 1) {
      const f = Math.min(0.999, Math.max(0, (l - 0.1) / 0.8)) * (WOOD_RAMP.length - 1);
      const k = Math.floor(f);
      t = WOOD_RAMP[k].map((x, j) => x + (WOOD_RAMP[k + 1][j] - x) * (f - k));
    } else {
      // Richer colour; what is already gold or yellow becomes bright gilt
      const L = l * 255;
      t = c.map((x) => (L + (x - L) * 1.15) * 1.04);
      const yellow = c[0] > c[2] + 60 && c[1] > c[2] + 30 && c[0] > 150;
      if (yellow) t = GILT_RAMP[l > 0.75 ? 2 : l > 0.55 ? 1 : 0];
    }
    out.set(t.map((x) => Math.max(0, Math.min(255, Math.round(x)))), i);
  }
  return out;
}

// Writes a model's three ages (`out(suffix)` -> URL) from its painted atlas; returns the second
// age's textures for previews
export function writeAges(out, name, nodeName, tris, regions, D, atlas, rgba, heightOf, strength, label) {
  let base;
  for (const age of [1, 2, 3]) {
    const tinted = ageTint(rgba, age);
    const aged = ageTris(tris, age);
    if (age === 3 && regions.banner && regions.post) aged.push(...bannerTris(aged));
    const faces = projectFaces(aged, regions, D, atlas, label);
    const written = writeGlb(out(AGE_SUFFIX[age]), name + AGE_SUFFIX[age], [{ name: nodeName, ...faces }], atlas, tinted, normalMap(tinted, atlas, regions, heightOf, strength));
    if (age === 2) base = written;
  }
  return base;
}
