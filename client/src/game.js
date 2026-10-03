import {
  AnimatedSprite, Application, BlurFilter, Container, Graphics, Sprite, TilingSprite,
} from 'pixi.js';
import { loadAssets } from './assets.js';
import {
  ENTITY_STATS, MAP_TILES, TILE_SIZE, Terrain, ResourceType, RESOURCE_NAMES, MAX_TRAIN_QUEUE, CENTRAL_CONTROL_TIME,
  MAX_POPULATION,
} from '../../shared/constants.js';
import {
  isBuildingType, buildingSize, tileForCenter, footprint, canPlace, canAfford, formatCost,
} from '../../shared/rules.js';

const SAND_COLOR = 0xd8c08a;
const SAND_LIGHT = 0xe6d3a3;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;
const NEUTRAL_FACTION = 'black'; // castle art used for the unclaimed central town center

// Sprite sheet prefix and scale per unit type (frames are 192px, lancer 320px)
const UNIT_ART = {
  villager: { sheet: 'pawn', scale: 0.32 },
  swordsman: { sheet: 'warrior', scale: 0.36 },
  archer: { sheet: 'archer', scale: 0.34 },
  horseman: { sheet: 'lancer', scale: 0.26 },
};
// Building texture per building type; width = footprint * widthFactor
const BUILDING_ART = {
  townCenter: { texture: 'castle', widthFactor: 1.1 },
  barracks: { texture: 'barracks', widthFactor: 1.15 },
  archeryRange: { texture: 'archery', widthFactor: 1.15 },
  stable: { texture: 'monastery', widthFactor: 1.15 },
  tower: { texture: 'tower', widthFactor: 1.5 },
  house: { texture: 'house1', variants: ['house1', 'house2', 'house3'], widthFactor: 1.3 },
};
// Seconds per full animation cycle, so long and short sheets play at a natural pace.
// Attacks use the unit's own cooldown so each swing matches a hit.
const ANIM_CYCLE = { idle: 1.2, run: 0.75, work: 0.9 };
const ANIM_GROUP = {
  idle: 'idle', run: 'run', run_wood: 'run', run_gold: 'run', run_meat: 'run', attack: 'attack', shoot: 'attack',
};
const LOW_HP_FIRE = 0.5; // buildings below this fraction of hp burn
const HOVER_COLOR = 0xffffff;
const SELECT_COLOR = 0x00ff00;
const CLICK_THRESHOLD = 5; // px of pointer movement before a click becomes a drag-select
const BUILDABLE = Object.keys(ENTITY_STATS).filter(isBuildingType);
const NEUTRAL_COLOR = 0x9e9e9e;
const tileKey = (x, y) => `${x},${y}`;
const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Draws a progress bar centred at (0, y) on graphics g
function drawBar(g, y, width, fraction, color) {
  g.rect(-width / 2, y, width, 5).fill(0x111111);
  g.rect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), 5).fill(color);
}

// Rendering + input only. All game logic runs on the server.
export class Game {
  constructor(socket, mount, ui) {
    this.socket = socket;
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
    this.destroyed = false;
  }

  async init({ map, resources, players }) {
    this.app = new Application();
    await this.app.init({ resizeTo: window, background: 0x1b2a1b, antialias: true });
    if (this.destroyed) { this.app.destroy(true); return; }
    this.mount.prepend(this.app.canvas);

    for (const p of players) this.players.set(p.id, p);

    this.assets = await loadAssets();
    if (this.destroyed) return;

    this.world = new Container();
    this.app.stage.addChild(this.world);
    this.world.addChild(this.drawGround(map));
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
    this.selectionBox = new Graphics();
    this.app.stage.addChild(this.selectionBox);

    this.createBuildMenu();
    this.renderHud();
    this.app.ticker.add((t) => this.update(t));
    this.setupInput();
  }

  // ---------- World ----------

