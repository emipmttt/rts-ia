// Territory minimap: the whole map split into irregular regions (Voronoi cells around jittered grid
// seeds). A region belongs to the last faction that held it alone: units count, buildings count
// triple, and a region where several factions are present is contested and keeps its owner.
// Purely visual - the server knows nothing about regions.
import { TILE_SIZE, Terrain } from '../../shared/constants.js';

const SIZE = 190; // minimap side in CSS px
const REGION_STEP = 11; // tiles between region seeds
const REFRESH_MS = 400;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

export class TerritoryMap {
  /**
   * @param {HTMLElement} mount  element the minimap is appended to
   * @param {number[]} tiles     terrain per tile, row-major
   * @param {number} mapTiles    map side in tiles
   * @param {(x: number, y: number) => void} onJump  called with a world position when clicked
   */
  constructor(mount, tiles, mapTiles, onJump) {
    this.n = mapTiles;
    this.tiles = tiles;
    this.owner = []; // region -> player id
    this.lastDraw = 0;

    this.el = document.createElement('div');
    this.el.id = 'territory';
    const title = document.createElement('div');
    title.className = 'territory-title';
    title.textContent = 'Territorios';
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE * 2; // 2x for crisp pixels on retina
    this.canvas.height = SIZE * 2;
    this.el.append(title, this.canvas);
    mount.append(this.el);
    this.canvas.addEventListener('pointerdown', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const k = (this.n * TILE_SIZE) / r.width;
      onJump((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    });

    this.buildRegions();
    this.buildBase();
  }

  // Every tile goes to its nearest seed; seeds sit on a grid, each nudged by a fixed hash
  buildRegions() {
    const { n } = this;
    const hash = (i, j) => ((Math.sin(i * 127.1 + j * 311.7) * 43758.5453) % 1 + 1) % 1;
    this.seeds = [];
    for (let j = 0; j * REGION_STEP < n + REGION_STEP; j++) {
      for (let i = 0; i * REGION_STEP < n + REGION_STEP; i++) {
        this.seeds.push({
          x: (i + 0.15 + hash(i, j) * 0.7) * REGION_STEP,
          y: (j + 0.15 + hash(j + 7, i + 3) * 0.7) * REGION_STEP,
        });
      }
    }
    this.region = new Int16Array(n * n);
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        let best = 0;
        let bestD = Infinity;
        this.seeds.forEach((sd, i) => {
          const d = (sd.x - tx - 0.5) ** 2 + (sd.y - ty - 0.5) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        });
        this.region[ty * n + tx] = best;
      }
    }
  }

  // Terrain backdrop, drawn once
  buildBase() {
    const { n } = this;
    this.base = document.createElement('canvas');
    this.base.width = n;
    this.base.height = n;
    const ctx = this.base.getContext('2d');
    const img = ctx.createImageData(n, n);
    const colors = {
      [Terrain.GRASS]: [62, 110, 58], [Terrain.SAND]: [196, 176, 120], [Terrain.WATER]: [52, 120, 170], [Terrain.BRIDGE]: [120, 84, 48],
    };
    for (let i = 0; i < n * n; i++) {
      const [r, g, b] = colors[this.tiles[i]] ?? colors[Terrain.GRASS];
      img.data.set([r, g, b, 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  regionAt(x, y) {
    const tx = Math.min(this.n - 1, Math.max(0, Math.floor(x / TILE_SIZE)));
    const ty = Math.min(this.n - 1, Math.max(0, Math.floor(y / TILE_SIZE)));
    return this.region[ty * this.n + tx];
  }

  /**
   * @param {Iterable<{owner, x, y, building: boolean}>} things  units and buildings
   * @param {(owner) => number} colorOf
   * @param {{x, y, w, h}} view  camera rectangle in world px
   */
  update(things, colorOf, view) {
    const now = performance.now();
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    // Presence per region: owner -> weight
    const presence = new Map();
    const dots = [];
    for (const t of things) {
      if (!t.owner) continue;
      const r = this.regionAt(t.x, t.y);
      if (!presence.has(r)) presence.set(r, new Map());
      const m = presence.get(r);
      m.set(t.owner, (m.get(t.owner) ?? 0) + (t.building ? 3 : 1));
      dots.push(t);
    }
    const contested = new Set();
    for (const [r, m] of presence) {
      if (m.size === 1) this.owner[r] = m.keys().next().value;
      else contested.add(r);
    }

    const { n } = this;
    const ctx = this.canvas.getContext('2d');
    const k = this.canvas.width / n; // canvas px per tile
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, this.canvas.width, this.canvas.height);

    // Owned regions tinted in their faction's colour; contested ones blink
    const blink = Math.floor(now / 500) % 2 === 0;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const r = this.region[ty * n + tx];
        const owner = this.owner[r];
        if (!owner) continue;
        ctx.fillStyle = hex(colorOf(owner));
        ctx.globalAlpha = contested.has(r) && blink ? 0.2 : 0.45;
        ctx.fillRect(tx * k, ty * k, k, k);
      }
    }
    // Region borders: tiles next to a different region, darker where the owner changes
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const r = this.region[ty * n + tx];
        const right = tx + 1 < n ? this.region[ty * n + tx + 1] : r;
        const down = ty + 1 < n ? this.region[(ty + 1) * n + tx] : r;
        if (right === r && down === r) continue;
        const frontier = this.owner[r] !== this.owner[right] || this.owner[r] !== this.owner[down];
        ctx.globalAlpha = frontier ? 0.9 : 0.3;
        ctx.fillStyle = frontier ? '#1a1208' : '#000000';
        ctx.fillRect(tx * k, ty * k, k, k);
      }
    }
    // Units and buildings
    ctx.globalAlpha = 1;
    const wk = this.canvas.width / (n * TILE_SIZE); // canvas px per world px
    for (const t of dots) {
      const size = t.building ? 7 : 3;
      ctx.fillStyle = '#000000';
      ctx.fillRect(t.x * wk - size / 2 - 1, t.y * wk - size / 2 - 1, size + 2, size + 2);
      ctx.fillStyle = hex(colorOf(t.owner));
      ctx.fillRect(t.x * wk - size / 2, t.y * wk - size / 2, size, size);
    }
    // Camera
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(view.x * wk, view.y * wk, view.w * wk, view.h * wk);
  }

  destroy() { this.el.remove(); }
}
