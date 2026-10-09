import {
  AnimatedSprite, Application, BlurFilter, Container, Graphics, Rectangle, Sprite, Texture, TilingSprite,
} from 'pixi.js';
import { AUTUMN_TINTS, loadAssets } from './assets.js';
import { play } from './audio.js';
import { HAIR_STYLES, RIG_NAMES } from './pixelRig.js';
import { TerritoryMap } from './territory.js';
import {
  ENTITY_STATS, unitStats, TILE_SIZE, Terrain, ResourceType, RESOURCE_NAMES, MAX_TRAIN_QUEUE, CENTRAL_CONTROL_TIME,
  MAX_POPULATION, GATHER_UPGRADES, SHEEP,
} from '../../shared/constants.js';
import {
  isBuildingType, buildingSize, tileForCenter, footprint, canPlace, canAfford, formatCost,
} from '../../shared/rules.js';

const WATER_FRAME_MS = 500; // water tile animation: 2 frames
const BRIDGE_COLOR = 0x9a6a3a;
const BRIDGE_DARK = 0x5d3a1e;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 4;
const NEUTRAL_FACTION = 'black'; // castle art used for the unclaimed central town center

// Sprite sheet prefix and scale per unit type (frames are 192px, lancer 320px)
const UNIT_ART = {
  villager: { sheet: 'villager', scale: 2.2, rig: true }, // procedural pixel rigs (pixelRig.js), 24px frames
  swordsman: { sheet: 'warrior', scale: 2.2, rig: true },
  archer: { sheet: 'air', scale: 2.2, rig: true }, // air warrior with two fans
  horseman: { sheet: 'flyer', scale: 2.2, rig: true }, // flies in a spread poncho
  monk: { sheet: 'monk', scale: 2.2, rig: true }, // bald, robe and tall staff
  guard: { sheet: 'lancer', scale: 0.3 },
};
// Units that fight in the army; one in every FLAG_EVERY of them carries the player's flag
const SOLDIERS = new Set(['swordsman', 'archer', 'horseman']);
const FLAG_EVERY = 5;
const FLAG_SIZE = { width: 34, height: 23 };
const FLAG_POLE = 58; // px above the unit's centre
const RESOURCE_COLORS = {
  gold: 0xffd34d, food: 0xe57373, wood: 0x8bc34a, stone: 0xb0b0b0,
};
const HEAL_COLOR = 0x7dff7a;
const WIND_COLORS = [0xffffff, 0xc9d3dc, 0x8fd0ff, 0xe8f6ff];
// Flyer (horseman type): cruising altitude, apex of the attack dive, takeoff crouch/launch timing (s)
const FLY_ALT = 44;
const DIVE_ALT = 70;
const TAKEOFF_CROUCH = 0.22;
const TAKEOFF_TIME = 0.4;
// Fire: flame colours from hot to cool, then smoke; embers age through EMBER_COLORS
const FIRE_COLORS = [0xfff3b0, 0xffd34d, 0xff8a2a, 0xe0401f];
const EMBER_COLORS = [0xffd34d, 0xff8a2a, 0xe0401f, 0x6b5a50, 0x4a4440];
// Juice particle palettes
const WOOD_CHIPS = [0x8b5a2b, 0xc89b62, 0x6b4423];
const STONE_SPARKS = [0xfff3b0, 0xffffff, 0xb8c0c8, 0x7a828a];
const DUST = [0xd8c08a, 0xbfa678, 0x9c8660];
const MEAT_BITS = [0xd9534f, 0xb3261e, 0xffffff];
const HIT_SPARKS = [0xffffff, 0xfff3b0, 0xb3261e];
const SWOOSH = [0xffffff, 0xe8f6ff, 0xc9d3dc];
const HIT_FLASH_MS = 110;
const STUN_COLORS = [0xfff176, 0xffffff, 0x8fd0ff];
// Right-click markers: colour per order, lifetime in seconds
const MARKER_COLORS = {
  move: 0x7dff7a, attack: 0xff5252, gather: 0xffd34d, build: 0xffa040,
};
const MARKER_LIFE = 0.55;
const WORK_SOUND_MS = 900; // a gathering/building villager makes a sound this often
const HEAL_SOUND_MS = 1500;
// Building texture per building type; width = footprint * widthFactor
const BUILDING_ART = {
  townCenter: { texture: 'castle', widthFactor: 1.1 },
  barracks: { texture: 'barracks', widthFactor: 1.15 },
  archeryRange: { texture: 'archery', widthFactor: 1.15 },
  stable: { texture: 'barracks', widthFactor: 1.15, tint: 0xd8b48a }, // the barracks art in warm wood
  monastery: { texture: 'monastery', widthFactor: 1.15 },
  lumberCamp: { texture: 'house3', widthFactor: 0.95, logs: true },
  tower: { texture: 'tower', widthFactor: 1.5 },
  house: { texture: 'house1', variants: ['house1', 'house2', 'house3'], widthFactor: 1.3 },
  // Farmhouse sits on the middle tile; the crop fields around it are drawn separately
  farm: { texture: 'house2', widthFactor: 0.45, centerTile: true },
};
// Crop fields: rows and plants per field tile
const FIELD_ROWS = 3;
const FIELD_PLANTS = 4;
// Seconds per full animation cycle, so long and short sheets play at a natural pace.
// Attacks use the unit's own cooldown so each swing matches a hit.
const ANIM_CYCLE = { idle: 1.2, run: 0.75, work: 0.9 };
const ANIM_GROUP = {
  idle: 'idle', run: 'run', run_wood: 'run', run_gold: 'run', run_meat: 'run', attack: 'attack', shoot: 'attack',
};
const LOW_HP_FIRE = 0.5; // buildings below this fraction of hp burn
const HOVER_COLOR = 0xffffff;
const SELECT_COLOR = 0x00ff00;
// Pixel-art selection rings ('#' = drawn in the selection/hover colour): units 16x6, buildings 32x9
const UNIT_RING = [
  '...##########...',
  '.##..........##.',
  '#..............#',
  '#..............#',
  '.##..........##.',
  '...##########...',
];
const BUILDING_RING = [
  '........################........',
  '....####................####....',
  '..##........................##..',
  '##............................##',
  '#..............................#',
  '##............................##',
  '..##........................##..',
  '....####................####....',
  '........################........',
];
// Draws a ring centred on (cx, cy) with art pixels of size px
function drawRing(g, cx, cy, px, color, art = UNIT_RING) {
  const x0 = cx - (art[0].length * px) / 2;
  const y0 = cy - (art.length * px) / 2;
  art.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') g.rect(x0 + x * px, y0 + y * px, px, px);
  }));
  g.fill(color);
}
const CLICK_THRESHOLD = 5; // px of pointer movement before a click becomes a drag-select
const DOUBLE_CLICK_MS = 350;
const BUILDABLE = Object.keys(ENTITY_STATS).filter(isBuildingType);
const NEUTRAL_COLOR = 0x9e9e9e;
const tileKey = (x, y) => `${x},${y}`;
const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Bottom of a building's sprite relative to its centre (farmhouses stand on the middle tile)
const spriteBottom = (type) => (BUILDING_ART[type].centerTile ? TILE_SIZE / 2 : buildingSize(type) / 2) + 4;

// Flag textures per player id from their hand-drawn shapes (white on transparent, tinted at draw time)
async function loadFlags(players) {
  const textures = new Map();
  await Promise.all(players.filter((p) => p.flag).map(async (p) => {
    try {
      const img = new Image();
      img.src = p.flag;
      await img.decode();
      textures.set(p.id, Texture.from(img));
    } catch { /* unreadable drawing: the plain flag is used */ }
  }));
  return textures;
}

// Draws a progress bar centred at (0, y) on graphics g
function drawBar(g, y, width, fraction, color) {
  g.rect(-width / 2, y, width, 5).fill(0x111111);
  g.rect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), 5).fill(color);
}

// Rendering + input only. All game logic runs on the server.
export class Game {
  constructor(socket, myId, mount, ui) {
    this.socket = socket;
    this.myId = myId;
    this.mount = mount;
    this.ui = ui; // { hud, tooltip, buildMenu, message }
    this.players = new Map(); // playerId -> { id, name, color, stock }
    this.sprites = new Map(); // entityId -> { g, ...latest server fields }
    this.selected = new Set();
    this.resources = new Map(); // resourceId -> { g, type, tx, ty, amount }
    this.resourceAt = new Map(); // "tx,ty" -> resourceId
    this.stock = { food: 0, wood: 0, gold: 0 };
    this.pop = { used: 0, cap: 0 };
    this.keys = new Set();
    this.pointer = { x: 0, y: 0 }; // screen space
    this.dragStart = null;
    this.hovered = null; // { kind: 'entity' | 'resource', id }
    this.placing = null; // building type being placed
    this.arrows = []; // in-flight arrow animations
    this.gusts = []; // in-flight air blasts from air warriors
    this.windBits = []; // loose wind pixels: gust trails and impact bursts
    this.shockwaves = []; // expanding pixel rings from flyer takeoffs and impacts
    this.fireballs = []; // in-flight fireballs from fire mages
    this.markers = []; // right-click order bursts { x, y, color, t }
    this.groups = new Map(); // digit -> unit ids (Ctrl/Cmd + digit assigns, digit selects)
    this.lastGroupKey = null; // { digit, time } to centre the camera on a double press
    this.destroyed = false;
  }

  async init({
    map, resources, players, sheep,
  }) {
    this.app = new Application();
    await this.app.init({ resizeTo: window, background: 0x1b2a1b, antialias: true });
    if (this.destroyed) { this.app.destroy(true); return; }
    this.mount.prepend(this.app.canvas);

    for (const p of players) this.players.set(p.id, p);
    this.flagTextures = await loadFlags(players);
    this.bearers = new Set(); // ids of the soldiers carrying their player's flag

    this.assets = await loadAssets();
    if (this.destroyed) return;

    this.world = new Container();
    this.app.stage.addChild(this.world);
    this.tiles = map.tiles;
    this.mapTiles = Math.sqrt(map.tiles.length);
    this.world.addChild(this.drawGround(map));
    this.territory = new TerritoryMap(this.mount, map.tiles, this.mapTiles, (x, y) => {
      const k = this.world.scale.x;
      this.world.position.set(this.app.screen.width / 2 - x * k, this.app.screen.height / 2 - y * k);
      this.clampCamera();
    });
    this.fieldsLayer = new Container(); // farm crop fields, on the ground under everything else
    this.world.addChild(this.fieldsLayer);
    // Units, buildings and trees share one layer sorted by their base y, so things lower on screen draw in front
    this.objects = new Container({ sortableChildren: true });
    this.effects = new Graphics(); // tower range circles
    this.arrowLayer = new Container();
    this.fxLayer = new Container(); // one-shot particles (dust, explosions)
    this.overlay = new Graphics(); // hover outline + building ghost
    this.ghost = new Sprite();
    this.ghost.anchor.set(0.5, 1);
    this.ghost.alpha = 0.6;
    this.ghost.visible = false;
    this.world.addChild(this.objects, this.effects, this.fxLayer, this.arrowLayer, this.overlay, this.ghost);
    for (const r of resources) this.addResource(r);
    this.applySheep(sheep);
    this.selectionBox = new Graphics();
    this.app.stage.addChild(this.selectionBox);

    this.createBuildMenu();
    this.renderHud();
    this.app.ticker.add((t) => this.update(t));
    this.setupInput();
  }

  // ---------- World ----------