  // Sand is drawn as overlapping blobs and blurred once, so it fades into the grass instead of hard tile edges
  drawGround(map) {
    const ground = new Container();
    const grass = new TilingSprite({ texture: this.assets.grass, width: map.width, height: map.height });
    grass.tileScale.set(TILE_SIZE / 64);

    const sand = new Container();
    const base = new Graphics();
    const light = new Graphics();
    const isSand = (tx, ty) => map.tiles[ty * MAP_TILES + tx] === Terrain.SAND;
    for (let ty = 0; ty < MAP_TILES; ty++) {
      for (let tx = 0; tx < MAP_TILES; tx++) {
        if (!isSand(tx, ty)) continue;
        const cx = (tx + 0.5) * TILE_SIZE;
        const cy = (ty + 0.5) * TILE_SIZE;
        base.circle(cx, cy, TILE_SIZE * 0.85);
        // Lighter core on tiles surrounded by sand gives the paths some depth
        const inner = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => isSand(tx + dx, ty + dy));
        if (inner) light.circle(cx + ((tx * 7) % 5) - 2, cy + ((ty * 11) % 5) - 2, TILE_SIZE * 0.55);
      }
    }
    base.fill(SAND_COLOR);
    light.fill({ color: SAND_LIGHT, alpha: 0.7 });
    sand.addChild(base, light);
    sand.filters = [new BlurFilter({ strength: 10, quality: 4 })];
    sand.cacheAsTexture({ resolution: 1 }); // a 2x cache of the whole map would exceed the max GPU texture size
    // Blur spills past the map edge; clip it to the map
    const sandMask = new Graphics().rect(0, 0, map.width, map.height).fill(0xffffff);
    sand.mask = sandMask;
    ground.addChild(sandMask);

    const border = new Graphics().rect(0, 0, map.width, map.height).stroke({ width: 4, color: 0x222222 });
    ground.addChild(grass, sand, border);
    return ground;
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
    } else if (r.type === ResourceType.WOOD) {
      g = animated(this.assets.trees[r.id % this.assets.trees.length], 0.1);
      g.anchor.set(0.5, 0.92);
      g.scale.set(0.3);
    } else {
      g = new Sprite(this.assets.gold[r.id % this.assets.gold.length]);
      g.anchor.set(0.5, 0.75);
      g.scale.set(0.42);
    }
    g.position.set((r.tx + 0.5) * TILE_SIZE, (r.ty + 1) * TILE_SIZE);
    g.zIndex = g.y;
    this.objects.addChild(g);
    this.resources.set(r.id, { ...r, g });
    this.resourceAt.set(tileKey(r.tx, r.ty), r.id);
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

  applyState({ players, entities }) {
    if (!this.objects) return;
    this.players = new Map(players.map((p) => [p.id, p]));
    const me = this.players.get(this.socket.id);
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
      }
      Object.assign(s, e);
    }
    for (const [id, s] of this.sprites) {
      if (seen.has(id)) continue;
      // Buildings blow up, units leave a puff of dust
      if (isBuildingType(s.type)) this.spawnFx(s.id % 2 ? 'explosion1' : 'explosion2', s.x, s.y, buildingSize(s.type) / 120);
      else this.spawnFx('dust1', s.g.x, s.g.y, 0.7);
      s.g.destroy({ children: true });
      this.sprites.delete(id);
      this.selected.delete(id);
    }
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
      sprite = new AnimatedSprite(this.unitFrames(e.type, e.owner, 'idle'));
      sprite.anchor.set(0.5, 0.55);
      sprite.play();
    }
    g.addChild(under, sprite);
    if (fire) g.addChild(fire);
    g.addChild(over);
    this.objects.addChild(g);
    return {
      g, under, over, sprite, fire, anim: 'idle', facing: 1,
    };
  }

  factionOf(owner) { return this.players.get(owner)?.faction ?? NEUTRAL_FACTION; }

  unitFrames(type, owner, anim) {
    return this.assets.units[this.factionOf(owner)][`${UNIT_ART[type].sheet}_${anim}`];
  }

  // Picks the sheet that matches what the unit is doing this tick
  unitAnim(s) {
    if (s.type === 'villager') {
      if (s.action === 'gathering') return { gold: 'pickaxe', food: 'knife' }[s.carry?.type] ?? 'axe';
      if (s.action === 'building') return 'hammer';
      if (s.action === 'attacking') return 'axe';
      if (s.action === 'moving') {
        if (s.carry?.amount > 0) return `run_${{ gold: 'gold', food: 'meat' }[s.carry.type] ?? 'wood'}`;
        return 'run';
      }
      return 'idle';
    }
    if (s.action === 'attacking') return s.type === 'archer' ? 'shoot' : 'attack';
    return s.action === 'moving' ? 'run' : 'idle';
  }

  // Center the camera on this player's town center
  focusOnBase() {
    const tc = [...this.sprites.values()].find((s) => s.owner === this.socket.id && s.type === 'townCenter');
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
    const mapSize = MAP_TILES * TILE_SIZE * k;
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
    for (const s of this.sprites.values()) {
      if (!isBuildingType(s.type)) continue;
      const n = ENTITY_STATS[s.type].tiles;
      if (x >= s.tx && x < s.tx + n && y >= s.ty && y < s.ty + n) return true;
    }
    return false;
  };

  // ---------- Hit testing ----------

  entityAt(x, y) {
    // Units first, they are drawn on top of buildings
    for (const [id, s] of this.sprites) {
      if (isBuildingType(s.type)) continue;
      if (Math.hypot(s.g.x - x, s.g.y - y) <= ENTITY_STATS[s.type].radius + 3) return id;
    }
    for (const [id, s] of this.sprites) {
      if (!isBuildingType(s.type)) continue;
      const half = buildingSize(s.type) / 2;
      if (Math.abs(s.x - x) <= half && Math.abs(s.y - y) <= half) return id;
    }
    return null;
  }

  resourceAtPoint(x, y) {
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

    // Interpolate toward server positions and redraw
    this.effects.clear();
    this.drawArrows(t.deltaMS / 1000);
    for (const [id, s] of this.sprites) {
      const dx = s.x - s.g.x;
      s.g.x += dx * 0.3;
      s.g.y += (s.y - s.g.y) * 0.3;
      if (Math.abs(dx) > 0.3) s.facing = Math.sign(dx);
      if (isBuildingType(s.type)) this.drawBuilding(s, this.selected.has(id));
      else this.drawUnit(s, this.selected.has(id));
    }

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
    s.sprite.y = half + 4;
    s.sprite.alpha = s.built ? 1 : 0.35 + 0.5 * s.buildProgress;
    s.sprite.tint = fallen ? 0x555555 : (s.central && !s.owner ? 0xbbbbbb : 0xffffff);

    // Puff of dust the moment construction finishes; flames while badly damaged
    if (s.built && s.wasBuilt === false) this.spawnFx('dust2', s.x, s.y + half - 6, size / 70);
    s.wasBuilt = s.built;
    const burning = s.built && !fallen && s.hp < stats.hp * LOW_HP_FIRE;
    if (burning && !s.fire.visible) s.fire.play();
    else if (!burning) s.fire.stop();
    s.fire.visible = burning;
    if (burning) {
      s.fire.scale.set(size / 70);
      s.fire.position.set(((s.id * 13) % 11) - 5, half - size * 0.45);
    }

    const under = s.under.clear();
    if (isSelected) under.ellipse(0, half - 4, half + 8, half / 2.5).stroke({ width: 2, color: SELECT_COLOR });

    const g = s.over.clear();
    const top = half + 4 - s.sprite.height;
    if (!s.built) drawBar(g, half + 8, size, s.buildProgress, 0xf0a030);
    if (s.central) {
      // Crown above the central town center
      const y = top - 6;
      g.poly([-14, y, -14, y - 14, -7, y - 6, 0, y - 18, 7, y - 6, 14, y - 14, 14, y]).fill(fallen ? 0x777777 : 0xffd34d)
        .stroke({ width: 1.5, color: 0x5a4300 });
      if (s.owner) drawBar(g, half + 8, size, s.controlTime / CENTRAL_CONTROL_TIME, color);
    }
    if (s.built && s.queue?.length) {
      drawBar(g, half + 8, size, s.trainProgress, 0x4fc3f7);
      s.queue.forEach((_, i) => g.circle(-half + 5 + i * 9, half + 19, 3).fill(0x4fc3f7));
    }
    if (stats.attack && s.built && (isSelected || this.hovered?.id === s.id)) {
      this.effects.circle(s.x, s.y, stats.attack.range).stroke({ width: 1, color, alpha: 0.6 });
    }
    if (s.hp < stats.hp && s.built && !fallen) drawBar(g, top - 2, size, s.hp / stats.hp, 0x4caf50);
  }

  drawUnit(s, isSelected) {
    const stats = ENTITY_STATS[s.type];
    const r = stats.radius;
    s.g.zIndex = s.g.y + r;

    // Swap animation when the action changes
    const anim = this.unitAnim(s);
    if (anim !== s.anim) {
      s.anim = anim;
      const frames = this.unitFrames(s.type, s.owner, anim);
      s.sprite.textures = frames;
      const group = ANIM_GROUP[anim] ?? 'work';
      const cycle = group === 'attack' ? stats.attack.cooldown : ANIM_CYCLE[group];
      // animationSpeed is frames per 60fps tick
      s.sprite.animationSpeed = frames.length / (cycle * 60);
      s.sprite.play();
    }
    // Galloping horses kick up dust
    if (s.type === 'horseman' && s.action === 'moving' && Math.random() < 0.04) {
      this.spawnFx('dust1', s.g.x - s.facing * 10, s.g.y + r, 0.35);
    }
    // Face the target while attacking, otherwise the movement direction
    const target = s.action === 'attacking' ? this.sprites.get(s.targetId) : null;
    if (target && Math.abs(target.g.x - s.g.x) > 1) s.facing = Math.sign(target.g.x - s.g.x);
    const { scale } = UNIT_ART[s.type];
    s.sprite.scale.set(scale * s.facing, scale);

    const under = s.under.clear();
    under.ellipse(0, r * 0.9, r + 2, r * 0.45).fill({ color: 0x000000, alpha: 0.25 });
    if (isSelected) under.ellipse(0, r * 0.9, r + 5, r * 0.6).stroke({ width: 2, color: SELECT_COLOR });

    const g = s.over.clear();
    const barY = -r - 22;
    if (s.action === 'gathering') drawBar(g, barY, 26, s.gatherFill, { gold: 0xffd34d, food: 0xe57373 }[s.carry?.type] ?? 0x8bc34a);
    else if (s.action === 'building') drawBar(g, barY, 26, this.sprites.get(s.buildingId)?.buildProgress ?? 0, 0xf0a030);
    if (s.hp < stats.hp) drawBar(g, barY + 7, 24, s.hp / stats.hp, 0x4caf50);
  }

  // Arrows from towers and archers fly toward the target's current position
  addShots(shots) {
    for (const { x, y, targetId } of shots) {
      const target = this.sprites.get(targetId);
      if (!target) continue;
      this.arrows.push({ x, y, targetId, to: { x: target.g.x, y: target.g.y }, t: 0 });
    }
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
      if (a.t >= 1) a.sprite.destroy();
    }
    this.arrows = this.arrows.filter((a) => a.t < 1);
  }

  drawOverlay() {
    const g = this.overlay.clear();

    if (this.placing) {
      const { tx, ty } = this.ghostTile();
      const valid = canPlace(this.placing, tx, ty, this.isTileBlocked)
        && canAfford(this.stock, ENTITY_STATS[this.placing].cost);
      const tint = valid ? 0x4caf50 : 0xe53935;
      for (const [x, y] of footprint(this.placing, tx, ty)) {
        const blocked = x < 0 || y < 0 || x >= MAP_TILES || y >= MAP_TILES || this.isTileBlocked(x, y);
        g.rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill({ color: blocked ? 0xe53935 : tint, alpha: 0.35 });
      }
      const size = buildingSize(this.placing);
      g.rect(tx * TILE_SIZE, ty * TILE_SIZE, size, size).stroke({ width: 2, color: tint });

      // Building preview in the player's own faction
      const art = BUILDING_ART[this.placing];
      const texture = this.assets.buildings[this.factionOf(this.socket.id)][art.texture];
      this.ghost.texture = texture;
      this.ghost.scale.set((size * art.widthFactor) / texture.width);
      this.ghost.position.set(tx * TILE_SIZE + size / 2, ty * TILE_SIZE + size + 4);
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
      g.ellipse(s.x, s.y + half - 4, half + 8, half / 2.5).stroke({ width: 2, color: HOVER_COLOR });
    } else {
      const r = ENTITY_STATS[s.type].radius;
      g.ellipse(s.g.x, s.g.y + r * 0.9, r + 5, r * 0.6).stroke({ width: 2, color: HOVER_COLOR });
    }
  }

  // ---------- UI ----------

  renderHud() {
    const mine = [...this.sprites.values()].filter((s) => s.owner === this.socket.id);
    const villagers = mine.filter((s) => s.type === 'villager');
    const idle = villagers.filter((s) => !s.task).length;
    const army = mine.filter((s) => !isBuildingType(s.type) && s.type !== 'villager').length;
    const popFull = this.pop.used >= this.pop.cap;
    const items = [
      [{ icon: '/assets/ui/food.png', label: 'Comida' }, this.stock.food],
      [{ icon: '/assets/ui/wood.png', label: 'Madera' }, this.stock.wood],
      [{ icon: '/assets/ui/gold.png', label: 'Oro' }, this.stock.gold],
      ['🏠 Población', `${this.pop.used}/${this.pop.cap}${this.pop.cap >= MAX_POPULATION ? ' (máx.)' : ''}`, popFull],
      ['👷 Aldeanos', `${villagers.length} (${idle} inactivos)`],
      ['⚔️ Ejército', army],
    ];
    const central = [...this.sprites.values()].find((s) => s.central);
    if (central) {
      const holder = this.players.get(central.owner);
      items.push(['👑 Centro', holder
        ? `${holder.id === this.socket.id ? 'Tú' : holder.name} ${formatTime(central.controlTime)} / ${formatTime(CENTRAL_CONTROL_TIME)}`
        : 'neutral']);
    }
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

  createBuildMenu() {
    this.ui.buildMenu.replaceChildren(...BUILDABLE.map((type) => {
      const stats = ENTITY_STATS[type];
      const btn = document.createElement('button');
      btn.dataset.type = type;
      const img = document.createElement('img');
      img.src = `/assets/${this.factionOf(this.socket.id)}/${BUILDING_ART[type].texture}.png`;
      img.alt = '';
      const name = document.createElement('strong');
      name.textContent = stats.name;
      const cost = document.createElement('small');
      cost.textContent = formatCost(stats.cost);
      const trains = document.createElement('small');
      if (stats.trains) trains.textContent = `Entrena ${ENTITY_STATS[stats.trains].name}`;
      else if (stats.attack) trains.textContent = `Dispara flechas · alcance ${stats.attack.range}`;
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
      const label = r.variant === 'bush' ? 'Arbusto' : { wood: 'Árbol', gold: 'Mina de oro', food: 'Oveja' }[r.type];
      return `${label} — ${r.amount}/${r.max} ${RESOURCE_NAMES[r.type]}`;
    }

    const s = this.sprites.get(this.hovered.id);
    if (!s) return null;
    const stats = ENTITY_STATS[s.type];
    const owner = this.players.get(s.owner)?.name ?? 'neutral';
    const mine = s.owner === this.socket.id;
    const name = s.central ? 'Centro urbano central' : stats.name;
    const lines = [`${name} (${mine ? 'tú' : owner}) — PV ${s.hp}/${stats.hp}`];

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
    if (!canPlace(this.placing, tx, ty, this.isTileBlocked)) return this.showMessage('No se puede construir ahí');
    // Selected villagers go build it; the server picks the closest villager when none are selected
    const unitIds = this.selectedUnitIds().filter((id) => this.sprites.get(id).type === 'villager');
    this.socket.emit('game:build', { type: this.placing, tx, ty, unitIds });
    if (!this.keys.has('shift')) this.placing = null;
    this.renderHud();
  }

  // Single left click: train from own building, select own unit, or clear selection
  click(worldPoint) {
    const id = this.entityAt(worldPoint.x, worldPoint.y);
    const s = id != null ? this.sprites.get(id) : null;
    if (!s || s.owner !== this.socket.id) { this.selected.clear(); return; }
    this.selected = new Set([id]);
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

  boxSelect(a, b) {
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    const mine = [...this.sprites].filter(([, s]) => (
      s.owner === this.socket.id && !isBuildingType(s.type)
      && s.g.x >= x1 && s.g.x <= x2 && s.g.y >= y1 && s.g.y <= y2
    ));
    this.selected = new Set(mine.map(([id]) => id));
  }

  // Right click: gather, help build, attack/capture, or move
  command(worldPoint) {
    const unitIds = this.selectedUnitIds();
    if (!unitIds.length) return;
    const target = this.pickAt(worldPoint.x, worldPoint.y);
    if (target?.kind === 'resource') {
      this.socket.emit('game:gather', { unitIds, resourceId: target.id });
      return;
    }
    const s = target?.kind === 'entity' ? this.sprites.get(target.id) : null;
    if (s && isBuildingType(s.type) && !s.built && s.owner === this.socket.id) {
      this.socket.emit('game:construct', { unitIds, buildingId: target.id });
      return;
    }
    // Enemies, the neutral central town center, or a fallen one (villagers capture it)
    if (s && (s.owner !== this.socket.id || (s.central && s.hp <= 0))) {
      this.socket.emit('game:attack', { unitIds, targetId: target.id });
      return;
    }
    this.socket.emit('game:move', { unitIds, x: worldPoint.x, y: worldPoint.y });
  }

  setupInput() {
    this.onKeyDown = (e) => {
      if (e.key === 'Escape') { this.placing = null; this.renderHud(); }
      this.keys.add(e.key.toLowerCase());
    };
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
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
    this.ui.tooltip.classList.add('hidden');
    this.ui.buildMenu.replaceChildren();
    this.app?.renderer && this.app.destroy(true, { children: true });
  }
}