  // Sand and water (masked tiles) are drawn as overlapping blobs and blurred, so they fade into the grass instead of
  // showing hard tile edges. The blur is rendered once into a texture covering the whole map (a live
  // filter or cacheAsTexture only blurs what is on screen at the time).
  drawGround(map) {
    const ground = new Container();
    const grass = new TilingSprite({ texture: this.assets.grass, width: map.width, height: map.height });
    grass.tileScale.set(TILE_SIZE / this.assets.grass.width);

    const tileAt = (tx, ty) => map.tiles[ty * this.mapTiles + tx];
    const is = (terrain) => (tx, ty) => tileAt(tx, ty) === terrain;
    const isWater = (tx, ty) => tileAt(tx, ty) === Terrain.WATER || tileAt(tx, ty) === Terrain.BRIDGE;
    // One soft layer per terrain: a base colour plus a lighter core on tiles surrounded by the same terrain
    const blobs = (match, radius, color, coreColor, coreAlpha) => {
      const base = new Graphics();
      const core = new Graphics();
      for (let ty = 0; ty < this.mapTiles; ty++) {
        for (let tx = 0; tx < this.mapTiles; tx++) {
          if (!match(tx, ty)) continue;
          const cx = (tx + 0.5) * TILE_SIZE;
          const cy = (ty + 0.5) * TILE_SIZE;
          base.circle(cx, cy, TILE_SIZE * radius);
          const inner = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => match(tx + dx, ty + dy));
          if (inner) core.circle(cx + ((tx * 7) % 5) - 2, cy + ((ty * 11) % 5) - 2, TILE_SIZE * 0.55);
        }
      }
      base.fill(color);
      core.fill({ color: coreColor, alpha: coreAlpha });
      return [base, core];
    };
    // Renders a blurred layer into one texture covering the whole map
    // (at 1x: a 2x texture of the whole map would exceed the max GPU texture size)
    const bake = (layer) => {
      layer.filters = [new BlurFilter({ strength: 10, quality: 4 })];
      const texture = this.app.renderer.generateTexture({
        target: layer, frame: new Rectangle(0, 0, map.width, map.height), resolution: 1,
      });
      layer.destroy({ children: true });
      return texture;
    };
    // Sand and water are pixel-art tiles, each cut out by a soft white blob mask
    // `areas`: [match, blob radius in tiles] pairs that make up the mask
    const tiled = (texture, areas) => {
      const shape = new Container();
      for (const [match, radius] of areas) shape.addChild(...blobs(match, radius, 0xffffff, 0xffffff, 0));
      const mask = new Sprite(bake(shape));
      const tiles = new TilingSprite({ texture, width: map.width, height: map.height });
      tiles.tileScale.set(TILE_SIZE / texture.width);
      tiles.mask = mask;
      return [tiles, mask];
    };
    // Rivers get a sandy shore: wider sand blobs under every water tile
    const [sand, sandMask] = tiled(this.assets.sand, [[is(Terrain.SAND), 0.85], [isWater, 1.6]]);
    const [water, waterMask] = tiled(this.assets.water[0], [[isWater, 0.95]]);
    this.water = water; // its texture flips between the animation frames in update()

    const border = new Graphics().rect(0, 0, map.width, map.height).stroke({ width: 4, color: 0x222222 });
    ground.addChild(grass, sand, sandMask, water, waterMask, this.drawBridges(map, is(Terrain.BRIDGE), isWater), border);
    return ground;
  }

  // Wooden planks across the river, with rails along the water on both sides
  drawBridges(map, isBridge, isWater) {
    const g = new Graphics();
    for (let ty = 0; ty < this.mapTiles; ty++) {
      for (let tx = 0; tx < this.mapTiles; tx++) {
        if (!isBridge(tx, ty)) continue;
        const x = tx * TILE_SIZE;
        const y = ty * TILE_SIZE;
        // Crossing direction: a bridge tile with water left/right is walked up/down
        const vertical = (isWater(tx - 1, ty) && !isBridge(tx - 1, ty)) || (isWater(tx + 1, ty) && !isBridge(tx + 1, ty));
        g.rect(x, y, TILE_SIZE, TILE_SIZE).fill(BRIDGE_COLOR);
        for (let k = 1; k < 5; k++) {
          const o = (k * TILE_SIZE) / 5;
          if (vertical) g.rect(x, y + o - 1, TILE_SIZE, 2).fill(BRIDGE_DARK);
          else g.rect(x + o - 1, y, 2, TILE_SIZE).fill(BRIDGE_DARK);
        }
        // Rails on the sides that face open water
        const sides = vertical
          ? [[-1, 0, x, y, 4, TILE_SIZE], [1, 0, x + TILE_SIZE - 4, y, 4, TILE_SIZE]]
          : [[0, -1, x, y, TILE_SIZE, 4], [0, 1, x, y + TILE_SIZE - 4, TILE_SIZE, 4]];
        for (const [dx, dy, rx, ry, w, h] of sides) {
          if (isWater(tx + dx, ty + dy) && !isBridge(tx + dx, ty + dy)) g.rect(rx, ry, w, h).fill(BRIDGE_DARK);
        }
      }
    }
    return g;
  }

  // Trees and bushes sway, sheep graze, gold uses one of the stone variants; all anchored at the tile's bottom
  addResource(r) {
    let g;
    const animated = (frames, speed) => {
      const sprite = new AnimatedSprite(frames);
      sprite.animationSpeed = speed;
      sprite.gotoAndPlay(Math.floor(Math.random() * frames.length));
      return sprite;
    };
    if (r.type === ResourceType.FOOD) {
      g = animated(r.id % 2 ? this.assets.sheep.grass : this.assets.sheep.idle, 0.1);
      g.anchor.set(0.5, 0.8);
      g.scale.set(0.42 * (r.id % 3 ? 1 : -1), 0.42);
    } else if (r.variant === 'bush') {
      g = animated(this.assets.bushes[r.id % this.assets.bushes.length], 0.08);
      g.anchor.set(0.5, 0.8);
      g.scale.set(0.38);
    } else if (r.type === ResourceType.STONE) {
      g = new Sprite(this.assets.stone[r.id % this.assets.stone.length]);
      g.anchor.set(0.5, 0.8);
      g.scale.set(0.8);
    } else if (r.type === ResourceType.WOOD) {
      // Pixel-art pine or oak, one tile wide (16px art -> 40px), mirrored on some for variety
      // Foliage colour: mostly green variants, about 1 in 8 trees autumn orange
      const variants = this.assets.trees[r.id % this.assets.trees.length];
      const roll = ((Math.sin(r.id * 3.7) * 9631.17) % 1 + 1) % 1;
      const greens = variants.length - AUTUMN_TINTS;
      const tint = roll < 0.12 ? greens + Math.floor((roll / 0.12) * AUTUMN_TINTS) : Math.floor(((roll - 0.12) / 0.88) * greens);
      g = new Sprite(variants[tint]);
      g.anchor.set(0.5, 1);
      const k = TILE_SIZE / 16;
      g.scale.set(Math.floor(r.id / 2) % 2 ? -k : k, k);
    } else {
      g = new Sprite(this.assets.gold[r.id % this.assets.gold.length]);
      g.anchor.set(0.5, 0.75);
      g.scale.set(0.42);
    }
    g.position.set((r.tx + 0.5) * TILE_SIZE, (r.ty + 1) * TILE_SIZE);
    if (r.type === ResourceType.WOOD && r.variant !== 'bush') {
      // Trees sit at a different spot inside their tile (stable per tree), snapped to the art's pixel grid
      const px = TILE_SIZE / 16;
      const hash = (n) => ((Math.sin(r.id * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
      g.x += Math.round((hash(1) - 0.5) * 6) * px; // up to +-3 art px sideways
      g.y += Math.round((hash(2) - 0.7) * 5) * px; // mostly up into the tile, a little down
    }
    g.zIndex = g.y;
    this.objects.addChild(g);
    this.resources.set(r.id, {
      ...r, x: (r.tx + 0.5) * TILE_SIZE, y: (r.ty + 0.5) * TILE_SIZE, g,
    });
    // Sheep walk around, so they are picked by distance instead of by tile
    if (r.variant !== 'sheep') this.resourceAt.set(tileKey(r.tx, r.ty), r.id);
  }

  applyResourceChanges(changes) {
    for (const { id, amount } of changes) {
      const r = this.resources.get(id);
      if (!r) continue;
      r.amount = amount;
      if (amount > 0) continue;
      this.spawnFx(r.type === ResourceType.WOOD ? 'dust2' : 'dust1', r.g.x, r.g.y - 10, 0.6);
      r.g.destroy();
      this.resources.delete(id);
      this.resourceAt.delete(tileKey(r.tx, r.ty));
    }
  }

  // Sheep positions and owners, sent every tick
  applySheep(sheep) {
    for (const { id, x, y, owner } of sheep ?? []) {
      const r = this.resources.get(id);
      if (!r) continue;
      Object.assign(r, { x, y, owner });
    }
  }

  // One soldier in every FLAG_EVERY of each player's army (at least one) carries their flag
  pickFlagBearers() {
    const armies = new Map();
    for (const [id, s] of this.sprites) {
      if (!SOLDIERS.has(s.type) || !s.owner) continue;
      if (!armies.has(s.owner)) armies.set(s.owner, []);
      armies.get(s.owner).push(id);
    }
    this.bearers = new Set();
    for (const ids of armies.values()) {
      ids.sort((a, b) => a - b).forEach((id, i) => { if (i % FLAG_EVERY === 0) this.bearers.add(id); });
    }
  }

  applyState({ players, entities, sheep }) {
    if (!this.objects) return;
    this.applySheep(sheep);
    this.players = new Map(players.map((p) => [p.id, p]));
    const me = this.players.get(this.myId);
    if (me) {
      this.stock = me.stock;
      this.pop = { used: me.pop, cap: me.popCap };
    }

    const seen = new Set();
    for (const e of entities) {
      seen.add(e.id);
      let s = this.sprites.get(e.id);
      if (!s) {
        s = this.createView(e);
        this.sprites.set(e.id, s);
        // A new unit of ours after the first update was just trained
        if (this.stateSeen && e.owner === this.myId && !isBuildingType(e.type)) this.sfx('trained', e.x, e.y);
      } else if (e.hp < s.hp) {
        this.sfx(isBuildingType(e.type) ? 'hit' : 'sword', e.x, e.y);
        this.onHit(s, isBuildingType(e.type));
      }
      Object.assign(s, e);
    }
    this.stateSeen = true;
    for (const [id, s] of this.sprites) {
      if (seen.has(id)) continue;
      // Buildings blow up, units leave a puff of dust
      if (isBuildingType(s.type)) this.spawnFx(s.id % 2 ? 'explosion1' : 'explosion2', s.x, s.y, buildingSize(s.type) / 120);
      else {
        this.spawnFx('dust1', s.g.x, s.g.y, 0.7);
        // The unit bursts into pixels of its team colour, skin and blood
        this.burst(s.g.x, s.g.y - 8, {
          n: 26, colors: [this.colorOf(s.owner), 0xebcaa6, 0xb3261e, 0x2c2c2c], speed: 110, up: 60, life: 0.6, g: 260,
        });
      }
      this.sfx(isBuildingType(s.type) ? 'collapse' : 'death', s.x, s.y);
      s.g.destroy({ children: true });
      s.fields?.destroy();
      this.sprites.delete(id);
      this.selected.delete(id);
    }
    this.pickFlagBearers();
    if (!this.focused) this.focusOnBase();
    this.renderHud();
  }

  // Each entity is a container: under (selection ring) + sprite + over (bars)
  createView(e) {
    const g = new Container();
    g.position.set(e.x, e.y);
    const under = new Graphics();
    const over = new Graphics();
    let sprite;
    let fire = null;
    if (isBuildingType(e.type)) {
      sprite = new Sprite();
      sprite.anchor.set(0.5, 1);
      fire = new AnimatedSprite(this.assets.fx[`fire${(e.id % 3) + 1}`]);
      fire.anchor.set(0.5, 1);
      fire.animationSpeed = 0.2;
      fire.visible = false;
    } else {
      sprite = new AnimatedSprite(this.unitFrames(e.type, e.owner, 'idle', 'front', e.id));
      // Rig frames have headroom for raised tools, so their anchor sits lower to keep the feet in place
      sprite.anchor.set(0.5, UNIT_ART[e.type].rig ? 0.62 : 0.55);
      sprite.play();
    }
    g.addChild(under, sprite);
    if (fire) g.addChild(fire);
    g.addChild(over);
    this.objects.addChild(g);
    let fields = null;
    if (ENTITY_STATS[e.type].farm) {
      fields = new Graphics();
      this.fieldsLayer.addChild(fields);
    }
    return {
      g, under, over, sprite, fire, fields, anim: 'idle', facing: 1, view: 'front',
    };
  }

  factionOf(owner) { return this.players.get(owner)?.faction ?? NEUTRAL_FACTION; }

  // Rigged units alternate between hair styles by id and have a sheet per view
  // Fire civilization players use the `_fire` rig of a unit when one exists
  unitFrames(type, owner, anim, view = 'front', id = 0) {
    const { sheet: base, rig } = UNIT_ART[type];
    const civ = this.players.get(owner)?.civ;
    const sheet = rig && civ && civ !== 'air' && RIG_NAMES.includes(`${base}_${civ}`) ? `${base}_${civ}` : base;
    const name = rig ? `${sheet}_${HAIR_STYLES[id % HAIR_STYLES.length]}_${view}` : sheet;
    return this.assets.units[this.factionOf(owner)][`${name}_${anim}`];
  }

  // Rigged units are drawn from the front, back or side: toward whatever they work on, otherwise
  // along their movement (the side view is mirrored by `facing`)
  updateView(s, dx, dy) {
    const target = this.sprites.get(s.targetId ?? s.buildingId) ?? this.resources.get(s.resourceId);
    if (target && s.action !== 'moving') {
      const tx = target.x ?? target.g.x;
      const ty = target.y ?? target.g.y;
      dx = tx - s.g.x;
      dy = ty - s.g.y;
      if (Math.abs(dx) > 1) s.facing = Math.sign(dx);
    } else if (Math.hypot(dx, dy) < 0.3) return;
    s.view = Math.abs(dx) >= Math.abs(dy) * 0.8 ? 'side' : dy < 0 ? 'back' : 'front';
  }

  // Picks the sheet that matches what the unit is doing this tick
  unitAnim(s) {
    if (s.type === 'villager') {
      if (s.action === 'gathering') return { gold: 'pickaxe', stone: 'pickaxe', food: 'knife' }[s.carry?.type] ?? 'axe';
      if (s.action === 'building') return 'hammer';
      if (s.action === 'attacking') return 'axe';
      if (s.action === 'moving') {
        if (s.carry?.amount > 0) return `run_${{ gold: 'gold', stone: 'gold', food: 'meat' }[s.carry.type] ?? 'wood'}`;
        return 'run';
      }
      return 'idle';
    }
    if (s.type === 'monk' && s.action === 'healing') return 'heal';
    if (s.action === 'attacking') return s.type === 'archer' ? 'shoot' : 'attack';
    return s.action === 'moving' ? 'run' : 'idle';
  }

  // Center the camera on this player's town center
  focusOnBase() {
    const tc = [...this.sprites.values()].find((s) => s.owner === this.myId && s.type === 'townCenter');
    if (!tc) return;
    const k = this.world.scale.x;
    this.world.position.set(this.app.screen.width / 2 - tc.x * k, this.app.screen.height / 2 - tc.y * k);
    this.focused = true;
  }

  // Zoom around a screen point, within ZOOM_MIN..ZOOM_MAX
  zoomAt(screenPoint, factor) {
    const before = this.world.toLocal(screenPoint);
    const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.world.scale.x * factor));
    this.world.scale.set(scale);
    this.world.position.set(screenPoint.x - before.x * scale, screenPoint.y - before.y * scale);
    this.clampCamera();
  }

  // Keep the map on screen (a little slack lets the edges clear the HUD and build menu)
  clampCamera() {
    const k = this.world.scale.x;
    const slack = 160;
    const { width, height } = this.app.screen;
    const mapSize = this.mapTiles * TILE_SIZE * k;
    const clampAxis = (pos, view) => Math.max(Math.min(pos, slack), view - mapSize - slack);
    this.world.x = clampAxis(this.world.x, width);
    this.world.y = clampAxis(this.world.y, height);
  }

  // One-shot particle animation at a world position
  spawnFx(name, x, y, scale = 1) {
    if (!this.fxLayer || this.destroyed) return;
    const fx = new AnimatedSprite(this.assets.fx[name]);
    fx.anchor.set(0.5, 0.7);
    fx.position.set(x, y);
    fx.scale.set(scale);
    fx.loop = false;
    fx.animationSpeed = 0.3;
    fx.onComplete = () => fx.destroy();
    this.fxLayer.addChild(fx);
    fx.play();
  }

  // Tiles taken by resources or buildings, as known by the client
  isTileBlocked = (x, y) => {
    if (this.resourceAt.has(tileKey(x, y))) return true;
    const terrain = this.tiles?.[y * this.mapTiles + x];
    if (terrain === Terrain.WATER || terrain === Terrain.BRIDGE) return true;
    for (const s of this.sprites.values()) {
      if (!isBuildingType(s.type)) continue;
      const n = ENTITY_STATS[s.type].tiles;
      if (x >= s.tx && x < s.tx + n && y >= s.ty && y < s.ty + n) return true;
    }
    return false;
  };

  // ---------- Hit testing ----------

  entityAt(x, y) {
    // Units first, they are drawn on top of buildings. The hit box covers the whole character sprite
    // (it stands above its position); when several overlap, the one whose body is closest wins.
    let best = null;
    let bestDist = Infinity;
    for (const [id, s] of this.sprites) {
      if (isBuildingType(s.type)) continue;
      const r = ENTITY_STATS[s.type].radius;
      const dx = x - s.g.x;
      const dy = y - s.g.y;
      if (Math.abs(dx) > r + 8 || dy < -(r + 26) || dy > r + 6) continue;
      const d = Math.hypot(dx, dy + r * 0.8);
      if (d < bestDist) { best = id; bestDist = d; }
    }
    if (best != null) return best;
    for (const [id, s] of this.sprites) {
      if (!isBuildingType(s.type)) continue;
      const half = buildingSize(s.type) / 2;
      if (Math.abs(s.x - x) <= half && Math.abs(s.y - y) <= half) return id;
    }
    return null;
  }

  resourceAtPoint(x, y) {
    for (const r of this.resources.values()) {
      if (r.variant === 'sheep' && Math.hypot(r.g.x - x, r.g.y - 12 - y) <= SHEEP.radius + 8) return r.id;
    }
    return this.resourceAt.get(tileKey(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))) ?? null;
  }

  pickAt(x, y) {
    const entityId = this.entityAt(x, y);
    if (entityId != null) return { kind: 'entity', id: entityId };
    const resourceId = this.resourceAtPoint(x, y);
    if (resourceId != null) return { kind: 'resource', id: resourceId };
    return null;
  }

  ghostTile() {
    const p = this.world.toLocal(this.pointer);
    return tileForCenter(this.placing, p.x, p.y);
  }

  // ---------- Rendering ----------

  update(t) {
    // Camera panning
    const speed = 10 * t.deltaTime;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) this.world.x += speed;
    if (k.has('d') || k.has('arrowright')) this.world.x -= speed;
    if (k.has('w') || k.has('arrowup')) this.world.y += speed;
    if (k.has('s') || k.has('arrowdown')) this.world.y -= speed;
    this.clampCamera();
    // Camera shake from nearby flyer impacts
    if (this.shake > 0) {
      this.shake -= t.deltaMS / 1000;
      const m = Math.max(0, this.shake) * 18;
      this.world.pivot.set((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    } else this.world.pivot.set(0, 0);

    // Interpolate toward server positions and redraw
    this.effects.clear();
    this.drawSheep();
    this.drawArrows(t.deltaMS / 1000);
    if (this.water) this.water.texture = this.assets.water[Math.floor(performance.now() / WATER_FRAME_MS) % 2];
    this.drawGusts(t.deltaMS / 1000);
    this.drawFireballs(t.deltaMS / 1000);
    this.drawMarkers(t.deltaMS / 1000);
    for (const [id, s] of this.sprites) {
      const dx = s.x - s.g.x;
      s.g.x += dx * 0.3;
      s.g.y += (s.y - s.g.y) * 0.3;
      if (Math.abs(dx) > 0.3) s.facing = Math.sign(dx);
      if (UNIT_ART[s.type]?.rig) this.updateView(s, dx, s.y - s.g.y);
      if (isBuildingType(s.type)) this.drawBuilding(s, this.selected.has(id));
      else this.drawUnit(s, this.selected.has(id));
      if (s.burning) this.drawBurning(s);
      if (s.type === 'archer' && this.players.get(s.owner)?.civ === 'fire') this.mageFire(s);
    }

    // Territory minimap: units and buildings, plus the camera's view rectangle
    const zoom = this.world.scale.x;
    this.territory?.update(
      [...this.sprites.values()].map((s) => ({
        owner: s.owner, x: s.g.x, y: s.g.y, building: isBuildingType(s.type),
      })),
      (owner) => this.colorOf(owner),
      {
        x: -this.world.x / zoom, y: -this.world.y / zoom, w: this.app.screen.width / zoom, h: this.app.screen.height / zoom,
      },
    );

    // Hover is recomputed every frame since things move under a still cursor
    const p = this.world.toLocal(this.pointer);
    this.hovered = this.placing || this.dragStart ? null : this.pickAt(p.x, p.y);
    this.drawOverlay();
    this.updateTooltip();
  }

  colorOf(owner) { return this.players.get(owner)?.color ?? NEUTRAL_COLOR; }

  drawBuilding(s, isSelected) {
    const stats = ENTITY_STATS[s.type];
    const size = buildingSize(s.type);
    const half = size / 2;
    const color = this.colorOf(s.owner);
    const fallen = s.central && s.hp <= 0;
    s.g.zIndex = s.y + half;

    // Owner's faction art; the central town center uses neutral art until claimed
    const art = BUILDING_ART[s.type];
    const textureName = art.variants ? art.variants[s.id % art.variants.length] : art.texture;
    const texture = this.assets.buildings[this.factionOf(s.owner)][textureName];
    if (s.sprite.texture !== texture) {
      s.sprite.texture = texture;
      s.sprite.scale.set((size * art.widthFactor) / texture.width);
    }
    s.sprite.y = spriteBottom(s.type);
    s.sprite.alpha = s.built ? 1 : 0.35 + 0.5 * s.buildProgress;
    s.sprite.tint = fallen ? 0x555555 : (s.central && !s.owner ? 0xbbbbbb : (art.tint ?? 0xffffff));
    const maxHp = s.maxHp ?? stats.hp;

    // Puff of dust the moment construction finishes; flames while badly damaged
    if (s.built && s.wasBuilt === false) {
      this.spawnFx('dust2', s.x, s.y + half - 6, size / 70);
      this.sfx('built', s.x, s.y);
    }
    s.wasBuilt = s.built;
    const burning = s.built && !fallen && s.hp < maxHp * LOW_HP_FIRE;
    if (burning && !s.fire.visible) s.fire.play();
    else if (!burning) s.fire.stop();
    s.fire.visible = burning;
    if (burning) {
      s.fire.scale.set(size / 70);
      s.fire.position.set(((s.id * 13) % 11) - 5, half - size * 0.45);
    }

    const under = s.under.clear();
    if (isSelected) drawRing(under, 0, half - 4, (half + 8) / 16, SELECT_COLOR, BUILDING_RING);

    const g = s.over.clear();
    const top = spriteBottom(s.type) - s.sprite.height;
    if (stats.farm) {
      this.drawFields(s);
      if (s.built) drawBar(g, half + 8, size, s.food / stats.farm.food, 0xe5c04a);
    }
    if (!s.built) drawBar(g, half + 8, size, s.buildProgress, 0xf0a030);
    if (s.central) {
      // Crown above the central town center
      const y = top - 6;
      g.poly([-14, y, -14, y - 14, -7, y - 6, 0, y - 18, 7, y - 6, 14, y - 14, 14, y]).fill(fallen ? 0x777777 : 0xffd34d)
        .stroke({ width: 1.5, color: 0x5a4300 });
      if (s.owner) drawBar(g, half + 8, size, s.controlTime / CENTRAL_CONTROL_TIME, color);
    }
    if (art.logs) {
      // Stacked logs beside the lumber camp
      for (const [lx, ly] of [[-6, 0], [6, 0], [0, -7]]) {
        g.circle(half - 14 + lx, half - 8 + ly, 6).fill(0x8b5a2b).stroke({ width: 1.5, color: 0x4e2f14 });
        g.circle(half - 14 + lx, half - 8 + ly, 2.5).fill(0xd9b38c);
      }
    }
    if (s.research) drawBar(g, half + 8, size, s.research.progress, 0xb388ff);
    if (s.built && s.queue?.length) {
      drawBar(g, half + 8, size, s.trainProgress, 0x4fc3f7);
      s.queue.forEach((_, i) => g.circle(-half + 5 + i * 9, half + 19, 3).fill(0x4fc3f7));
    }
    if (stats.attack && s.built && (isSelected || this.hovered?.id === s.id)) {
      this.effects.circle(s.x, s.y, stats.attack.range).stroke({ width: 1, color, alpha: 0.6 });
    }
    if (s.hp < maxHp && s.built && !fallen) drawBar(g, top - 2, size, s.hp / maxHp, 0x4caf50);
    this.drawFlag(s);
  }

  // Tilled soil on every footprint tile except the farmhouse's; plants disappear as food is harvested
  drawFields(s) {
    const { food: max } = ENTITY_STATS[s.type].farm;
    const key = s.built ? `${s.food}` : `b${Math.round(s.buildProgress * 10)}`;
    if (s.fieldsKey === key) return;
    s.fieldsKey = key;
    const g = s.fields.clear();
    g.alpha = s.built ? 1 : 0.35 + 0.5 * s.buildProgress;
    const tiles = footprint(s.type, s.tx, s.ty).filter(([x, y]) => x !== s.tx + 1 || y !== s.ty + 1);
    const total = tiles.length * FIELD_ROWS * FIELD_PLANTS;
    let plants = s.built ? Math.ceil((s.food / max) * total) : 0;
    const ripe = s.food / max > 0.5 ? 0xe5c04a : 0x9ccc65; // golden wheat while full, greener when thin
    for (const [x, y] of tiles) {
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;
      g.roundRect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4, 4).fill(0x8a5a32).stroke({ width: 1, color: 0x5d3a1e });
      for (let row = 0; row < FIELD_ROWS; row++) {
        const ry = py + 9 + row * 11;
        g.rect(px + 5, ry + 2, TILE_SIZE - 10, 2).fill(0x5d3a1e); // furrow
        for (let i = 0; i < FIELD_PLANTS; i++) {
          if (plants <= 0) break;
          plants--;
          const cx = px + 9 + i * 7.5;
          g.poly([cx - 2.5, ry + 3, cx, ry - 5, cx + 2.5, ry + 3]).fill(ripe);
        }
      }
    }
  }

  drawUnit(s, isSelected) {
    const stats = ENTITY_STATS[s.type];
    const r = stats.radius;
    s.g.zIndex = s.g.y + r;

    if (s.type === 'horseman') this.updateFlyer(s);
    // Swap animation when the action changes
    const anim = s.type === 'horseman' ? s.flyAnim : this.unitAnim(s);
    if (anim !== s.anim || s.view !== s.shownView) {
      const keepFrame = anim === s.anim; // turning mid-animation keeps its rhythm
      s.anim = anim;
      s.shownView = s.view;
      const frame = s.sprite.currentFrame;
      const frames = this.unitFrames(s.type, s.owner, anim, s.view, s.id);
      s.sprite.textures = frames;
      const group = ANIM_GROUP[anim] ?? 'work';
      const attack = unitStats(s.type, this.players.get(s.owner)?.civ).attack;
      const cycle = group === 'attack' ? attack.cooldown : ANIM_CYCLE[group];
      // animationSpeed is frames per 60fps tick
      s.sprite.animationSpeed = frames.length / (cycle * 60);
      if (keepFrame) s.sprite.gotoAndPlay(frame % frames.length);
      else s.sprite.play();
    }
    // Stepped animations (flyer takeoff/attack) follow the game's timing instead of playing
    if (s.flyFrame != null) s.sprite.gotoAndStop(Math.min(s.flyFrame, s.sprite.totalFrames - 1));
    else if (!s.sprite.playing) s.sprite.play();
    if (s.action === 'stunned') this.drawStun(s, r);
    // Frame events (impact particles) and footstep dust
    const frameNow = s.sprite.currentFrame;
    if (frameNow !== s.lastFrame) {
      s.lastFrame = frameNow;
      this.frameEvent(s, s.anim, frameNow);
      const walking = s.anim?.startsWith('run') && s.type !== 'horseman';
      if (walking && frameNow % 2 === 0 && Math.random() < 0.6) {
        this.burst(s.g.x - s.facing * 4, s.g.y + r * 0.8, { n: 2, colors: DUST, speed: 25, up: 15, g: 60, life: 0.35 });
      }
    }
    // Hit flash (burning units flicker orange from drawBurning, which runs after this)
    if (s.hitAt && performance.now() - s.hitAt < HIT_FLASH_MS) s.sprite.tint = 0xff6b6b;
    else if (s.sprite.tint !== 0xffffff) s.sprite.tint = 0xffffff;
    // Flyers leave a trail of wind pixels (fire: embers cooling to smoke) behind them in the air
    if (s.type === 'horseman' && s.alt > 8 && Math.random() < 0.7) {
      const fire = this.isFire(s.owner);
      this.windBits.push({
        x: s.g.x - s.facing * 8 + (Math.random() - 0.5) * 18, y: s.g.y - s.alt + 4 + (Math.random() - 0.5) * 10,
        vx: -s.facing * (20 + Math.random() * 20), vy: fire ? -10 : 15 + Math.random() * 15,
        life: 0.5, max: 0.5, color: WIND_COLORS[Math.floor(Math.random() * WIND_COLORS.length)],
        ...(fire ? { colors: EMBER_COLORS, g: -40 } : {}),
      });
    }
    // Face the target while attacking, otherwise the movement direction
    const target = s.action === 'attacking' ? this.sprites.get(s.targetId) : null;
    if (target && Math.abs(target.g.x - s.g.x) > 1) s.facing = Math.sign(target.g.x - s.g.x);
    const { scale } = UNIT_ART[s.type];
    s.sprite.scale.set(scale * s.facing, scale);

    const under = s.under.clear();
    // The shadow stays on the ground and shrinks as a flyer climbs
    const shrink = 1 - Math.min(0.5, (s.alt ?? 0) / 140);
    under.ellipse(0, r * 0.9, (r + 2) * shrink, r * 0.45 * shrink).fill({ color: 0x000000, alpha: 0.25 });
    if (isSelected) drawRing(under, 0, r * 0.9, (r + 5) / 8, SELECT_COLOR);

    const g = s.over.clear();
    const barY = -r - 22;
    if (s.action === 'gathering') drawBar(g, barY, 26, s.gatherFill, RESOURCE_COLORS[s.carry?.type] ?? RESOURCE_COLORS.wood);
    const patient = s.action === 'healing' ? this.sprites.get(s.targetId) : null;
    if (patient) {
      const pulse = 0.4 + 0.3 * Math.sin(performance.now() / 120);
      this.effects.moveTo(s.g.x, s.g.y - 6).lineTo(patient.g.x, patient.g.y - 6).stroke({ width: 2, color: HEAL_COLOR, alpha: pulse });
      const py = patient.g.y - 30;
      this.effects.rect(patient.g.x - 5, py - 1.5, 10, 3).rect(patient.g.x - 1.5, py - 5, 3, 10).fill({ color: HEAL_COLOR, alpha: 0.9 });
    }
    if (s.action === 'building') drawBar(g, barY, 26, this.sprites.get(s.buildingId)?.buildProgress ?? 0, 0xf0a030);
    if (s.hp < stats.hp) drawBar(g, barY + 7, 24, s.hp / stats.hp, 0x4caf50);
    this.drawFlag(s);
    this.unitSounds(s);
  }

  // Plays a world sound at (x, y): full volume at the centre of the screen, fading toward the edges,
  // silent off screen
  sfx(name, x, y) {
    if (!this.world) return;
    const p = this.world.toGlobal({ x, y });
    const { width, height } = this.app.screen;
    const margin = 80;
    if (p.x < -margin || p.y < -margin || p.x > width + margin || p.y > height + margin) return;
    const d = Math.hypot(p.x - width / 2, p.y - height / 2) / Math.hypot(width / 2, height / 2);
    play(name, (1 - d * 0.7) * Math.min(1, this.world.scale.x));
  }

  // Chopping, mining, hammering and healing, repeated while the unit keeps at it
  unitSounds(s) {
    const now = performance.now();
    let sound = null;
    let every = WORK_SOUND_MS;
    if (s.action === 'gathering') sound = { wood: 'chop', gold: 'mine', stone: 'mine' }[s.carry?.type] ?? null;
    else if (s.action === 'building') sound = 'hammer';
    else if (s.action === 'healing') { sound = 'heal'; every = HEAL_SOUND_MS; }
    if (!sound || now - (s.lastSound ?? 0) < every) return;
    s.lastSound = now + Math.random() * 200; // desynchronise neighbours
    this.sfx(sound, s.g.x, s.g.y);
  }

  // The flag pole rises behind the bearer (or from the roof of a finished building); the cloth is
  // the player's drawing in their colour, waving
  drawFlag(s) {
    const building = isBuildingType(s.type);
    const carrying = building ? !!s.owner && s.built && s.hp > 0 : this.bearers.has(s.id);
    if (!carrying) {
      if (s.flag) s.flag.visible = false;
      return;
    }
    // A captured building changes hands: rebuild the flag in the new owner's colours
    if (s.flag && s.flag.owner !== s.owner) {
      s.flag.destroy({ children: true });
      s.flag = null;
    }
    if (!s.flag) {
      s.flag = new Container();
      const pole = new Graphics().rect(-1.5, -FLAG_POLE - 3, 3, FLAG_POLE + 9).fill(0x5d3a1e)
        .circle(0, -FLAG_POLE - 4, 3).fill(0xd4a017); // gold finial
      // White cloth with the player's drawing on it in their colour; a plain flag in their colour otherwise
      const cloth = new Container();
      cloth.position.set(1.5, -FLAG_POLE);
      const color = this.colorOf(s.owner);
      const drawing = this.flagTextures.get(s.owner);
      const border = new Graphics().rect(0, 0, FLAG_SIZE.width, FLAG_SIZE.height)
        .fill(drawing ? 0xffffff : color).stroke({ width: 1.5, color: 0x3a2a1a });
      cloth.addChild(border);
      if (drawing) {
        const art = new Sprite(drawing);
        art.width = FLAG_SIZE.width;
        art.height = FLAG_SIZE.height;
        art.tint = color;
        cloth.addChild(art);
      }
      s.flag.addChild(pole, cloth);
      s.flag.cloth = cloth;
      s.flag.owner = s.owner;
      // Behind a unit's body; in front of a building, planted on its roof
      if (building) s.g.addChildAt(s.flag, s.g.getChildIndex(s.sprite) + 1);
      else s.g.addChildAt(s.flag, s.g.getChildIndex(s.sprite));
    }
    s.flag.visible = true;
    if (building) {
      // Pole planted a little below the top of the art, toward its right side
      const half = buildingSize(s.type) / 2;
      const top = spriteBottom(s.type) - s.sprite.height;
      s.flag.position.set(half * 0.45, top + s.sprite.height * 0.3);
      s.flag.cloth.skew.y = Math.sin(performance.now() / 260 + s.id) * 0.12;
      return;
    }
    s.flag.x = -s.facing * 9;
    s.flag.scale.x = -s.facing; // the cloth streams out behind the bearer
    s.flag.cloth.skew.y = Math.sin(performance.now() / 260 + s.id) * 0.12;
  }

  // Sheep walk toward their owner's drop-off; owned sheep get a ring in the owner's colour
  drawSheep() {
    for (const r of this.resources.values()) {
      if (r.variant !== 'sheep') continue;
      const tx = r.x;
      const ty = r.y + 12;
      const dx = tx - r.g.x;
      r.g.x += dx * 0.3;
      r.g.y += (ty - r.g.y) * 0.3;
      r.g.zIndex = r.g.y;
      if (Math.abs(dx) > 0.3) r.g.scale.x = Math.abs(r.g.scale.x) * Math.sign(dx);
      if (r.owner) this.effects.ellipse(r.g.x, r.g.y - 2, 13, 5).stroke({ width: 1.5, color: this.colorOf(r.owner), alpha: 0.8 });
    }
  }

  // Arrows from towers and air blasts from air warriors fly toward the target's current position
  addShots(shots) {
    for (const {
      x, y, targetId, kind, radius, attackerId, fire,
    } of shots) {
      if (kind === 'blast') { this.windBlast(x, y, radius, attackerId, fire); continue; }
      const target = this.sprites.get(targetId);
      if (!target) continue;
      this.sfx('bow', x, y);
      const shot = { x, y, targetId, to: { x: target.g.x, y: target.g.y }, t: 0 };
      if (kind === 'archer') this.gusts.push({ ...shot, spin: Math.random() * Math.PI * 2 });
      else if (kind === 'fireball') {
        this.fireballs.push(shot);
        this.mageRelease(this.sprites.get(attackerId));
      }
      else this.arrows.push(shot);
    }
  }

  // Scatters `n` loose pixels from (x, y): `speed` outward, `up` extra upward kick, `g` gravity
  // (positive falls, negative rises), optional `dir` (radians) + `spread` to aim them in a cone
  burst(x, y, {
    n = 10, colors, speed = 80, up = 0, life = 0.4, g = 0, dir = null, spread = Math.PI * 2,
  }) {
    for (let i = 0; i < n; i++) {
      const a = dir == null ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * spread;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.windBits.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - up * Math.random(), g,
        life: life * (0.7 + Math.random() * 0.5), max: life, color: colors[i % colors.length],
      });
    }
  }

  // Taking damage: a short red flash on the sprite and sparks off the body
  onHit(s, building) {
    s.hitAt = performance.now();
    if (building) {
      const half = buildingSize(s.type) / 2;
      this.burst(s.x + (Math.random() - 0.5) * half, s.y, { n: 8, colors: DUST, speed: 70, up: 50, g: 200, life: 0.5 });
      return;
    }
    this.burst(s.g.x, s.g.y - 8 + s.sprite.y, { n: 7, colors: HIT_SPARKS, speed: 90, up: 30, g: 150, life: 0.3 });
  }

  // Animation events: particles fired on the frame where a tool or weapon lands
  frameEvent(s, anim, frame) {
    const f = s.facing;
    const reach = s.view === 'side' ? 14 : 8; // tools reach further out in the side view
    const hx = s.g.x + f * reach;
    const hy = s.g.y - 2;
    const civFire = this.isFire(s.owner);
    if (s.type === 'villager') {
      if (anim === 'axe' && frame === 3) {
        // Chips fly back off the trunk toward the villager
        this.burst(hx, hy - 4, { n: 8, colors: WOOD_CHIPS, speed: 90, up: 60, g: 260, life: 0.5, dir: f > 0 ? Math.PI : 0, spread: 2.4 });
      } else if (anim === 'pickaxe' && frame === 3) {
        this.burst(hx, hy, { n: 6, colors: STONE_SPARKS, speed: 120, up: 40, g: 200, life: 0.3 });
        this.burst(hx, hy + 4, { n: 4, colors: DUST, speed: 40, up: 20, g: 100, life: 0.5 });
      } else if (anim === 'hammer' && frame === 3) {
        this.burst(hx, hy + 6, { n: 6, colors: DUST, speed: 50, up: 30, g: 120, life: 0.45 });
        this.burst(hx, hy, { n: 2, colors: STONE_SPARKS, speed: 80, up: 40, g: 200, life: 0.25 });
      } else if (anim === 'knife' && frame === 1) {
        this.burst(hx, hy, { n: 5, colors: MEAT_BITS, speed: 60, up: 40, g: 240, life: 0.4 });
      }
      return;
    }
    // Melee swings leave a swoosh: a half-ring of pixels in front of the fighter that drifts forward
    const swoosh = (r) => {
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i / 6) * Math.PI;
        this.windBits.push({
          x: s.g.x + f * Math.cos(a) * r, y: s.g.y - 6 + Math.sin(a) * r * 0.8,
          vx: f * 25, vy: 0, life: 0.16 + i * 0.015, max: 0.26, color: SWOOSH[i % SWOOSH.length],
        });
      }
    };
    if (s.type === 'swordsman' && anim === 'attack') {
      if (civFire && (frame === 1 || frame === 2)) swoosh(14);
      else if (civFire && frame === 4) { swoosh(16); swoosh(11); }
      else if (!civFire && frame === 3) {
        swoosh(16);
        this.burst(hx + f * 6, hy, { n: 5, colors: DUST, speed: 50, up: 20, g: 120, life: 0.35 });
      }
    } else if (s.type === 'archer' && anim === 'shoot' && !civFire && frame === 3) {
      // Fans flung forward: a puff of air off both of them
      this.burst(hx, hy - 4, { n: 10, colors: WIND_COLORS, speed: 110, life: 0.35, dir: f > 0 ? 0 : Math.PI, spread: 1.2 });
    } else if (s.type === 'monk' && anim === 'heal' && frame === 2) {
      this.burst(s.g.x + f * 6, s.g.y - 30, { n: 6, colors: [0x7dff7a, 0xfff59d], speed: 30, up: 30, g: -40, life: 0.6 });
    }
  }

  // Flyer altitude and animation. Moving = takeoff (crouch, aura, launch) then flight at FLY_ALT;
  // attacking = rise to DIVE_ALT over the cooldown and dive so it lands exactly on each impact;
  // otherwise it glides back down. Sets s.alt, s.flyAnim and s.flyFrame (null = play normally).
  updateFlyer(s) {
    const now = performance.now();
    const flying = s.action === 'moving';
    s.alt ??= 0;
    if (flying && !s.wasFlying && s.alt < 4) {
      s.takeoffAt = now;
      s.launched = false;
    }
    s.wasFlying = flying;
    const sinceTakeoff = s.takeoffAt ? (now - s.takeoffAt) / 1000 : Infinity;
    s.flyFrame = null;

    if (s.action === 'attacking') {
      const cooldown = unitStats('horseman', this.players.get(s.owner)?.civ).attack.cooldown;
      const p = s.lastBlast ? Math.min(1, (now - s.lastBlast) / (cooldown * 1000)) : 0.9;
      s.flyAnim = 'attack';
      if (p < 0.15) { s.alt = 0; s.flyFrame = 0; } // impact crouch
      else if (p < 0.8) { // climb, easing out toward the apex
        const q = (p - 0.15) / 0.65;
        s.alt = DIVE_ALT * (1 - (1 - q) ** 2);
        s.flyFrame = q < 0.45 ? 1 : q < 0.75 ? 2 : 3;
      } else { // accelerating dive
        const q = (p - 0.8) / 0.2;
        s.alt = DIVE_ALT * (1 - q * q);
        s.flyFrame = 4;
      }
    } else if (sinceTakeoff < TAKEOFF_TIME) {
      s.flyAnim = 'takeoff';
      if (sinceTakeoff < TAKEOFF_CROUCH) {
        s.flyFrame = sinceTakeoff < TAKEOFF_CROUCH / 2 ? 0 : 1;
      } else {
        if (!s.launched) { s.launched = true; this.takeoffBurst(s.g.x, s.g.y, this.isFire(s.owner)); }
        s.flyFrame = 2;
        s.alt += (FLY_ALT - s.alt) * 0.25;
      }
    } else if (flying) {
      s.flyAnim = 'run';
      s.alt += (FLY_ALT + Math.sin(now / 220 + s.id) * 4 - s.alt) * 0.12;
    } else {
      // Landing: keep flapping while gliding down
      s.alt += (0 - s.alt) * 0.12;
      if (s.alt < 1) s.alt = 0;
      s.flyAnim = s.alt > 3 ? 'run' : 'idle';
    }
    s.sprite.y = -s.alt; // the lean in flight is drawn by the rig's bones, never by rotating the sprite
  }

  isFire(owner) { return this.players.get(owner)?.civ === 'fire'; }

  // The air explosion art, recoloured into flames for the fire civilization
  blastFx(x, y, scale, fire) {
    this.spawnFx('airBlast', x, y, scale);
    if (fire) this.fxLayer.children.at(-1).tint = 0xff7a2a;
  }

  // Takeoff aura: a low ring of wind (or flames) blasting outward, pixels shooting upward
  takeoffBurst(x, y, fire = false) {
    const COLORS = fire ? FIRE_COLORS : WIND_COLORS;
    this.blastFx(x, y + 10, 2, fire);
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2;
      const speed = 160 + Math.random() * 60;
      this.windBits.push({
        x, y: y + 8, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.45,
        life: 0.35, max: 0.35, color: COLORS[i % COLORS.length],
      });
    }
    for (let i = 0; i < 10; i++) {
      this.windBits.push({
        x: x + (Math.random() - 0.5) * 20, y: y + 4, vx: (Math.random() - 0.5) * 30, vy: -(150 + Math.random() * 120),
        life: 0.4, max: 0.4, color: COLORS[i % COLORS.length],
      });
    }
    this.shockwaves.push({ x, y: y + 8, radius: 34, t: 0, life: 0.3, colors: COLORS });
  }

  // Stunned units: three pixel stars circling over the head
  drawStun(s, r) {
    const px = 2.2;
    const t = performance.now() / 160;
    for (let i = 0; i < 3; i++) {
      const a = t + (i * Math.PI * 2) / 3;
      const x = s.g.x + Math.cos(a) * 9;
      const y = s.g.y - r - 22 + Math.sin(a) * 3;
      this.effects.rect(x - px / 2, y - px * 1.5, px, px * 3).rect(x - px * 1.5, y - px / 2, px * 3, px)
        .fill(STUN_COLORS[i]);
    }
  }

  // Flyer's dive impact: dust, a double pixel shockwave, a wall of wind pixels over the whole blast
  // radius, debris thrown up, and a short camera shake
  windBlast(x, y, radius, attackerId, fire = false) {
    const COLORS = fire ? FIRE_COLORS : WIND_COLORS;
    const attacker = this.sprites.get(attackerId);
    if (attacker) attacker.lastBlast = performance.now();
    this.sfx('arrowHit', x, y);
    this.blastFx(x, y + 8, 4, fire); // whole-number scale keeps the pixel art crisp
    this.shockwaves.push({ x, y, radius: radius * 1.4, t: 0, life: 0.45, colors: COLORS }, { x, y, radius: radius * 0.8, t: -0.08, life: 0.4, colors: COLORS });
    for (let i = 0; i < 24; i++) {
      this.windBits.push({
        x: x + (Math.random() - 0.5) * radius, y: y + (Math.random() - 0.5) * radius * 0.5,
        vx: (Math.random() - 0.5) * 60, vy: -(120 + Math.random() * 160),
        life: 0.55, max: 0.55, color: COLORS[i % COLORS.length],
      });
    }
    const p = this.world.toGlobal({ x, y });
    const { width, height } = this.app.screen;
    if (p.x > 0 && p.y > 0 && p.x < width && p.y < height) this.shake = Math.max(this.shake ?? 0, 0.3);
    for (let i = 0; i < 70; i++) {
      const ang = (i / 70) * Math.PI * 2 + Math.random() * 0.2;
      const speed = radius * (4 + Math.random() * 2); // wind bits slow down ~8% a frame, so this carries them ~radius
      const start = 4 + Math.random() * 6;
      this.windBits.push({
        x: x + Math.cos(ang) * start, y: y + Math.sin(ang) * start * 0.6,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.6,
        life: 0.5, max: 0.5, color: COLORS[i % COLORS.length],
      });
    }
  }

  // Fireball: a flickering pixel ball on a high arc, shedding embers that cool into smoke; bursts
  // into flames on impact
  drawFireballs(dt) {
    const FLIGHT_TIME = 0.6;
    const px = UNIT_ART.archer.scale;
    const g = this.effects;
    const dot = (x, y, color) => g.rect(Math.round(x / px) * px, Math.round(y / px) * px, px, px).fill(color);
    for (const f of this.fireballs) {
      f.t += dt / FLIGHT_TIME;
      const target = this.sprites.get(f.targetId);
      if (target) f.to = { x: target.g.x, y: target.g.y };
      const t = Math.min(1, f.t);
      const x = f.x + (f.to.x - f.x) * t;
      const y = f.y + (f.to.y - f.y) * t - 14 - Math.sin(t * Math.PI) * 30;
      // Ball: a 7x7 diamond with a white-hot core, a randomly flickering edge and flame licks
      // trailing behind it
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d > 3 || (d === 3 && Math.random() < 0.4)) continue;
          dot(x + dx * px, y + dy * px, FIRE_COLORS[Math.min(3, d + (Math.random() < 0.3 ? 1 : 0))]);
        }
      }
      const back = Math.atan2(f.y - f.to.y, f.x - f.to.x);
      for (let i = 1; i <= 4; i++) {
        const wob = (Math.random() - 0.5) * 2;
        dot(x + Math.cos(back) * (i + 2) * px + wob * px, y + Math.sin(back) * (i + 2) * px, FIRE_COLORS[Math.min(3, i)]);
      }
      for (let i = 0; i < 5; i++) {
        this.windBits.push({
          x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, g: -60,
          life: 0.5, max: 0.5, colors: EMBER_COLORS,
        });
      }
      if (f.t >= 1) this.fireBurst(f.to.x, f.to.y - 10);
    }
    this.fireballs = this.fireballs.filter((f) => f.t < 1);
  }

  // Where a fire mage's hand is in the world. Art coords are relative to the rig's 16px reference
  // sprite; the frame puts that sprite at (10, 10) and the sprite anchor at (12, 28 * 0.62).
  mageHand(s, ax, ay) {
    const k = UNIT_ART.archer.scale;
    return { x: s.g.x + (ax + 10 - 12) * k * s.facing, y: s.g.y + s.sprite.y + (ay + 10 - 28 * 0.62) * k };
  }

  // Fire mage particles: embers always rise off the flame in its hand; while winding up an attack,
  // sparks spiral in toward the fireball forming over its head
  mageFire(s) {
    const casting = s.action === 'attacking';
    const frame = s.sprite.currentFrame;
    if (casting && frame < 3) {
      const c = this.mageHand(s, 2, 0);
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 14 + Math.random() * 10;
        this.windBits.push({
          x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d * 0.7,
          vx: -Math.cos(a) * d * 5, vy: -Math.sin(a) * d * 3.5,
          life: 0.22, max: 0.22, colors: [0xfff3b0, 0xffd34d, 0xff8a2a],
        });
      }
      return;
    }
    if (casting || Math.random() > 0.45) return;
    const h = this.mageHand(s, 7, 4);
    this.windBits.push({
      x: h.x + (Math.random() - 0.5) * 3, y: h.y, vx: (Math.random() - 0.5) * 12, vy: -(20 + Math.random() * 25), g: -30,
      life: 0.5, max: 0.5, colors: EMBER_COLORS,
    });
  }

  // The moment the fireball leaves: the cast animation jumps to the throw, flames burst from the
  // hands and a hot ring pushes out
  mageRelease(s) {
    if (!s) return;
    if (s.sprite.totalFrames > 3) s.sprite.gotoAndPlay(3);
    const h = this.mageHand(s, 8, 6);
    for (let i = 0; i < 22; i++) {
      const a = (Math.random() - 0.5) * 1.6;
      const speed = 60 + Math.random() * 120;
      this.windBits.push({
        x: h.x, y: h.y, vx: Math.cos(a) * speed * s.facing, vy: Math.sin(a) * speed - 20, g: -80,
        life: 0.45, max: 0.45, colors: [0xfff3b0, ...EMBER_COLORS],
      });
    }
    this.shockwaves.push({ x: s.g.x, y: s.g.y + 8, radius: 26, t: 0, life: 0.25, colors: FIRE_COLORS });
  }

  // Fireball impact: flames thrown out in a ring, sparks shooting up, a hot shockwave
  fireBurst(x, y) {
    this.sfx('arrowHit', x, y);
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2 + Math.random() * 0.2;
      const speed = 100 + Math.random() * 120;
      this.windBits.push({
        x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.6, g: -120,
        life: 0.5 + Math.random() * 0.3, max: 0.8, colors: EMBER_COLORS,
      });
    }
    for (let i = 0; i < 10; i++) {
      this.windBits.push({
        x: x + (Math.random() - 0.5) * 12, y, vx: (Math.random() - 0.5) * 40, vy: -(120 + Math.random() * 120),
        life: 0.6, max: 0.6, colors: [0xfff3b0, ...EMBER_COLORS],
      });
    }
    this.shockwaves.push(
      { x, y: y + 10, radius: 42, t: 0, life: 0.3, colors: FIRE_COLORS },
      { x, y: y + 10, radius: 24, t: -0.06, life: 0.25, colors: FIRE_COLORS },
    );
  }

  // A burning unit or building: flame tongues licking up its body, embers and smoke rising off it,
  // and (units) the sprite flickering orange
  drawBurning(s) {
    const building = isBuildingType(s.type);
    const half = building ? buildingSize(s.type) / 2 : ENTITY_STATS[s.type].radius;
    const px = 2.2;
    const now = performance.now();
    const n = building ? 6 : 3;
    for (let i = 0; i < n; i++) {
      // Each tongue flickers in height on its own beat
      const fx = s.g.x + ((i + 0.5) / n - 0.5) * half * 1.6;
      const base = s.g.y + (building ? half * 0.6 : 2);
      const h = 2 + Math.round((Math.sin(now / 70 + i * 2.1 + s.id) + 1) * 1.5);
      for (let k = 0; k < h; k++) {
        const color = FIRE_COLORS[Math.min(3, Math.floor((k / h) * 4))];
        const sway = Math.round(Math.sin(now / 90 + k + i) * 0.6);
        this.effects.rect(Math.round(fx / px) * px + sway * px, Math.round(base / px) * px - k * px, px, px).fill(color);
      }
    }
    if (Math.random() < (building ? 0.6 : 0.35)) {
      this.windBits.push({
        x: s.g.x + (Math.random() - 0.5) * half * 1.4, y: s.g.y - Math.random() * 14,
        vx: (Math.random() - 0.5) * 15, vy: -(30 + Math.random() * 30), g: -40,
        life: 0.8, max: 0.8, colors: EMBER_COLORS,
      });
    }
    if (!building) s.sprite.tint = Math.sin(now / 60 + s.id) > 0.2 ? 0xffb27a : 0xffffff;
  }

  // Air blast: a spinning knot of grey/white/blue pixels with a fading trail, bursting on impact.
  // Drawn as squares on the rig's pixel grid so it matches the pixel-art units.
  drawGusts(dt) {
    const FLIGHT_TIME = 0.4;
    const px = UNIT_ART.archer.scale; // one art pixel in world units
    const g = this.effects;
    const dot = (x, y, color, alpha = 1) => {
      g.rect(Math.round(x / px) * px, Math.round(y / px) * px, px, px).fill({ color, alpha });
    };
    for (const a of this.gusts) {
      a.t += dt / FLIGHT_TIME;
      const target = this.sprites.get(a.targetId);
      if (target) a.to = { x: target.g.x, y: target.g.y };
      const t = Math.min(1, a.t);
      const cx = a.x + (a.to.x - a.x) * t;
      const cy = a.y + (a.to.y - a.y) * t - 12;
      const heading = Math.atan2(a.to.y - a.y, a.to.x - a.x);
      a.spin += dt * 18;
      // Swirl: points on a squashed ring around the centre, stretched along the flight path
      const size = 1 + Math.sin(t * Math.PI) * 0.6;
      for (let i = 0; i < 9; i++) {
        const ang = a.spin + (i / 9) * Math.PI * 2;
        const along = Math.cos(ang) * 6 * size;
        const across = Math.sin(ang) * 3.5 * size;
        dot(
          cx + Math.cos(heading) * along - Math.sin(heading) * across,
          cy + Math.sin(heading) * along + Math.cos(heading) * across,
          WIND_COLORS[i % WIND_COLORS.length],
        );
      }
      dot(cx, cy, 0xffffff);
      // Trail pixels drift backwards and fade
      for (let i = 0; i < 2; i++) {
        this.windBits.push({
          x: cx + (Math.random() - 0.5) * 6, y: cy + (Math.random() - 0.5) * 6,
          vx: -Math.cos(heading) * 30 + (Math.random() - 0.5) * 20,
          vy: -Math.sin(heading) * 30 + (Math.random() - 0.5) * 20,
          life: 0.3, max: 0.3, color: WIND_COLORS[Math.floor(Math.random() * WIND_COLORS.length)],
        });
      }
      if (a.t >= 1) {
        this.sfx('arrowHit', a.to.x, a.to.y);
        // Burst: a ring of pixels thrown outward
        for (let i = 0; i < 18; i++) {
          const ang = (i / 18) * Math.PI * 2 + Math.random() * 0.3;
          const speed = 50 + Math.random() * 50;
          this.windBits.push({
            x: a.to.x, y: a.to.y - 12, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.6,
            life: 0.45, max: 0.45, color: WIND_COLORS[i % WIND_COLORS.length],
          });
        }
      }
    }
    this.gusts = this.gusts.filter((a) => a.t < 1);
    // Loose pixels (wind, embers): `g` accelerates them vertically (negative = rising), and with
    // `colors` they step through the list as they age (fire -> smoke)
    for (const b of this.windBits) {
      b.life -= dt;
      b.vy += (b.g ?? 0) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.92;
      b.vy *= 0.92;
      const age = 1 - b.life / b.max;
      const color = b.colors ? b.colors[Math.min(b.colors.length - 1, Math.floor(age * b.colors.length))] : b.color;
      if (b.life > 0) dot(b.x, b.y, color, Math.min(1, (b.life / b.max) * 1.5));
    }
    this.windBits = this.windBits.filter((b) => b.life > 0);
    // Shockwaves: a squashed ring of pixels growing outward and thinning
    for (const w of this.shockwaves) {
      w.t += dt;
      if (w.t < 0) continue;
      const q = w.t / w.life;
      const rx = w.radius * (0.2 + q * 0.8);
      const n = Math.round(rx * 1.2);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const colors = w.colors ?? WIND_COLORS;
        dot(w.x + Math.cos(a) * rx, w.y + Math.sin(a) * rx * 0.45, colors[i % 3], 1 - q);
      }
    }
    this.shockwaves = this.shockwaves.filter((w) => w.t < w.life);
  }

  drawArrows(dt) {
    const FLIGHT_TIME = 0.3;
    for (const a of this.arrows) {
      if (!a.sprite) {
        a.sprite = new Sprite(this.assets.arrow);
        a.sprite.anchor.set(0.5);
        a.sprite.scale.set(0.45);
        this.arrowLayer.addChild(a.sprite);
      }
      a.t += dt / FLIGHT_TIME;
      const target = this.sprites.get(a.targetId);
      if (target) a.to = { x: target.g.x, y: target.g.y };
      const t = Math.min(1, a.t);
      // Slight arc so arrows read as shots rather than lasers
      const arc = Math.sin(t * Math.PI) * 18;
      a.sprite.position.set(a.x + (a.to.x - a.x) * t, a.y + (a.to.y - a.y) * t - arc - 20);
      a.sprite.rotation = Math.atan2(a.to.y - a.y, a.to.x - a.x);
      if (a.t >= 1) {
        a.sprite.destroy();
        this.sfx('arrowHit', a.to.x, a.to.y);
      }
    }
    this.arrows = this.arrows.filter((a) => a.t < 1);
  }

  drawOverlay() {
    const g = this.overlay.clear();

    if (this.placing) {
      const { tx, ty } = this.ghostTile();
      const valid = canPlace(this.placing, tx, ty, this.isTileBlocked, this.mapTiles)
        && canAfford(this.stock, ENTITY_STATS[this.placing].cost);
      const tint = valid ? 0x4caf50 : 0xe53935;
      for (const [x, y] of footprint(this.placing, tx, ty)) {
        const blocked = x < 0 || y < 0 || x >= this.mapTiles || y >= this.mapTiles || this.isTileBlocked(x, y);
        g.rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill({ color: blocked ? 0xe53935 : tint, alpha: 0.35 });
      }
      const size = buildingSize(this.placing);
      g.rect(tx * TILE_SIZE, ty * TILE_SIZE, size, size).stroke({ width: 2, color: tint });

      // Building preview in the player's own faction
      const art = BUILDING_ART[this.placing];
      const texture = this.assets.buildings[this.factionOf(this.myId)][art.texture];
      this.ghost.texture = texture;
      this.ghost.scale.set((size * art.widthFactor) / texture.width);
      this.ghost.position.set(tx * TILE_SIZE + size / 2, ty * TILE_SIZE + size / 2 + spriteBottom(this.placing));
      this.ghost.tint = valid ? 0xffffff : 0xff8080;
      this.ghost.visible = true;
      return;
    }
    this.ghost.visible = false;

    if (!this.hovered) return;
    if (this.hovered.kind === 'resource') {
      const r = this.resources.get(this.hovered.id);
      if (r) {
        const b = r.g.getBounds();
        const p = this.world.toLocal({ x: b.x, y: b.y });
        g.rect(p.x, p.y, b.width / this.world.scale.x, b.height / this.world.scale.y).stroke({ width: 2, color: HOVER_COLOR, alpha: 0.9 });
      }
      return;
    }
    const s = this.sprites.get(this.hovered.id);
    if (!s) return;
    if (isBuildingType(s.type)) {
      const half = buildingSize(s.type) / 2;
      drawRing(g, s.x, s.y + half - 4, (half + 8) / 16, HOVER_COLOR, BUILDING_RING);
    } else {
      const r = ENTITY_STATS[s.type].radius;
      drawRing(g, s.g.x, s.g.y + r * 0.9, (r + 5) / 8, HOVER_COLOR);
    }
  }

  // ---------- UI ----------

  renderHud() {
    const mine = [...this.sprites.values()].filter((s) => s.owner === this.myId);
    const villagers = mine.filter((s) => s.type === 'villager');
    const idleVillagers = this.idleVillagers();
    const idle = idleVillagers.length;
    const btn = this.ui.idleButton;
    if (btn) {
      btn.classList.toggle('hidden', idle === 0);
      btn.textContent = `💤 Aldeano inactivo (${idle})`;
    }
    const army = mine.filter((s) => SOLDIERS.has(s.type)).length;
    const popFull = this.pop.used >= this.pop.cap;
    const items = [
      [{ icon: '/assets/ui/food.png', label: 'Comida' }, this.stock.food],
      [{ icon: '/assets/ui/wood.png', label: 'Madera' }, this.stock.wood],
      [{ icon: '/assets/ui/gold.png', label: 'Oro' }, this.stock.gold],
      ['🪨', this.stock.stone ?? 0],
      ['🏠 Población', `${this.pop.used}/${this.pop.cap}${this.pop.cap >= MAX_POPULATION ? ' (máx.)' : ''}`, popFull],
      ['👷 Aldeanos', `${villagers.length} (${idle} inactivos)`],
      ['⚔️ Ejército', army],
    ];
    const central = [...this.sprites.values()].find((s) => s.central);
    if (central) {
      const holder = this.players.get(central.owner);
      items.push(['👑 Centro', holder
        ? `${holder.id === this.myId ? 'Tú' : holder.name} ${formatTime(central.controlTime)} / ${formatTime(CENTRAL_CONTROL_TIME)}`
        : 'neutral']);
    }
    this.renderRanking();
    this.ui.hud.replaceChildren(...items.map(([label, value, warn]) => {
      const span = document.createElement('span');
      span.classList.toggle('warn', !!warn);
      if (typeof label === 'object') {
        const img = document.createElement('img');
        img.src = label.icon;
        img.alt = label.label;
        span.append(img, `${value}`);
      } else {
        span.textContent = `${label}: ${value}`;
      }
      return span;
    }));

    for (const btn of this.ui.buildMenu.querySelectorAll('button')) {
      btn.disabled = !canAfford(this.stock, ENTITY_STATS[btn.dataset.type].cost);
      btn.classList.toggle('active', btn.dataset.type === this.placing);
    }
  }

  // Every player by points, leader first; defeated players crossed out, disconnected ones marked
  renderRanking() {
    const players = [...this.players.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const title = document.createElement('li');
    title.className = 'title';
    title.textContent = '🏆 Ranking';
    this.ui.ranking.replaceChildren(title, ...players.map((p, i) => {
      const li = document.createElement('li');
      li.classList.toggle('me', p.id === this.myId);
      li.classList.toggle('out', !!p.defeated);
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = i === 0 && !p.defeated ? '👑' : `${i + 1}.`;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${(p.color ?? 0).toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${p.name}${p.id === this.myId ? ' (tú)' : ''}${p.connected === false ? ' ⚠' : ''}`;
      if (p.connected === false) li.title = 'Desconectado';
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = p.score ?? 0;
      li.append(pos, swatch, name, score);
      return li;
    }));
  }

  createBuildMenu() {
    this.ui.buildMenu.replaceChildren(...BUILDABLE.map((type) => {
      const stats = ENTITY_STATS[type];
      const btn = document.createElement('button');
      btn.dataset.type = type;
      const img = document.createElement('img');
      img.src = `/assets/${this.factionOf(this.myId)}/${BUILDING_ART[type].texture}.png`;
      if (BUILDING_ART[type].tint) img.style.filter = 'sepia(0.7)';
      img.alt = '';
      const name = document.createElement('strong');
      name.textContent = stats.name;
      const cost = document.createElement('small');
      cost.textContent = formatCost(stats.cost);
      const trains = document.createElement('small');
      if (stats.trains) trains.textContent = `Entrena ${ENTITY_STATS[stats.trains].name}`;
      else if (stats.attack) trains.textContent = `Dispara flechas · alcance ${stats.attack.range}`;
      else if (stats.dropOff) trains.textContent = 'Deja aquí cualquier recurso · mejora la recolección';
      else if (stats.farm) trains.textContent = `${stats.farm.food} comida por siembra · resembrar: ${formatCost(stats.farm.reseedCost)}`;
      else trains.textContent = `+${stats.population} población`;
      const text = document.createElement('span');
      text.className = 'text';
      text.append(name, cost);
      btn.title = trains.textContent;
      btn.append(img, text);
      btn.addEventListener('click', () => {
        this.placing = this.placing === type ? null : type;
        this.renderHud();
      });
      return btn;
    }));
  }

  tooltipText() {
    if (this.placing) {
      const stats = ENTITY_STATS[this.placing];
      return `${stats.name} — ${formatCost(stats.cost)}\nClic izquierdo para colocar, clic derecho / Esc para cancelar`;
    }
    if (!this.hovered) return null;

    if (this.hovered.kind === 'resource') {
      const r = this.resources.get(this.hovered.id);
      if (!r) return null;
      const label = r.variant === 'bush' ? 'Arbusto' : {
        wood: 'Árbol', gold: 'Mina de oro', stone: 'Cantera de piedra', food: 'Oveja',
      }[r.type];
      const lines = [`${label} — ${r.amount}/${r.max} ${RESOURCE_NAMES[r.type]}`];
      if (r.variant === 'sheep') {
        if (!r.owner) lines.push('Acércale una unidad para quedártela');
        else lines.push(r.owner === this.myId ? 'Tuya: va hacia tu Centro urbano o Aserradero' : `De ${this.players.get(r.owner)?.name ?? 'otro jugador'}`);
      }
      return lines.join('\n');
    }

    const s = this.sprites.get(this.hovered.id);
    if (!s) return null;
    const stats = ENTITY_STATS[s.type];
    const owner = this.players.get(s.owner)?.name ?? 'neutral';
    const mine = s.owner === this.myId;
    const name = s.central ? 'Centro urbano central' : stats.name;
    const lines = [`${name} (${mine ? 'tú' : owner}) — PV ${s.hp}/${s.maxHp ?? stats.hp}`];

    if (s.central) {
      if (s.hp <= 0) lines.push('¡Caído! Clic derecho con un aldeano para capturarlo');
      else if (!mine) lines.push('Baja sus PV a 0 y luego envía un aldeano para capturarlo');
      if (s.owner) lines.push(`Dominado ${formatTime(s.controlTime)} / ${formatTime(CENTRAL_CONTROL_TIME)} para ganar`);
    }
    if (!mine && !s.central) lines.push('Clic derecho con tus unidades para atacar');

    if (isBuildingType(s.type)) {
      if (stats.attack) {
        lines.push(`Dispara a unidades enemigas: ${stats.attack.damage} daño cada ${stats.attack.cooldown}s · alcance ${stats.attack.range}`);
      }
      if (stats.population) lines.push(`+${stats.population} población`);
      if (stats.dropOff && s.built) {
        lines.push('Los aldeanos dejan aquí cualquier recurso');
        const level = this.players.get(s.owner)?.gatherLevel ?? 0;
        if (s.research) {
          lines.push(`Investigando ${GATHER_UPGRADES[s.research.level].name}: ${Math.floor(s.research.progress * 100)}%`);
        } else if (mine && GATHER_UPGRADES[level]) {
          const up = GATHER_UPGRADES[level];
          lines.push(`Clic para investigar ${up.name} (recolección x${up.bonus}): ${formatCost(up.cost)} · ${up.time}s`);
        } else if (mine) lines.push('Todas las mejoras investigadas');
      }
      if (stats.farm && s.built) {
        lines.push(`Siembra: ${s.food}/${stats.farm.food} comida`);
        if (mine && s.food > 0) lines.push('Clic derecho con aldeanos para cultivar');
        if (mine && s.food <= 0) lines.push(`¡Cosecha agotada! Se resiembra sola cuando hay madera, o clic para resembrar: ${formatCost(stats.farm.reseedCost)}`);
      }
      if (!s.built) {
        lines.push(`En construcción: ${Math.floor(s.buildProgress * 100)}%`);
        if (mine) lines.push('Clic derecho con aldeanos para ayudar a construir');
      } else if (mine && stats.trains) {
        const unit = ENTITY_STATS[stats.trains];
        lines.push(`Clic para entrenar ${unit.name}: ${formatCost(unit.cost)} · ${unit.trainTime}s`);
        if (s.queue.length) lines.push(`Cola: ${s.queue.length}/${MAX_TRAIN_QUEUE} (${Math.floor(s.trainProgress * 100)}%)`);
        if (!canAfford(this.stock, unit.cost)) lines.push('Recursos insuficientes');
        if (this.pop.used >= this.pop.cap) lines.push('Población al límite: construye casas');
      }
    } else if (stats.heal) {
      lines.push(`Cura ${stats.heal.amount} PV/s a unidades aliadas cercanas${s.action === 'healing' ? ' · curando' : ''}`);
    } else if (s.type !== 'villager') {
      const { attack } = stats;
      lines.push(`Ataque ${attack.damage} · ${attack.range ? `alcance ${attack.range}` : 'cuerpo a cuerpo'}${s.action === 'attacking' ? ' · luchando' : ''}`);
    } else if (s.type === 'villager') {
      if (s.action === 'gathering') lines.push(`Recolectando ${RESOURCE_NAMES[s.carry.type]}: ${s.carry.amount}/${stats.carryCapacity}`);
      else if (s.action === 'building') lines.push('Construyendo');
      else if (s.action === 'attacking') lines.push('Atacando');
      else if (s.carry?.amount) lines.push(`Lleva ${s.carry.amount} de ${RESOURCE_NAMES[s.carry.type]}`);
    }
    return lines.join('\n');
  }

  updateTooltip() {
    const text = this.tooltipText();
    const tip = this.ui.tooltip;
    tip.classList.toggle('hidden', !text);
    if (!text) return;
    tip.textContent = text;
    // Keep the tooltip on screen
    const x = Math.min(this.pointer.x + 16, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(this.pointer.y + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  showMessage(message, kind = 'error') {
    play(kind === 'notice' ? 'notice' : 'error');
    const el = this.ui.message;
    el.textContent = message;
    el.classList.toggle('notice', kind === 'notice');
    el.classList.remove('hidden');
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---------- Input ----------

  selectedUnitIds() {
    return [...this.selected].filter((id) => {
      const s = this.sprites.get(id);
      return s && !isBuildingType(s.type);
    });
  }

  placeBuilding() {
    const { tx, ty } = this.ghostTile();
    const stats = ENTITY_STATS[this.placing];
    if (!canAfford(this.stock, stats.cost)) return this.showMessage('Recursos insuficientes');
    if (!canPlace(this.placing, tx, ty, this.isTileBlocked, this.mapTiles)) return this.showMessage('No se puede construir ahí');
    // Selected villagers go build it; the server picks the closest villager when none are selected
    const unitIds = this.selectedUnitIds().filter((id) => this.sprites.get(id).type === 'villager');
    this.socket.emit('game:build', { type: this.placing, tx, ty, unitIds });
    play('place');
    if (!this.keys.has('shift')) this.placing = null;
    this.renderHud();
  }

  // Single left click: train from own building, select own unit, or clear selection
  click(worldPoint) {
    const id = this.entityAt(worldPoint.x, worldPoint.y);
    const s = id != null ? this.sprites.get(id) : null;
    if (!s || s.owner !== this.myId) { this.selected.clear(); return; }
    // Double click on a unit: select every unit of that type on screen
    const now = performance.now();
    const isDouble = this.lastClick?.id === id && now - this.lastClick.time < DOUBLE_CLICK_MS;
    this.lastClick = isDouble ? null : { id, time: now };
    if (isDouble && !isBuildingType(s.type)) {
      this.selected = new Set(this.visibleUnitsOfType(s.type));
      return;
    }
    this.selected = new Set([id]);
    if (ENTITY_STATS[s.type].dropOff && s.built) {
      if (s.research) return this.showMessage('Ya se está investigando una mejora', 'notice');
      const up = GATHER_UPGRADES[this.players.get(this.myId)?.gatherLevel ?? 0];
      if (!up) return this.showMessage('Ya investigaste todas las mejoras', 'notice');
      if (!canAfford(this.stock, up.cost)) return this.showMessage('Recursos insuficientes');
      this.socket.emit('game:research', { buildingId: id });
      return;
    }
    const farm = ENTITY_STATS[s.type].farm;
    if (farm && s.built && s.food <= 0) {
      if (!canAfford(this.stock, farm.reseedCost)) return this.showMessage('Recursos insuficientes');
      this.socket.emit('game:reseed', { buildingId: id });
      return;
    }
    if (isBuildingType(s.type) && s.built && ENTITY_STATS[s.type].trains) {
      const unit = ENTITY_STATS[ENTITY_STATS[s.type].trains];
      if (!canAfford(this.stock, unit.cost)) return this.showMessage('Recursos insuficientes');
      if (s.queue.length >= MAX_TRAIN_QUEUE) return this.showMessage('La cola está llena');
      if (this.pop.used >= this.pop.cap) {
        return this.showMessage(this.pop.cap >= MAX_POPULATION ? 'Límite de población alcanzado' : 'Necesitas más casas');
      }
      this.socket.emit('game:train', { buildingId: id });
    }
  }

  // Ids of own units of the given type inside the visible part of the world
  visibleUnitsOfType(type) {
    const topLeft = this.world.toLocal({ x: 0, y: 0 });
    const bottomRight = this.world.toLocal({ x: this.app.screen.width, y: this.app.screen.height });
    return [...this.sprites].filter(([, s]) => (
      s.owner === this.myId && s.type === type
      && s.g.x >= topLeft.x && s.g.x <= bottomRight.x && s.g.y >= topLeft.y && s.g.y <= bottomRight.y
    )).map(([id]) => id);
  }

  boxSelect(a, b) {
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    const mine = [...this.sprites].filter(([, s]) => (
      s.owner === this.myId && !isBuildingType(s.type)
      && s.g.x >= x1 && s.g.x <= x2 && s.g.y >= y1 && s.g.y <= y2
    ));
    this.selected = new Set(mine.map(([id]) => id));
  }

  // Right click: gather, help build, attack/capture, or move; a burst marks the spot in the order's colour
  command(worldPoint) {
    const unitIds = this.selectedUnitIds();
    if (!unitIds.length) return;
    const order = this.sendOrder(unitIds, worldPoint);
    this.markers.push({ x: worldPoint.x, y: worldPoint.y, color: MARKER_COLORS[order], t: 0 });
  }

  // Emits the order for a right click at worldPoint and returns its kind
  sendOrder(unitIds, worldPoint) {
    const target = this.pickAt(worldPoint.x, worldPoint.y);
    if (target?.kind === 'resource') {
      this.socket.emit('game:gather', { unitIds, resourceId: target.id });
      return 'gather';
    }
    const s = target?.kind === 'entity' ? this.sprites.get(target.id) : null;
    if (s && isBuildingType(s.type) && !s.built && s.owner === this.myId) {
      this.socket.emit('game:construct', { unitIds, buildingId: target.id });
      return 'build';
    }
    if (s && ENTITY_STATS[s.type].farm && s.built && s.owner === this.myId) {
      this.socket.emit('game:farm', { unitIds, buildingId: target.id });
      return 'gather';
    }
    // Enemies, the neutral central town center, or a fallen one (villagers capture it)
    if (s && (s.owner !== this.myId || (s.central && s.hp <= 0))) {
      this.socket.emit('game:attack', { unitIds, targetId: target.id });
      return 'attack';
    }
    this.socket.emit('game:move', { unitIds, x: worldPoint.x, y: worldPoint.y });
    return 'move';
  }

  // Expanding ring + a burst of sparks that fades out where an order was given
  drawMarkers(dt) {
    const g = this.effects;
    for (const m of this.markers) {
      m.t += dt;
      const k = Math.min(1, m.t / MARKER_LIFE);
      const alpha = 1 - k;
      const ease = 1 - (1 - k) ** 3;
      g.ellipse(m.x, m.y, 6 + ease * 22, (6 + ease * 22) * 0.5).stroke({ width: 3 * alpha + 1, color: m.color, alpha });
      g.circle(m.x, m.y, 4 * alpha).fill({ color: 0xffffff, alpha });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const d = 6 + ease * 26;
        g.circle(m.x + Math.cos(a) * d, m.y + Math.sin(a) * d * 0.5 - ease * 6, 2.5 * alpha + 0.5).fill({ color: m.color, alpha });
      }
    }
    this.markers = this.markers.filter((m) => m.t < MARKER_LIFE);
  }

  // Ctrl/Cmd + digit saves the selected units as a group; the digit alone selects it again, and pressing
  // it twice quickly centres the camera on the group
  // My villagers with no job (a plain move order that has finished counts as idle)
  idleVillagers() {
    return [...this.sprites.entries()]
      .filter(([, s]) => s.owner === this.myId && s.type === 'villager' && !s.task && s.action !== 'moving')
      .map(([id]) => id);
  }

  // Selects the next idle villager (cycling on repeated use) and centres the camera on it
  selectIdleVillager() {
    const ids = this.idleVillagers().sort((a, b) => a - b);
    if (!ids.length) return;
    const id = ids.find((i) => i > (this.lastIdleId ?? -Infinity)) ?? ids[0];
    this.lastIdleId = id;
    this.selected = new Set([id]);
    const { g } = this.sprites.get(id);
    const k = this.world.scale.x;
    this.world.position.set(this.app.screen.width / 2 - g.x * k, this.app.screen.height / 2 - g.y * k);
    this.clampCamera();
    this.renderHud();
  }

  handleGroupKey(e) {
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!digit || e.target.closest?.('input, textarea')) return false;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const ids = this.selectedUnitIds();
      if (ids.length) {
        this.groups.set(digit, ids);
        this.showMessage(`Grupo ${digit}: ${ids.length} unidades`, 'notice');
      }
      return true;
    }
    const ids = (this.groups.get(digit) ?? []).filter((id) => this.sprites.has(id));
    this.groups.set(digit, ids);
    if (!ids.length) return true;
    this.selected = new Set(ids);
    this.renderHud();
    const now = performance.now();
    if (this.lastGroupKey?.digit === digit && now - this.lastGroupKey.time < DOUBLE_CLICK_MS) {
      const xs = ids.map((id) => this.sprites.get(id).g);
      const cx = xs.reduce((sum, g) => sum + g.x, 0) / xs.length;
      const cy = xs.reduce((sum, g) => sum + g.y, 0) / xs.length;
      const k = this.world.scale.x;
      this.world.position.set(this.app.screen.width / 2 - cx * k, this.app.screen.height / 2 - cy * k);
      this.clampCamera();
    }
    this.lastGroupKey = { digit, time: now };
    return true;
  }

  setupInput() {
    this.onKeyDown = (e) => {
      if (e.key === 'Escape') { this.placing = null; this.renderHud(); }
      if (this.handleGroupKey(e)) return;
      if (e.key === '.' && !e.target.closest?.('input, textarea')) { this.selectIdleVillager(); return; }
      this.keys.add(e.key.toLowerCase());
    };
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.onIdleClick = () => this.selectIdleVillager();
    this.ui.idleButton?.addEventListener('click', this.onIdleClick);
    this.app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.app.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt({ x: e.offsetX, y: e.offsetY }, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;

    stage.on('pointerdown', (e) => {
      const p = this.world.toLocal(e.global);
      if (e.button === 2) {
        if (this.placing) { this.placing = null; this.renderHud(); } else this.command(p);
        return;
      }
      if (e.button !== 0) return;
      if (this.placing) { this.placeBuilding(); return; }
      this.dragStart = { x: e.global.x, y: e.global.y };
    });

    stage.on('pointermove', (e) => {
      this.pointer = { x: e.global.x, y: e.global.y };
      if (!this.dragStart) return;
      const d = this.dragStart;
      this.selectionBox.clear()
        .rect(d.x, d.y, e.global.x - d.x, e.global.y - d.y)
        .fill({ color: SELECT_COLOR, alpha: 0.1 }).stroke({ width: 1, color: SELECT_COLOR });
    });

    const endDrag = (e) => {
      if (!this.dragStart) return;
      const start = this.dragStart;
      this.dragStart = null;
      this.selectionBox.clear();
      const moved = Math.hypot(e.global.x - start.x, e.global.y - start.y);
      if (moved < CLICK_THRESHOLD) this.click(this.world.toLocal(e.global));
      else this.boxSelect(this.world.toLocal(start), this.world.toLocal(e.global));
      this.renderHud();
    };
    stage.on('pointerup', endDrag);
    stage.on('pointerupoutside', endDrag);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.messageTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.ui.idleButton?.removeEventListener('click', this.onIdleClick);
    this.ui.idleButton?.classList.add('hidden');
    this.territory?.destroy();
    this.ui.tooltip.classList.add('hidden');
    this.ui.buildMenu.replaceChildren();
    this.app?.renderer && this.app.destroy(true, { children: true });
  }
}
