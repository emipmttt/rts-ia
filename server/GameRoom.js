import {
  TICK_RATE, TILE_SIZE, MAX_PLAYERS_PER_ROOM, MAX_TEAMS, STARTING_VILLAGERS, STARTING_STOCK,
  MAX_TRAIN_QUEUE, CENTRAL_CONTROL_TIME, FACTIONS, CIVILIZATIONS, EntityType, ENTITY_STATS, unitStats, RESOURCE_STATS, MAX_POPULATION,
  Terrain, ResourceType, mapTilesFor, SCORE, CENTRAL_HP, CENTRAL_GUARDS, GUARD_LEASH, GATHER_UPGRADES, SHEEP, AGES,
} from '../shared/constants.js';
import {
  isBuildingType, isUnitType, buildingSize, buildingCenter, tileForCenter, footprint, canPlace, canAfford, wallLine,
} from '../shared/rules.js';
import { assignSpawns } from './spawns.js';
import { generateWorld } from './worldgen.js';
import { findPath, clearLine } from './pathfinding.js';

const DT = 1 / TICK_RATE;
const RETARGET_RADIUS = 400; // how far a villager looks for more of the same resource
const STUCK_TICKS = TICK_RATE * 4; // a gatherer that can't move toward its resource this long picks another one
const WORKING_SLACK = 14; // px a gatherer already working a resource may be shoved away and keep at it
const NEXT_CONSTRUCTION_RADIUS = 900; // a builder done with a building looks this far for the next one
const CROWD_PENALTY = 60; // px a resource counts as farther away per villager already working it
const SEPARATION_CELL = 32; // grid cell size for unit collision lookups (>= largest unit diameter)
const SEPARATION_ITERATIONS = 4;
const COLLISION_PADDING = 3; // units keep this much extra space between each other, matching their sprites
const TERRAIN_RADIUS = 0.8; // fraction of a unit's radius that must stay out of trees and water
const REPATH_TICKS = TICK_RATE; // a blocked unit retries its path at most once a second
const RECONNECT_GRACE_MS = 5 * 60 * 1000; // a playing room with nobody connected is closed after this

// Trees and mines are solid; bushes and sheep can be walked through
const isSolidResource = (r) => r.type === ResourceType.GOLD || r.type === ResourceType.STONE
  || (r.type === ResourceType.WOOD && r.variant !== 'bush');
const isSheep = (r) => r.variant === 'sheep';
// Movement stats of anything that walks: units, and sheep (which are resources)
const bodyOf = (u) => (isSheep(u) ? SHEEP : ENTITY_STATS[u.type]);
const FLAG_MAX_LENGTH = 40000; // data URL of the player's hand-drawn flag
const SHEEP_CHECK_TICKS = 10; // how often sheep look for nearby units to follow
const CHEER_TIME = 0.9; // seconds a soldier spends shouting and waving before charging into a fight
const CHEER_COOLDOWN = TICK_RATE * 10; // it only does it again after this long
const FORMATION_SPACING = 34; // px between soldiers in a marching formation
// Formation ranks from the front: shields and blades, then riders, then everything that shoots, monks last
const FORMATION_RANK = { spearman: 0, swordsman: 1, guard: 1, villager: 4, horseman: 2, bowman: 3, archer: 3, monk: 4 };
const BUILDING_OVERHANG = 1.06;
const FRONT = Math.PI / 2; // buildings face +y (south, toward the default camera): their doors are there // the 3D models are a little wider than their footprint
const BUILDING_CELL = 2; // walkBlocked value of a building's tile (1 = water, tree or mine)
// Unit orders a client may send, and the method handling each
const ORDER_HANDLERS = {
  move: 'handleMove', gather: 'handleGather', build: 'handleBuild', wall: 'handleWall', construct: 'handleConstruct', farm: 'handleFarm', attack: 'handleAttack',
};
const ARRIVE_MARGIN = 22; // px from a building's walls that count as having reached it (any tile around it)

export const RoomStatus = { WAITING: 'waiting', PLAYING: 'playing', FINISHED: 'finished' };

const isUnit = (e) => isUnitType(e.type);
const isBuilding = (e) => isBuildingType(e.type);
const tileKey = (x, y) => `${x},${y}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export class GameRoom {
  constructor(io, id, name, hostId) {
    this.io = io;
    this.id = id;
    this.name = name;
    this.hostId = hostId;
    this.status = RoomStatus.WAITING;
    this.players = new Map(); // playerId -> { id, name, faction, color, stock, connected }
    this.entities = new Map(); // entityId -> unit or building
    this.resources = new Map(); // resourceId -> { id, type, tx, ty, x, y, amount }
    this.resourceTiles = new Map(); // "tx,ty" -> resourceId
    this.buildingTiles = new Map(); // "tx,ty" -> buildingId
    this.mapTiles = 0; // map side in tiles, set when the game starts (bigger with more players)
    this.mapSize = 0; // map side in px
    this.walkBlocked = null; // Uint8Array, 1 = water, tree or mine, 2 = building (not farms)
    this.gridVersion = 0; // bumped whenever a building appears or goes, so paths get recomputed
    this.gateTiles = new Map(); // tile index -> owner of the gate standing there
    this.ownerGrids = new Map(); // owner -> walkBlocked with that player's own gates open
    this.tickCount = 0;
    this.emptySince = null; // when the last player of a running game lost connection
    this.resourceChanges = new Map(); // resourceId -> new amount (0 = depleted), flushed each tick
    this.shots = []; // arrows fired this tick, sent to clients for the animation
    this.world = null;
    this.central = null; // the neutral, indestructible town center in the middle of the map
    this.settings = { central: true }; // chosen by the host before starting
    this.startingPlayers = 0;
    this.nextEntityId = 1;
    this.interval = null;
    this.onStatusChange = () => {}; // set by the lobby to refresh the room list
  }

  get isFull() { return this.players.size >= MAX_PLAYERS_PER_ROOM; }
  get isEmpty() { return this.players.size === 0; }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      players: this.players.size,
      max: MAX_PLAYERS_PER_ROOM,
      settings: this.settings,
    };
  }

  // Host-only match options, while the room is waiting
  updateSettings(playerId, { central } = {}) {
    if (playerId !== this.hostId || this.status !== RoomStatus.WAITING) return;
    if (typeof central === 'boolean') this.settings.central = central;
    this.broadcastRoom();
    this.onStatusChange();
  }

  details() {
    return {
      ...this.summary(),
      hostId: this.hostId,
      players: [...this.players.values()].map(({
        id, name, faction, color, flag, civ, team,
      }) => ({
        id, name, faction, color, flag, civ, team,
      })),
    };
  }

  // Team (0 = alone, 1..MAX_TEAMS) and colour, picked in the waiting room; a colour taken by someone
  // else can't be picked
  setTeam(playerId, team) {
    const player = this.players.get(playerId);
    if (!player || this.status !== RoomStatus.WAITING || !Number.isInteger(team) || team < 0 || team > MAX_TEAMS) return;
    player.team = team;
    this.broadcastRoom();
  }

  setColor(playerId, factionId) {
    const player = this.players.get(playerId);
    const faction = FACTIONS.find((f) => f.id === factionId);
    if (!player || !faction || this.status !== RoomStatus.WAITING) return;
    if ([...this.players.values()].some((p) => p.id !== playerId && p.faction === factionId)) return this.error(playerId, 'Ese color ya está ocupado');
    player.faction = faction.id;
    player.color = faction.color;
    this.broadcastRoom();
  }

  // Same player, or teammates: they don't fight each other, share vision and win together
  allied(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ta = this.players.get(a)?.team, tb = this.players.get(b)?.team;
    return !!ta && ta === tb;
  }

  // Each player picks their own civilization while the room is waiting
  setCiv(playerId, civ) {
    const player = this.players.get(playerId);
    if (!player || this.status !== RoomStatus.WAITING || !CIVILIZATIONS.some((c) => c.id === civ)) return;
    player.civ = civ;
    this.broadcastRoom();
  }

  broadcastRoom() { this.io.to(this.id).emit('room:update', this.details()); }

  addPlayer(playerId, name, flag) {
    // Random faction among the ones not taken yet in this room
    const used = new Set([...this.players.values()].map((p) => p.faction));
    const free = FACTIONS.filter((f) => !used.has(f.id));
    const faction = free[Math.floor(Math.random() * free.length)];
    this.players.set(playerId, {
      id: playerId, name, faction: faction.id, color: faction.color, civ: CIVILIZATIONS[0].id, team: 0, stock: { ...STARTING_STOCK }, defeated: false,
      connected: true, pop: 0, popCap: 0, stats: { trained: 0, lost: 0, kills: 0, gathered: 0 },
      gatherLevel: 0, // lumber camp upgrades researched
      age: 1, // 1..AGES.length
      flag: typeof flag === 'string' && flag.startsWith('data:image/png;base64,') && flag.length <= FLAG_MAX_LENGTH ? flag : null,
    });
    this.broadcastRoom();
  }

  removePlayer(playerId) {
    if (!this.players.has(playerId)) return;
    this.players.delete(playerId);
    for (const e of [...this.entities.values()]) if (e.owner === playerId) this.removeEntity(e);
    if (this.central?.owner === playerId) this.loseCentral();
    // Hand host to the next player in the room
    if (this.hostId === playerId) this.hostId = this.players.keys().next().value ?? null;
    this.broadcastRoom();
    if (this.status === RoomStatus.PLAYING) this.checkGameOver();
  }

  start() {
    if (this.status !== RoomStatus.WAITING) return;
    this.status = RoomStatus.PLAYING;

    this.startingPlayers = this.players.size;
    this.startedAt = Date.now();
    this.mapTiles = mapTilesFor(this.players.size);
    this.mapSize = this.mapTiles * TILE_SIZE;
    this.walkBlocked = new Uint8Array(this.mapTiles * this.mapTiles);
    const spawns = assignSpawns([...this.players.keys()], this.mapSize, (id) => this.players.get(id).team);
    const mapCenter = { x: this.mapSize / 2, y: this.mapSize / 2 };
    this.world = generateWorld(Math.floor(Math.random() * 2 ** 31), this.mapTiles, [...spawns.values()], [mapCenter]);
    for (const r of this.world.resources) {
      this.resources.set(r.id, r);
      if (isSheep(r)) r.owner = null; // sheep walk around, so they don't occupy a tile
      else this.resourceTiles.set(tileKey(r.tx, r.ty), r.id);
    }
    for (const [playerId, point] of spawns) this.spawnPlayer(playerId, point);

    if (this.settings.central) this.spawnCentral(mapCenter);

    this.world.tiles.forEach((t, i) => { if (t === Terrain.WATER) this.walkBlocked[i] = 1; });
    for (const r of this.resources.values()) if (isSolidResource(r)) this.walkBlocked[r.ty * this.mapTiles + r.tx] = 1;

    this.io.to(this.id).emit('game:start', this.startPayload());
    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.broadcastRoom();
  }

  // The neutral central town center and the knights guarding it
  // The neutral fortress in the middle of the map, held by a garrison of a civilization picked at
  // random: its spearmen and swordsmen in the outer ring, bowmen and its elementalists behind
  spawnCentral(mapCenter) {
    const civ = CIVILIZATIONS[Math.floor(Math.random() * CIVILIZATIONS.length)].id;
    const { tx, ty } = tileForCenter(EntityType.FORTRESS, mapCenter.x, mapCenter.y);
    this.central = this.addBuilding(EntityType.FORTRESS, null, tx, ty, true);
    this.central.central = true;
    this.central.civ = civ;
    this.central.controlTime = 0;
    this.central.maxHp = CENTRAL_HP;
    this.central.hp = CENTRAL_HP;
    const rings = [
      [[EntityType.SPEARMAN, EntityType.SWORDSMAN], CENTRAL_GUARDS + 2, 50],
      [[EntityType.BOWMAN, EntityType.ARCHER], CENTRAL_GUARDS - 1, 95],
    ];
    for (const [types, count, gap] of rings) {
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + gap * 0.01;
        const d = this.outside(this.central, angle, 12) + gap;
        const guard = this.addUnit(types[i % types.length], null, mapCenter.x + Math.cos(angle) * d, mapCenter.y + Math.sin(angle) * d);
        guard.civ = civ;
        guard.post = { x: guard.x, y: guard.y };
      }
    }
  }

  // A unit's civilization: its owner's, or its own for the neutral garrison
  civOf(u) { return u.civ ?? this.players.get(u.owner)?.civ; }

  // Everything a client needs to draw the game from scratch (at the start, or after reconnecting)
  startPayload() {
    return {
      map: { width: this.mapSize, height: this.mapSize, tiles: this.world.tiles },
      resources: [...this.resources.values()].map(({
        id, type, variant, tx, ty, amount, max,
      }) => ({
        id, type, variant, tx, ty, amount, max,
      })),
      players: this.details().players,
      sheep: this.sheepState(),
    };
  }

  sheepState() {
    return [...this.resources.values()].filter(isSheep).map(({
      id, x, y, owner, amount,
    }) => ({
      id, x: Math.round(x), y: Math.round(y), owner, amount,
    }));
  }

  // A player in a running game lost or regained their connection; their village stays either way
  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    this.notice(connected ? `${player.name} se reconectó` : `${player.name} perdió la conexión`);
    const anyone = [...this.players.values()].some((p) => p.connected);
    this.emptySince = anyone ? null : Date.now();
  }

  get abandoned() { return this.emptySince !== null && Date.now() - this.emptySince > RECONNECT_GRACE_MS; }

  // ---- Entities ----

  addUnit(type, owner, x, y) {
    const id = this.nextEntityId++;
    const unit = {
      id, type, owner, x, y,
      hp: ENTITY_STATS[type].hp,
      tx: x, ty: y,
      // { type: 'gather', resourceId, resourceType } | { type: 'build', buildingId }
      // | { type: 'attack', targetId } | { type: 'capture', buildingId }
      task: null,
      action: 'idle', // what the unit is doing this tick: idle | moving | gathering | building | attacking
      cooldown: 0, // seconds until the next attack
      carry: { type: null, amount: 0 },
      gatherProgress: 0,
    };
    this.entities.set(id, unit);
    return unit;
  }

  addBuilding(type, owner, tx, ty, built) {
    const id = this.nextEntityId++;
    const { x, y } = buildingCenter(type, tx, ty);
    const maxHp = ENTITY_STATS[type].hp; // the central town center raises this after creation
    const building = {
      id, type, owner, x, y, tx, ty,
      hp: built ? maxHp : 1,
      built,
      buildProgress: built ? 1 : 0,
      queue: [], // unit types waiting to be trained
      trainProgress: 0,
      cooldown: 0, // towers only
      targetId: null, // towers only
      food: built ? (ENTITY_STATS[type].farm?.food ?? 0) : 0, // farms only: crops left to harvest
      maxHp,
      research: null, // lumber camps only: { level, progress }
    };
    for (const [cx, cy] of footprint(type, tx, ty)) this.buildingTiles.set(tileKey(cx, cy), id);
    this.setBuildingCells(building, true);
    this.entities.set(id, building);
    return building;
  }

  // Buildings are obstacles for walking and pathfinding, except farms (their fields are worked on foot)
  // and, for their owner, gates
  setBuildingCells(b, solid) {
    if (!this.walkBlocked || ENTITY_STATS[b.type].farm) return;
    for (const [cx, cy] of footprint(b.type, b.tx, b.ty)) {
      if (cx < 0 || cy < 0 || cx >= this.mapTiles || cy >= this.mapTiles) continue;
      const i = cy * this.mapTiles + cx;
      if (ENTITY_STATS[b.type].gate) {
        if (solid) this.gateTiles.set(i, b.owner);
        else this.gateTiles.delete(i);
      }
      if (solid && !this.walkBlocked[i]) this.setCell(i, BUILDING_CELL);
      else if (!solid && this.walkBlocked[i] === BUILDING_CELL) this.setCell(i, 0);
    }
    this.gridVersion++;
  }

  // Changes a tile of the walk grid, and of every player's copy of it
  setCell(i, v) {
    this.walkBlocked[i] = v;
    for (const [owner, grid] of this.ownerGrids) grid[i] = v && this.gateTiles.get(i) === owner ? 0 : v;
  }

  // The walk grid as `owner`'s units see it: the same, with their own gates open
  gridFor(owner) {
    if (!owner || ![...this.gateTiles.values()].includes(owner)) return this.walkBlocked;
    let grid = this.ownerGrids.get(owner);
    if (!grid) {
      grid = this.walkBlocked.slice();
      for (const [i, o] of this.gateTiles) if (o === owner) grid[i] = 0;
      this.ownerGrids.set(owner, grid);
    }
    return grid;
  }

  removeEntity(e) {
    this.entities.delete(e.id);
    if (isBuilding(e)) {
      for (const [cx, cy] of footprint(e.type, e.tx, e.ty)) this.buildingTiles.delete(tileKey(cx, cy));
      this.setBuildingCells(e, false);
    }
  }

  isTileBlocked = (x, y) => this.resourceTiles.has(tileKey(x, y)) || this.buildingTiles.has(tileKey(x, y))
    || this.world.tiles[y * this.mapTiles + x] === Terrain.WATER || this.world.tiles[y * this.mapTiles + x] === Terrain.BRIDGE;

  // Distance from a building's middle, along `angle`, to just past its walls (the square footprint
  // reaches further toward the corners; the 3D models overhang it a little)
  outside(b, angle, radius) {
    const half = this.bodyRadius(b);
    return half / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))) + radius + 12;
  }

  // Town center at the spawn point, villagers placed in front of it
  spawnPlayer(owner, point) {
    const { tx, ty } = tileForCenter(EntityType.TOWN_CENTER, point.x, point.y);
    const tc = this.addBuilding(EntityType.TOWN_CENTER, owner, tx, ty, true);

    for (let i = 0; i < STARTING_VILLAGERS; i++) {
      const angle = FRONT + (i - (STARTING_VILLAGERS - 1) / 2) * 0.35;
      const distance = this.outside(tc, angle, ENTITY_STATS[EntityType.VILLAGER].radius);
      this.addUnit(EntityType.VILLAGER, owner, tc.x + Math.cos(angle) * distance, tc.y + Math.sin(angle) * distance);
    }
  }

  // ---- Commands from clients ----

  ownedUnits(playerId, unitIds) {
    if (this.status !== RoomStatus.PLAYING || !Array.isArray(unitIds)) return [];
    return unitIds.map((id) => this.entities.get(id)).filter((e) => e && e.owner === playerId && isUnit(e));
  }

  ownedVillagers(playerId, unitIds) {
    return this.ownedUnits(playerId, unitIds).filter((u) => u.type === EntityType.VILLAGER);
  }

  // Units sent somewhere together march in formation: rows facing the way they go, shields and blades
  // in front, riders behind them, archers and casters after, monks last; the whole group keeps to its
  // slowest member's pace so it arrives together
  handleMove(playerId, { unitIds, x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const units = this.ownedUnits(playerId, unitIds);
    if (!units.length) return;
    const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
    const cy = units.reduce((s, u) => s + u.y, 0) / units.length;
    const len = Math.hypot(x - cx, y - cy) || 1;
    const fx = (x - cx) / len, fy = (y - cy) / len; // facing
    const sx = -fy, sy = fx; // across the rows
    const width = Math.max(1, Math.round(Math.sqrt(units.length * 1.8)));
    const ranked = [...units].sort((a, b) => (FORMATION_RANK[a.type] ?? 2) - (FORMATION_RANK[b.type] ?? 2));
    // From each unit's own top speed: not its current one, which may be slowed by ice or by the
    // previous formation (that compounded with every new order until the army crawled)
    const slowest = units.length > 1 ? Math.min(...units.map((u) => this.baseSpeed(u))) : null;
    for (let row = 0; row * width < ranked.length; row++) {
      // Within a row, units take the slots on the side they already stand on, so nobody crosses
      const members = ranked.slice(row * width, (row + 1) * width).sort((a, b) => (a.x * sx + a.y * sy) - (b.x * sx + b.y * sy));
      members.forEach((u, i) => {
        const across = (i - (members.length - 1) / 2) * FORMATION_SPACING;
        const back = row * FORMATION_SPACING;
        u.task = null;
        delete u.resumeTask;
        u.tx = clamp(x + sx * across - fx * back, 0, this.mapSize);
        u.ty = clamp(y + sy * across - fy * back, 0, this.mapSize);
        u.formationSpeed = slowest;
      });
    }
  }

  handleGather(playerId, { unitIds, resourceId }) {
    const resource = this.resources.get(resourceId);
    if (!resource) return;
    if (isSheep(resource) && resource.owner && resource.owner !== playerId) return this.error(playerId, 'Esa oveja es de otro jugador');
    // A tree deep inside a forest can't be reached yet: work on the closest exposed one instead
    const target = this.isExposed(resource) ? resource : this.closest(
      [...this.resources.values()].filter((r) => r.type === resource.type && this.isExposed(r)), resource.x, resource.y, RETARGET_RADIUS,
    ) ?? resource;
    for (const u of this.ownedVillagers(playerId, unitIds)) {
      u.task = { type: 'gather', resourceId: target.id, resourceType: target.type };
      delete u.resumeTask;
    }
  }

  // Place a new building: pays the cost and sends villagers to build it
  // An order from a client. With `queue` (Shift held, like in Age of Empires) units busy with
  // something keep it for when they finish (a move arrives, a resource runs out, a building is done,
  // a target dies); idle ones start right away. Without it, it replaces whatever they had queued.
  order(playerId, kind, o) {
    const handler = ORDER_HANDLERS[kind];
    if (!handler || this.status !== RoomStatus.PLAYING) return;
    const units = this.ownedUnits(playerId, o.unitIds);
    if (!o.queue) {
      for (const u of units) u.orders = [];
      this[handler](playerId, o);
      return;
    }
    const busy = units.filter((u) => u.task || u.orders?.length || Math.hypot(u.tx - u.x, u.ty - u.y) > 8);
    const free = units.filter((u) => !busy.includes(u)).map((u) => u.id);
    if (kind === 'build' || kind === 'wall') {
      // The foundations go down now; the busy villagers queue their construction
      const placed = this[handler](playerId, { ...o, unitIds: free, onlyThese: true });
      const first = Array.isArray(placed) ? placed[0] : placed;
      if (first) for (const u of busy) this.queueOrder(u, 'construct', { buildingId: first.id }, first);
      return;
    }
    if (free.length) this[handler](playerId, { ...o, unitIds: free });
    const at = kind === 'move' ? { x: o.x, y: o.y }
      : kind === 'gather' ? this.resources.get(o.resourceId)
      : this.entities.get(o.targetId ?? o.buildingId);
    for (const u of busy) this.queueOrder(u, kind, o, at);
  }

  // `at`: where the order leads, shown to the player as a waypoint
  queueOrder(u, kind, order, at) {
    (u.orders ??= []).push({ kind, order: { ...order, unitIds: [u.id], queue: false }, x: at?.x ?? u.x, y: at?.y ?? u.y });
  }

  // Starts the unit's next queued order; false when it has none
  nextOrder(u) {
    const next = u.orders?.shift();
    if (!next) return false;
    this[ORDER_HANDLERS[next.kind]](u.owner, next.order);
    return true;
  }

  handleBuild(playerId, { type, tx, ty, unitIds, onlyThese }) {
    const player = this.players.get(playerId);
    if (!player || this.status !== RoomStatus.PLAYING || !isBuildingType(type)) return;
    if (!Number.isInteger(tx) || !Number.isInteger(ty)) return;
    const { cost } = ENTITY_STATS[type];
    if (!this.hasAge(player, type)) return;
    if (!canAfford(player.stock, cost)) return this.error(playerId, 'Recursos insuficientes');
    // A gate can take the place of one of our own wall pieces (any of its tiles), right where it stood
    const wall = ENTITY_STATS[type].gate && footprint(type, tx, ty)
      .map(([x, y]) => this.entities.get(this.buildingTiles.get(tileKey(x, y))))
      .find((w) => w && w.owner === playerId && ENTITY_STATS[w.type].wall);
    if (wall) { ({ tx, ty } = wall); this.removeEntity(wall); }
    if (!canPlace(type, tx, ty, this.isTileBlocked, this.mapTiles)) return this.error(playerId, 'No se puede construir ahí');

    let builders = this.ownedVillagers(playerId, unitIds);
    if (!builders.length && !onlyThese) {
      // No villagers selected: pull the closest one off whatever it is doing
      const { x, y } = buildingCenter(type, tx, ty);
      const closest = this.closest([...this.entities.values()].filter(
        (e) => e.owner === playerId && e.type === EntityType.VILLAGER,
      ), x, y);
      if (!closest) return this.error(playerId, 'Necesitas un aldeano para construir');
      builders = [closest];
    }

    for (const [k, v] of Object.entries(cost)) player.stock[k] -= v;
    const building = this.addBuilding(type, playerId, tx, ty, false);
    for (const u of builders) this.assignBuild(u, building.id);
    return building;
  }

  // True when the player has reached the age a building or unit needs (tells them otherwise)
  hasAge(player, type) {
    const age = ENTITY_STATS[type].age ?? 1;
    if (player.age >= age) return true;
    this.error(player.id, `Requiere la ${AGES[age - 1].name}`);
    return false;
  }

  // A line of wall foundations from (tx0, ty0) to (tx1, ty1), straight or diagonal; tiles already
  // taken are skipped, and it stops when the stone runs out. Returns the foundations placed.
  handleWall(playerId, { tx0, ty0, tx1, ty1, unitIds, onlyThese }) {
    const player = this.players.get(playerId);
    if (!player || this.status !== RoomStatus.PLAYING) return [];
    if (![tx0, ty0, tx1, ty1].every(Number.isInteger) || !this.hasAge(player, EntityType.WALL)) return [];
    const { cost } = ENTITY_STATS[EntityType.WALL];
    const placed = [];
    for (const [x, y] of wallLine(tx0, ty0, tx1, ty1)) {
      if (!canPlace(EntityType.WALL, x, y, this.isTileBlocked, this.mapTiles)) continue;
      if (!canAfford(player.stock, cost)) { this.error(playerId, 'No alcanza la piedra para todo el muro'); break; }
      for (const [k, v] of Object.entries(cost)) player.stock[k] -= v;
      placed.push(this.addBuilding(EntityType.WALL, playerId, x, y, false));
    }
    if (!placed.length) return placed;
    let builders = this.ownedVillagers(playerId, unitIds);
    if (!builders.length && !onlyThese) {
      const closest = this.closest([...this.entities.values()].filter((e) => e.owner === playerId && e.type === EntityType.VILLAGER), placed[0].x, placed[0].y);
      builders = closest ? [closest] : [];
    }
    // Each builder starts on the closest piece; the rest are picked up as pieces get finished
    for (const u of builders) this.assignBuild(u, this.closest(placed, u.x, u.y).id);
    return placed;
  }

  // Advance to the next age at a town center: paid up front; the town center trains nothing meanwhile
  handleAgeUp(playerId, { buildingId }) {
    const player = this.players.get(playerId);
    const tc = this.entities.get(buildingId);
    if (!player || !tc || tc.owner !== playerId || tc.type !== EntityType.TOWN_CENTER || !tc.built) return;
    if (this.status !== RoomStatus.PLAYING) return;
    const next = AGES[player.age];
    if (!next) return this.error(playerId, 'Ya estás en la última edad');
    if ([...this.entities.values()].some((e) => e.owner === playerId && e.ageUp)) return this.error(playerId, 'Ya estás avanzando de edad');
    if (!canAfford(player.stock, next.cost)) return this.error(playerId, 'Recursos insuficientes');
    for (const [k, v] of Object.entries(next.cost)) player.stock[k] -= v;
    tc.ageUp = { to: player.age + 1, progress: 0 };
  }

  updateAgeUp(b) {
    if (!b.ageUp) return;
    b.ageUp.progress += DT / AGES[b.ageUp.to - 1].time;
    if (b.ageUp.progress < 1) return;
    const player = this.players.get(b.owner);
    const { to } = b.ageUp;
    b.ageUp = null;
    if (!player || player.age >= to) return;
    player.age = to;
    this.io.to(this.id).emit('game:ageup', { playerId: player.id, age: to });
    this.notice(`¡${player.name} avanzó a la ${AGES[to - 1].name}!`);
  }

  // A villager pulled off gathering/farming to build remembers that job and goes back to it
  // when there's nothing left to build (any other order forgets it)
  assignBuild(u, buildingId) {
    if (u.task?.type === 'gather' || u.task?.type === 'farm') u.resumeTask = u.task;
    else if (u.task?.type !== 'build') delete u.resumeTask;
    u.task = { type: 'build', buildingId };
  }

  // Send villagers to help finish an existing construction
  handleConstruct(playerId, { unitIds, buildingId }) {
    const building = this.entities.get(buildingId);
    if (!building || building.owner !== playerId || !isBuilding(building) || building.built) return;
    for (const u of this.ownedVillagers(playerId, unitIds)) this.assignBuild(u, buildingId);
  }

  // Assign villagers to harvest a finished farm
  handleFarm(playerId, { unitIds, buildingId }) {
    const farm = this.entities.get(buildingId);
    if (!farm || farm.owner !== playerId || !ENTITY_STATS[farm.type].farm || !farm.built) return;
    for (const u of this.ownedVillagers(playerId, unitIds)) { u.task = { type: 'farm', buildingId }; delete u.resumeTask; }
  }

  // Replant a harvested farm, paying wood
  handleReseed(playerId, { buildingId }) {
    const player = this.players.get(playerId);
    const farm = this.entities.get(buildingId);
    const stats = farm && ENTITY_STATS[farm.type].farm;
    if (!player || !stats || farm.owner !== playerId || !farm.built || this.status !== RoomStatus.PLAYING) return;
    if (farm.food > 0) return this.error(playerId, 'La siembra aún no se ha acabado');
    if (!this.reseed(farm)) this.error(playerId, 'Recursos insuficientes');
  }

  // Lumber camp research: the next gather upgrade, one at a time per player
  handleResearch(playerId, { buildingId }) {
    const player = this.players.get(playerId);
    const camp = this.entities.get(buildingId);
    if (!player || !camp || camp.owner !== playerId || !camp.built || !ENTITY_STATS[camp.type].dropOff) return;
    if (this.status !== RoomStatus.PLAYING) return;
    const researching = [...this.entities.values()].some((e) => e.owner === playerId && e.research);
    if (researching) return this.error(playerId, 'Ya hay una mejora en investigación');
    const upgrade = GATHER_UPGRADES[player.gatherLevel];
    if (!upgrade) return this.error(playerId, 'Ya investigaste todas las mejoras');
    if (!canAfford(player.stock, upgrade.cost)) return this.error(playerId, 'Recursos insuficientes');
    for (const [k, v] of Object.entries(upgrade.cost)) player.stock[k] -= v;
    camp.research = { level: player.gatherLevel, progress: 0 };
  }

  updateResearch(b) {
    if (!b.research) return;
    const upgrade = GATHER_UPGRADES[b.research.level];
    b.research.progress += DT / upgrade.time;
    if (b.research.progress < 1) return;
    b.research = null;
    const player = this.players.get(b.owner);
    if (!player) return;
    player.gatherLevel = Math.max(player.gatherLevel, GATHER_UPGRADES.indexOf(upgrade) + 1);
    this.io.to(player.id).emit('game:notice', { message: `Mejora completada: ${upgrade.name}` });
  }

  gatherRate(u, type) {
    const level = this.players.get(u.owner)?.gatherLevel ?? 0;
    return RESOURCE_STATS[type].gatherRate * (level ? GATHER_UPGRADES[level - 1].bonus : 1);
  }

  // Replants a harvested farm if its owner can pay for it; returns whether it was replanted
  reseed(farm) {
    const player = this.players.get(farm.owner);
    const stats = ENTITY_STATS[farm.type].farm;
    if (!player || !canAfford(player.stock, stats.reseedCost)) return false;
    for (const [k, v] of Object.entries(stats.reseedCost)) player.stock[k] -= v;
    farm.food = stats.food;
    return true;
  }

  // Attack an enemy entity. Villagers ordered onto a fallen central town center capture it instead.
  handleAttack(playerId, { unitIds, targetId }) {
    const target = this.entities.get(targetId);
    if (!target) return;
    for (const u of this.ownedUnits(playerId, unitIds)) {
      if (!ENTITY_STATS[u.type].attack) continue; // monks
      if (target.central && target.hp <= 0) {
        delete u.resumeTask;
        if (u.type === EntityType.VILLAGER) u.task = { type: 'capture', buildingId: target.id };
      } else if (!this.allied(target.owner, playerId)) {
        u.task = { type: 'attack', targetId: target.id };
      }
    }
  }

  // Queue a unit in a finished building, paying its cost up front; `type` picks one of the units the
  // building trains (the first by default)
  handleTrain(playerId, { buildingId, type }) {
    const player = this.players.get(playerId);
    const building = this.entities.get(buildingId);
    if (!player || !building || building.owner !== playerId || !isBuilding(building) || !building.built) return;
    const trains = ENTITY_STATS[building.type].trains ?? [];
    const unitType = type ?? trains[0];
    if (!trains.includes(unitType) || !this.hasAge(player, unitType)) return;
    if (building.ageUp) return this.error(playerId, 'El centro urbano está avanzando de edad');
    if (building.queue.length >= MAX_TRAIN_QUEUE) return this.error(playerId, 'La cola está llena');
    const { cost } = ENTITY_STATS[unitType];
    this.updatePopulation(player);
    if (player.pop >= player.popCap) {
      return this.error(playerId, player.popCap >= MAX_POPULATION ? 'Límite de población alcanzado' : 'Necesitas más casas');
    }
    if (!canAfford(player.stock, cost)) return this.error(playerId, 'Recursos insuficientes');
    for (const [k, v] of Object.entries(cost)) player.stock[k] -= v;
    building.queue.push(unitType);
  }

  handleChat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player || typeof text !== 'string' || !text.trim()) return;
    this.io.to(this.id).emit('chat', { from: player.name, color: player.color, text: text.trim().slice(0, 200) });
  }

  error(playerId, message) { this.io.to(playerId).emit('game:error', { message }); }

  notice(message) { this.io.to(this.id).emit('game:notice', { message }); }

  // ---- Simulation ----

  closest(list, x, y, maxDistance = Infinity) {
    let best = null;
    let bestDist = maxDistance;
    for (const e of list) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  // A resource with at least one walkable side can be gathered
  isExposed(r) {
    if (!isSolidResource(r)) return true;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const x = r.tx + dx;
      const y = r.ty + dy;
      return x >= 0 && y >= 0 && x < this.mapTiles && y < this.mapTiles && !this.walkBlocked[y * this.mapTiles + x];
    });
  }

  // Moves toward (x, y), around trees and water; returns true once within stopDistance.
  // Sets u.unreachable when the destination can't be reached and the unit got as close as it can.
  moveToward(u, x, y, stopDistance = 0) {
    const dist = Math.hypot(x - u.x, y - u.y);
    u.unreachable = false;
    if (dist <= stopDistance) { u.path = null; return true; }
    u.action = 'moving';
    const r = bodyOf(u).radius * TERRAIN_RADIUS;
    const gx = clamp(Math.floor(x / TILE_SIZE), 0, this.mapTiles - 1);
    const gy = clamp(Math.floor(y / TILE_SIZE), 0, this.mapTiles - 1);
    const goal = gy * this.mapTiles + gx;
    // Walking up to a tree or mine: its own tile doesn't count as an obstacle
    const ignore = stopDistance > 0 && this.resourceTiles.has(tileKey(gx, gy)) ? goal : -1;

    // Straight line when nothing is in the way, otherwise follow an A* path (recomputed when the goal tile changes)
    let wp = { x, y };
    const grid = this.gridFor(u.owner);
    if (!clearLine(grid, u.x, u.y, x, y, r, ignore)) {
      if (!u.path || u.path.goal !== goal || u.path.version !== this.gridVersion
        || (!u.path.points.length && this.tickCount - u.path.tick >= REPATH_TICKS)) {
        const sx = clamp(Math.floor(u.x / TILE_SIZE), 0, this.mapTiles - 1);
        const sy = clamp(Math.floor(u.y / TILE_SIZE), 0, this.mapTiles - 1);
        u.path = { goal, tick: this.tickCount, version: this.gridVersion, ...findPath(grid, sx, sy, gx, gy, ignore === goal) };
      }
      const pts = u.path.points;
      // Drop reached waypoints, and skip ahead whenever the next one is already in plain sight
      while (pts.length && Math.hypot(pts[0].x - u.x, pts[0].y - u.y) < 4) pts.shift();
      while (pts.length > 1 && clearLine(grid, u.x, u.y, pts[1].x, pts[1].y, r, ignore)) pts.shift();
      if (!pts.length) {
        if (u.path.partial) { u.unreachable = true; u.action = 'idle'; return false; }
      } else if (pts.length > 1 || u.path.partial) wp = pts[0];
    }

    const step = this.speedOf(u) * DT;
    const final = wp.x === x && wp.y === y;
    const dx = wp.x - u.x;
    const dy = wp.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const remaining = final ? dist - stopDistance : d;
    const k = Math.min(step, remaining) / d;
    u.x += dx * k;
    u.y += dy * k;
    return final && remaining <= step;
  }

  // Walks up to a building: around obstacles to the free tile beside its footprint closest to the
  // unit. True once the body is within `extra` px of its walls (corners included)
  moveToBuilding(u, b, extra = ARRIVE_MARGIN) {
    const reached = () => this.wallDistance(u, b) <= bodyOf(u).radius + extra;
    if (reached()) { u.path = null; return true; }
    const p = this.approachPoint(u, b);
    this.moveToward(u, p.x, p.y, 0);
    return reached();
  }

  // Distance from a point to a building's footprint (plus model overhang); 0 inside it
  wallDistance(u, b) {
    const half = this.bodyRadius(b);
    return Math.hypot(Math.max(0, Math.abs(u.x - b.x) - half), Math.max(0, Math.abs(u.y - b.y) - half));
  }

  // Middle of a walkable tile in the ring around a building's footprint: the closest to the unit,
  // preferring the sides to the corners and tiles no other unit is standing on
  approachPoint(u, b) {
    const n = ENTITY_STATS[b.type].tiles;
    const taken = new Set();
    for (const e of this.entities.values()) {
      if (e === u || !isUnit(e) || Math.abs(e.x - b.x) > (n + 2) * TILE_SIZE || Math.abs(e.y - b.y) > (n + 2) * TILE_SIZE) continue;
      taken.add(tileKey(Math.floor(e.x / TILE_SIZE), Math.floor(e.y / TILE_SIZE)));
    }
    let best = null;
    let bestD = Infinity;
    for (let y = b.ty - 1; y <= b.ty + n; y++) {
      for (let x = b.tx - 1; x <= b.tx + n; x++) {
        if (x >= b.tx && x < b.tx + n && y >= b.ty && y < b.ty + n) continue;
        if (x < 0 || y < 0 || x >= this.mapTiles || y >= this.mapTiles || this.gridFor(u.owner)[y * this.mapTiles + x]) continue;
        const cx = (x + 0.5) * TILE_SIZE;
        const cy = (y + 0.5) * TILE_SIZE;
        const corner = (x === b.tx - 1 || x === b.tx + n) && (y === b.ty - 1 || y === b.ty + n);
        const d = Math.hypot(cx - u.x, cy - u.y) + (corner ? TILE_SIZE : 0) + (taken.has(tileKey(x, y)) ? TILE_SIZE * 1.5 : 0);
        if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
      }
    }
    return best ?? { x: b.x, y: b.y };
  }

  // Walking speed: the unit's civilization may change it, ice slows it
  baseSpeed(u) { return unitStats(u.type, this.civOf(u)).speed; }

  speedOf(u) {
    if (isSheep(u)) return SHEEP.speed;
    let speed = this.baseSpeed(u);
    // Marching in formation: no faster than the group's slowest (only on a plain move order)
    if (u.formationSpeed && !u.task) speed = Math.min(speed, u.formationSpeed);
    return speed * (u.chill ? u.chill.factor : 1);
  }

  // Pushes overlapping units apart so they never stack on top of each other
  separateUnits() {
    const units = [...this.entities.values()].filter(isUnit);
    const pushed = new Set();
    for (let iter = 0; iter < SEPARATION_ITERATIONS; iter++) {
      const grid = new Map();
      for (const u of units) {
        const key = tileKey(Math.floor(u.x / SEPARATION_CELL), Math.floor(u.y / SEPARATION_CELL));
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(u);
      }
      let moved = false;
      for (const a of units) {
        const cx = Math.floor(a.x / SEPARATION_CELL);
        const cy = Math.floor(a.y / SEPARATION_CELL);
        const ra = ENTITY_STATS[a.type].radius + COLLISION_PADDING;
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          for (const b of grid.get(tileKey(cx + ox, cy + oy)) ?? []) {
            if (b.id <= a.id) continue; // each pair once
            const minDist = ra + ENTITY_STATS[b.type].radius + COLLISION_PADDING;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            if (dist >= minDist) continue;
            if (dist < 0.001) { // exactly stacked: pick a deterministic direction
              const angle = (a.id * 2.399963) % (Math.PI * 2);
              dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
            }
            const half = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x = clamp(a.x - nx * half, 0, this.mapSize);
            a.y = clamp(a.y - ny * half, 0, this.mapSize);
            b.x = clamp(b.x + nx * half, 0, this.mapSize);
            b.y = clamp(b.y + ny * half, 0, this.mapSize);
            pushed.add(a); pushed.add(b);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    this.solidBuildings = [...this.entities.values()].filter((e) => isBuilding(e) && !ENTITY_STATS[e.type].farm);
    for (const u of units) { this.pushOutOfBuildings(u); this.pushOutOfTerrain(u); }
    // A unit with a plain move order that got shoved near its destination settles where it is,
    // otherwise idle units would keep walking back into each other forever
    for (const u of pushed) {
      if (u.task) continue;
      if (Math.hypot(u.tx - u.x, u.ty - u.y) <= ENTITY_STATS[u.type].radius * 3) { u.tx = u.x; u.ty = u.y; }
    }
  }

  // Buildings (except farms, whose fields are worked on foot) are solid: a body inside one's footprint
  // (plus the little the 3D model overhangs it) is pushed back to the wall and slid along it the way it
  // was walking, so whoever walks into a building goes around it instead of through. It stays just
  // within reach of the building (bodyRadius) for delivering, building and attacking.
  pushOutOfBuildings(u) {
    const r = bodyOf(u).radius;
    const mx = u.x - (u.prevX ?? u.x);
    const my = u.y - (u.prevY ?? u.y);
    for (const b of this.solidBuildings ?? []) {
      if (ENTITY_STATS[b.type].gate && b.owner === u.owner) continue; // our own gates let us through
      const half = this.bodyRadius(b) + r - 3;
      const dx = u.x - b.x;
      const dy = u.y - b.y;
      if (Math.abs(dx) >= half || Math.abs(dy) >= half) continue;
      const px = half - Math.abs(dx);
      const py = half - Math.abs(dy);
      // Along the wall: the way it was heading when it walks along it, otherwise round the nearer
      // corner; kept while it stays against the same wall so it doesn't dither
      const along = (key, tangent, normal, offset) => {
        if (u.slide?.key === key && this.tickCount - u.slide.tick <= 3) u.slide.tick = this.tickCount;
        else u.slide = {
          key, tick: this.tickCount,
          dir: Math.abs(tangent) > Math.abs(normal) * 0.6 ? Math.sign(tangent) : Math.sign(offset) || (u.id % 2 ? 1 : -1),
        };
        return u.slide.dir;
      };
      if (px < py) {
        u.x = b.x + (Math.sign(dx) || 1) * half;
        u.y += along(`${b.id}x${Math.sign(dx)}`, my, mx, dy) * Math.min(py, px + 2);
      } else {
        u.y = b.y + (Math.sign(dy) || 1) * half;
        u.x += along(`${b.id}y${Math.sign(dy)}`, mx, my, dx) * Math.min(px, py + 2);
      }
      u.x = clamp(u.x, 0, this.mapSize);
      u.y = clamp(u.y, 0, this.mapSize);
    }
  }

  // Keeps a unit's (or sheep's) body out of trees, gold mines and water
  pushOutOfTerrain(u) {
    const r = bodyOf(u).radius * TERRAIN_RADIUS;
    const cx = Math.floor(u.x / TILE_SIZE);
    const cy = Math.floor(u.y / TILE_SIZE);
    const grid = this.gridFor(u.owner);
    for (let ty = cy - 1; ty <= cy + 1; ty++) {
      for (let tx = cx - 1; tx <= cx + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= this.mapTiles || ty >= this.mapTiles || !grid[ty * this.mapTiles + tx]) continue;
        const x0 = tx * TILE_SIZE;
        const y0 = ty * TILE_SIZE;
        const nx = clamp(u.x, x0, x0 + TILE_SIZE);
        const ny = clamp(u.y, y0, y0 + TILE_SIZE);
        const dx = u.x - nx;
        const dy = u.y - ny;
        const d = Math.hypot(dx, dy);
        if (d >= r) continue;
        if (d > 0) {
          u.x = nx + (dx / d) * r;
          u.y = ny + (dy / d) * r;
        } else {
          // Centre inside the tile: leave through the closest edge
          const exits = [[u.x - x0, -1, 0], [x0 + TILE_SIZE - u.x, 1, 0], [u.y - y0, 0, -1], [y0 + TILE_SIZE - u.y, 0, 1]];
          const [depth, ex, ey] = exits.sort((a, b) => a[0] - b[0])[0];
          u.x += ex * (depth + r);
          u.y += ey * (depth + r);
        }
      }
    }
  }

  updateGatherer(u) {
    const { task, carry } = u;
    const stats = ENTITY_STATS[u.type];
    let resource = this.resources.get(task.resourceId);

    // Resource gone with more orders queued: drop off what it carries, then on to the next one
    if (!resource && u.orders?.length) {
      if (carry.amount > 0) { this.deliverCarry(u); if (carry.amount > 0 && u.task) return; }
      this.nextOrder(u);
      return;
    }

    // Resource gone: look for another of the same type nearby
    if (!resource) {
      const sameType = [...this.resources.values()].filter((r) => r.type === task.resourceType && this.isExposed(r)
        && (!isSheep(r) || r.owner === u.owner));
      resource = this.closest(sameType, u.x, u.y, RETARGET_RADIUS);
      if (resource) task.resourceId = resource.id;
    }

    // Full, or nothing left to gather: carry it back to the closest finished town center
    if (carry.amount >= stats.carryCapacity || (!resource && carry.amount > 0)) {
      task.trackedId = null; // the walk back to the resource is tracked from scratch
      this.deliverCarry(u);
      return;
    }

    if (!resource) { u.task = null; return; }
    if (isSheep(resource) && resource.owner !== u.owner) {
      // Someone else's sheep (or not yet ours): walk up to it, which claims it if nobody else is closer
      if (resource.owner) { u.task = null; return; }
    }
    // Once working it, being nudged a little by the gatherers around it doesn't stop the work
    const reach = (isSheep(resource) ? SHEEP.radius + stats.radius + 10 : TILE_SIZE / 2 + stats.radius + 6)
      + (task.workingOn === resource.id ? WORKING_SLACK : 0);
    if (this.gathererStuck(u, resource, reach)) {
      const other = this.alternativeResource(u, resource);
      if (other) {
        task.resourceId = other.id;
        return;
      }
    }
    if (!this.moveToward(u, resource.x, resource.y, reach)) return;

    u.action = 'gathering';
    task.workingOn = resource.id;
    // Switching resource type drops what was being carried, like in AoE
    if (carry.type !== resource.type) {
      carry.type = resource.type;
      carry.amount = 0;
      u.gatherProgress = 0;
    }
    u.gatherProgress += this.gatherRate(u, resource.type) * DT;
    while (u.gatherProgress >= 1 && resource.amount > 0 && carry.amount < stats.carryCapacity) {
      u.gatherProgress -= 1;
      resource.amount -= 1;
      carry.amount += 1;
    }
    this.resourceChanges.set(resource.id, resource.amount);
    if (resource.amount <= 0) {
      this.resources.delete(resource.id);
      this.resourceTiles.delete(tileKey(resource.tx, resource.ty));
      if (isSolidResource(resource)) this.setCell(resource.ty * this.mapTiles + resource.tx, 0);
    }
  }

  // Finished town centers and lumber camps of a player
  dropOffsOf(owner) {
    return [...this.entities.values()].filter((e) => e.owner === owner && e.built
      && (e.type === EntityType.TOWN_CENTER || ENTITY_STATS[e.type].dropOff));
  }

  // True when a gatherer walking to its resource hasn't got any closer for STUCK_TICKS (other villagers
  // in the way, or no path)
  // A gatherer that can't get to its resource: its path is impossible, or it has barely moved for a
  // while (crowded out by other gatherers). Walking a detour around a building or a forest still
  // counts as progress, even when it takes it away from the resource for a bit.
  gathererStuck(u, resource, reach) {
    const { task } = u;
    const dist = Math.hypot(resource.x - u.x, resource.y - u.y);
    // (+1: moveToward stops right on the edge of the reach, a hair outside it in floating point)
    if (task.trackedId !== resource.id || dist <= reach + 1) {
      task.trackedId = resource.id;
      task.anchor = { x: u.x, y: u.y };
      task.stuckTicks = 0;
      return false;
    }
    if (u.unreachable) return true;
    if (++task.stuckTicks < STUCK_TICKS) return false;
    const moved = Math.hypot(u.x - task.anchor.x, u.y - task.anchor.y);
    task.anchor = { x: u.x, y: u.y };
    task.stuckTicks = 0;
    return moved < 12;
  }

  // Another reachable resource of the same type nearby, preferring ones fewer villagers are working on
  alternativeResource(u, current) {
    const workers = new Map();
    for (const e of this.entities.values()) {
      if (e.task?.type === 'gather') workers.set(e.task.resourceId, (workers.get(e.task.resourceId) ?? 0) + 1);
    }
    let best = null;
    let bestScore = Infinity;
    for (const r of this.resources.values()) {
      if (r.id === current.id || r.type !== current.type) continue;
      if (!this.isExposed(r) || (isSheep(r) && r.owner !== u.owner)) continue;
      const d = Math.hypot(r.x - u.x, r.y - u.y);
      if (d > RETARGET_RADIUS) continue;
      const score = d + (workers.get(r.id) ?? 0) * CROWD_PENALTY;
      if (score < bestScore) { best = r; bestScore = score; }
    }
    return best;
  }

  // Walks the villager's load to the closest drop-off and adds it to the stock
  deliverCarry(u) {
    const dropOff = this.closest(this.dropOffsOf(u.owner), u.x, u.y);
    if (!dropOff) { u.task = null; return; }
    if (!this.moveToBuilding(u, dropOff)) return;
    const player = this.players.get(u.owner);
    if (player) {
      player.stock[u.carry.type] += u.carry.amount;
      player.stats.gathered += u.carry.amount;
    }
    u.carry.amount = 0;
  }

  // Farmers harvest the crop fields around the farm. When the crops run out the farm replants itself
  // if its owner has the wood; otherwise farmers drop off what they carry and wait until it is reseeded
  updateFarmer(u) {
    const farm = this.entities.get(u.task.buildingId);
    const { carry } = u;
    const stats = ENTITY_STATS[u.type];
    if (farm && farm.owner === u.owner && farm.food <= 0) this.reseed(farm);
    if (!farm || farm.owner !== u.owner) {
      if (carry.amount > 0 && carry.type === 'food') this.deliverCarry(u);
      else u.task = null;
      return;
    }
    if (carry.amount >= stats.carryCapacity || (farm.food <= 0 && carry.amount > 0 && carry.type === 'food')) {
      this.deliverCarry(u);
      return;
    }
    // Work on the fields: anywhere within a tile of the farmhouse
    if (!this.moveToward(u, farm.x, farm.y, TILE_SIZE)) return;
    if (farm.food <= 0) return;

    u.action = 'gathering';
    if (carry.type !== 'food') {
      carry.type = 'food';
      carry.amount = 0;
      u.gatherProgress = 0;
    }
    u.gatherProgress += this.gatherRate(u, 'food') * DT;
    while (u.gatherProgress >= 1 && farm.food > 0 && carry.amount < stats.carryCapacity) {
      u.gatherProgress -= 1;
      farm.food -= 1;
      carry.amount += 1;
    }
  }

  // Each villager working on a building adds its own build speed, so more villagers = faster
  updateBuilder(u) {
    const building = this.entities.get(u.task.buildingId);
    if (!building || building.built) {
      if (this.nextOrder(u)) return;
      // Finished a farm: start working it. Otherwise move on to the closest pending construction.
      if (building?.built && ENTITY_STATS[building.type].farm) { u.task = { type: 'farm', buildingId: building.id }; return; }
      const pending = [...this.entities.values()].filter((e) => isBuilding(e) && e.owner === u.owner && !e.built);
      const next = this.closest(pending, u.x, u.y, NEXT_CONSTRUCTION_RADIUS);
      if (next) u.task = { type: 'build', buildingId: next.id };
      else if (u.resumeTask) { u.task = u.resumeTask; delete u.resumeTask; }
      else { u.task = null; u.tx = u.x; u.ty = u.y; }
      return;
    }
    if (!this.moveToBuilding(u, building)) return;

    u.action = 'building';
    const stats = ENTITY_STATS[building.type];
    building.buildProgress = Math.min(1, building.buildProgress + DT / stats.buildTime);
    building.hp = Math.max(1, Math.round(stats.hp * building.buildProgress));
    if (building.buildProgress >= 1) {
      building.built = true;
      building.hp = stats.hp;
      if (stats.farm) building.food = stats.farm.food;
    }
  }

  // Distance from an entity's centre to its edge
  // How far a body reaches from its middle; buildings count the little their 3D model overhangs
  bodyRadius(e) { return isBuilding(e) ? (buildingSize(e.type) / 2) * BUILDING_OVERHANG : ENTITY_STATS[e.type].radius; }

  updateAttacker(u) {
    const target = this.entities.get(u.task.targetId);
    if (!target || this.allied(target.owner, u.owner) || (target.central && target.hp <= 0)) {
      if (this.nextOrder(u)) return;
      // Soldiers stay where the fight left them (not back to where they were sent from) and carry on
      // with the next enemy nearby, units first, then buildings
      u.task = null;
      u.tx = u.x;
      u.ty = u.y;
      if (!u.post) this.huntNext(u);
      return;
    }
    const { attack } = unitStats(u.type, this.civOf(u));
    // Going into a fight: soldiers first stop to shout and wave their banner, then charge
    if (!u.task.engaged) {
      u.task.engaged = true;
      const soldier = u.type !== EntityType.VILLAGER && u.type !== EntityType.MONK && u.type !== EntityType.GUARD;
      const far = Math.hypot(target.x - u.x, target.y - u.y) > attack.range + this.bodyRadius(target) + 60;
      if (soldier && far && this.tickCount - (u.lastCheer ?? -Infinity) > CHEER_COOLDOWN) {
        u.cheer = CHEER_TIME;
        u.lastCheer = this.tickCount;
      }
    }
    if (u.cheer > 0) { u.cheer -= DT; u.action = 'cheering'; return; }
    if (isBuilding(target)) {
      if (!this.moveToBuilding(u, target, attack.range + 4)) return;
    } else {
      // Bodies are kept apart by their radii plus padding: melee reaches a little past that gap
      const reach = attack.range + ENTITY_STATS[u.type].radius + this.bodyRadius(target) + COLLISION_PADDING * 2 + 4;
      if (!this.moveToward(u, target.x, target.y, reach)) return;
    }

    u.action = 'attacking';
    if (u.cooldown > 0) return;
    u.cooldown = attack.cooldown;
    if (attack.line) { this.lineStrike(u, target, attack); return; }
    if (attack.range > 0 && !attack.area) {
      const kind = attack.burn ? 'fireball' : attack.chill ? 'ice' : u.type;
      this.shots.push({
        x: u.x, y: u.y, targetId: target.id, kind, attackerId: u.id,
      });
    }
    if (attack.area) { this.areaBlast(u, target, attack); return; }
    this.afflict(target, attack, u.owner);
    this.damage(target, attack.damage * this.damageFactor(attack, target), u.owner);
  }

  // Bonus against some unit types (spears against the fast units); shields stop part of what is shot
  damageFactor(attack, target) {
    const shield = attack.range > 0 ? ENTITY_STATS[target.type]?.shield ?? 1 : 1;
    return (attack.bonus?.[target.type] ?? 1) * shield;
  }

  // Lasting effects of a hit: fire keeps burning, ice slows units down
  afflict(e, attack, owner) {
    if (attack.burn) e.burn = { ...attack.burn, time: attack.burn.duration, owner, acc: 0 };
    if (attack.chill && isUnit(e)) e.chill = { factor: attack.chill.factor, time: attack.chill.duration };
  }

  // Geomancy: rock spikes erupt in a line from the attacker through the target, hitting every
  // enemy unit on it. Buildings get a boulder thrown at them instead, for extra damage
  lineStrike(u, target, attack) {
    if (isBuilding(target)) {
      this.shots.push({ x: u.x, y: u.y, targetId: target.id, kind: 'rock', attackerId: u.id });
      this.damage(target, attack.damage * (attack.vsBuildings ?? 1), u.owner);
      return;
    }
    const dx = target.x - u.x;
    const dy = target.y - u.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const length = dist + 30;
    const half = attack.line.width / 2;
    this.shots.push({
      x: u.x, y: u.y, tx: u.x + ux * length, ty: u.y + uy * length, targetId: target.id, kind: 'earthLine', attackerId: u.id,
    });
    const hit = new Set([target]);
    for (const e of this.entities.values()) {
      if (!isUnit(e) || !e.owner || this.allied(e.owner, u.owner)) continue;
      const along = (e.x - u.x) * ux + (e.y - u.y) * uy;
      const across = Math.abs((e.x - u.x) * uy - (e.y - u.y) * ux);
      if (along > 0 && along <= length && across <= half + ENTITY_STATS[e.type].radius) hit.add(e);
    }
    for (const e of hit) this.damage(e, e === target ? attack.damage : attack.damage * (attack.line.splash ?? 1), u.owner);
  }

  // Gust around the attacker: damages the target plus every enemy unit within `area`, stuns them and
  // knocks them back (their `knock` velocity is applied and decays in applyKnockback)
  areaBlast(u, target, attack) {
    this.shots.push({
      x: u.x, y: u.y, targetId: target.id, kind: 'blast', radius: attack.area, attackerId: u.id, fire: !!attack.burn,
      element: this.civOf(u) ?? 'air',
    });
    const hit = new Set([target]);
    for (const e of this.entities.values()) {
      if (!isUnit(e) || !e.owner || this.allied(e.owner, u.owner)) continue;
      if (Math.hypot(e.x - u.x, e.y - u.y) <= attack.area + ENTITY_STATS[e.type].radius) hit.add(e);
    }
    for (const e of hit) {
      if (isUnit(e)) {
        const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
        e.knock = { vx: ((e.x - u.x) / d) * attack.knockback, vy: ((e.y - u.y) / d) * attack.knockback };
        if (attack.stun) e.stun = Math.max(e.stun ?? 0, attack.stun);
      }
      this.afflict(e, attack, u.owner);
      this.damage(e, attack.damage, u.owner);
    }
  }

  // Burning entities take damage every tick until the fire goes out
  applyBurns() {
    for (const e of [...this.entities.values()]) {
      if (!e.burn) continue;
      e.burn.time -= DT;
      e.burn.acc += e.burn.dps * DT;
      const whole = Math.floor(e.burn.acc);
      if (whole > 0) { e.burn.acc -= whole; this.damage(e, whole, e.burn.owner); }
      if (e.burn && e.burn.time <= 0) delete e.burn;
    }
    // Ice wears off
    for (const e of this.entities.values()) {
      if (!e.chill) continue;
      e.chill.time -= DT;
      if (e.chill.time <= 0) delete e.chill;
    }
  }

  applyKnockback() {
    for (const e of this.entities.values()) {
      if (!e.knock) continue;
      e.x = clamp(e.x + e.knock.vx * DT, 0, this.mapSize);
      e.y = clamp(e.y + e.knock.vy * DT, 0, this.mapSize);
      e.knock.vx *= 0.8;
      e.knock.vy *= 0.8;
      if (Math.hypot(e.knock.vx, e.knock.vy) < 10) delete e.knock;
    }
  }

  // Finished towers and town centers shoot the closest enemy unit in range, sticking to a target while it stays in range
  updateTower(b) {
    const { attack } = ENTITY_STATS[b.type];
    if (!attack || !b.built || (!b.owner && !b.central) || b.hp <= 0) return;
    b.cooldown = Math.max(0, b.cooldown - DT);
    const inRange = (e) => e && isUnit(e) && !this.allied(e.owner, b.owner)
      && Math.hypot(e.x - b.x, e.y - b.y) <= attack.range + ENTITY_STATS[e.type].radius;

    let target = this.entities.get(b.targetId);
    if (!inRange(target)) {
      const enemies = [...this.entities.values()].filter(inRange);
      target = this.closest(enemies, b.x, b.y);
      b.targetId = target?.id ?? null;
    }
    if (!target || b.cooldown > 0) return;
    b.cooldown = attack.cooldown;
    this.shots.push({ x: b.x, y: b.y - buildingSize(b.type) / 2, targetId: target.id });
    this.damage(target, attack.damage * this.damageFactor(attack, target), b.owner);
  }

  damage(target, amount, attackerOwner) {
    target.hp -= amount;
    if (target.hp > 0) return;
    if (isUnit(target)) {
      const victim = this.players.get(target.owner);
      if (victim) victim.stats.lost++;
      const killer = this.players.get(attackerOwner);
      if (killer) killer.stats.kills++;
    }
    if (target.central) {
      // The central town center can't be destroyed: it falls and waits for a villager to claim it
      target.hp = 0;
      if (target.owner) this.loseCentral();
      return;
    }
    this.removeEntity(target);
  }

  loseCentral() {
    const c = this.central;
    const previous = this.players.get(c.owner);
    c.owner = null;
    c.hp = 0;
    c.controlTime = 0;
    c.queue = [];
    c.trainProgress = 0;
    if (previous) this.notice(`¡${previous.name} perdió el Centro urbano central!`);
  }

  // A villager walks into the fallen central town center and claims it (the villager is used up)
  updateCapturer(u) {
    const c = this.entities.get(u.task.buildingId);
    if (!c?.central || c.hp > 0) { u.task = null; return; }
    if (!this.moveToBuilding(u, c)) return;
    c.owner = u.owner;
    c.hp = c.maxHp;
    c.controlTime = 0;
    this.removeEntity(u);
    this.notice(`¡${this.players.get(u.owner)?.name} capturó el Centro urbano central!`);
  }

  // Idle soldiers attack the closest enemy unit in range
  autoAcquire(u) {
    const { aggroRange } = ENTITY_STATS[u.type];
    if (!aggroRange) return;
    const enemies = [...this.entities.values()].filter((e) => isUnit(e) && !this.allied(e.owner, u.owner)
      && (!u.post || Math.hypot(e.x - u.post.x, e.y - u.post.y) <= GUARD_LEASH));
    const target = this.closest(enemies, u.x, u.y, aggroRange);
    if (target) u.task = { type: 'attack', targetId: target.id };
  }

  // After a kill: the closest enemy unit, or else enemy building (not the neutral central castle),
  // within a little more than the soldier's aggro range
  huntNext(u) {
    const { aggroRange } = ENTITY_STATS[u.type];
    if (!aggroRange) return;
    const range = aggroRange * 1.5;
    const enemies = [...this.entities.values()].filter((e) => e.owner && !this.allied(e.owner, u.owner) && e.hp > 0);
    const target = this.closest(enemies.filter(isUnit), u.x, u.y, range)
      ?? this.closest(enemies.filter(isBuilding), u.x, u.y, range + 80);
    if (target) u.task = { type: 'attack', targetId: target.id, engaged: true };
  }

  // Guards give up a chase that leads too far from their post and walk back
  leashGuard(u) {
    const target = u.task?.type === 'attack' && this.entities.get(u.task.targetId);
    if (target && Math.hypot(target.x - u.post.x, target.y - u.post.y) <= GUARD_LEASH) return;
    u.task = null;
    u.tx = u.post.x;
    u.ty = u.post.y;
  }

  // Idle monks look for the most hurt friendly unit nearby
  autoHeal(u) {
    const { heal } = ENTITY_STATS[u.type];
    const hurt = [...this.entities.values()].filter((e) => isUnit(e) && e.owner === u.owner && e.id !== u.id
      && e.hp < ENTITY_STATS[e.type].hp && Math.hypot(e.x - u.x, e.y - u.y) <= heal.searchRange);
    const target = this.closest(hurt, u.x, u.y);
    if (target) u.task = { type: 'heal', targetId: target.id };
  }

  updateHealer(u) {
    const { heal } = ENTITY_STATS[u.type];
    const target = this.entities.get(u.task.targetId);
    if (!target || target.owner !== u.owner || target.hp >= ENTITY_STATS[target.type].hp) {
      u.task = null;
      u.tx = u.x;
      u.ty = u.y;
      return;
    }
    if (!this.moveToward(u, target.x, target.y, heal.range)) return;
    u.action = 'healing';
    if (u.cooldown > 0) return;
    u.cooldown = heal.cooldown;
    target.hp = Math.min(ENTITY_STATS[target.type].hp, target.hp + heal.amount);
  }

  // Sheep follow whoever reaches them first and walk to that player's closest drop-off, where they wait
  // to be butchered. An unattended sheep can be stolen by an enemy unit.
  updateSheep() {
    const check = this.tickCount % SHEEP_CHECK_TICKS === 0;
    const units = check ? [...this.entities.values()].filter((e) => isUnit(e) && e.owner) : [];
    for (const s of this.resources.values()) {
      if (!isSheep(s)) continue;
      if (check) {
        const near = units.filter((e) => Math.hypot(e.x - s.x, e.y - s.y) <= SHEEP.captureRange);
        if (!near.some((e) => e.owner === s.owner)) {
          const claimer = this.closest(near, s.x, s.y);
          if (claimer) s.owner = claimer.owner;
        }
      }
      if (!s.owner || s.amount < s.max) continue; // wild, or already being butchered
      const home = this.closest(this.dropOffsOf(s.owner), s.x, s.y);
      if (!home) continue;
      // Each sheep has its own spot around the drop-off, clear of its walls, so the flock spreads out
      const angle = s.id * 2.399963;
      const d = this.outside(home, angle, SHEEP.radius) + SHEEP.idleDistance;
      this.moveToward(s, home.x + Math.cos(angle) * d, home.y + Math.sin(angle) * d, 6);
      this.pushOutOfBuildings(s);
      this.pushOutOfTerrain(s);
      s.tx = clamp(Math.floor(s.x / TILE_SIZE), 0, this.mapTiles - 1);
      s.ty = clamp(Math.floor(s.y / TILE_SIZE), 0, this.mapTiles - 1);
    }
  }

  updateProduction(b) {
    if (!b.built || !b.queue.length || b.ageUp) return;
    b.trainProgress += DT / ENTITY_STATS[b.queue[0]].trainTime;
    if (b.trainProgress < 1) return;

    // Spawn out of the front door (the side facing the camera), fanned out so they don't pile up
    const unitType = b.queue.shift();
    b.trainProgress = 0;
    b.spawned = (b.spawned ?? 0) + 1;
    const angle = FRONT + [0, -0.35, 0.35, -0.7, 0.7][b.spawned % 5];
    const distance = this.outside(b, angle, ENTITY_STATS[unitType].radius);
    const player = this.players.get(b.owner);
    if (player) player.stats.trained++;
    this.addUnit(
      unitType,
      b.owner,
      clamp(b.x + Math.cos(angle) * distance, 0, this.mapSize),
      clamp(b.y + Math.sin(angle) * distance, 0, this.mapSize),
    );
  }

  // Units alive plus units waiting in queues count against the cap, which houses and town centers raise
  // Population, population cap and ranking points
  updatePopulation(player) {
    let pop = 0;
    let cap = 0;
    let buildings = 0;
    for (const e of this.entities.values()) {
      if (e.owner !== player.id) continue;
      if (isUnit(e)) pop++;
      else {
        pop += e.queue.length;
        if (e.built) cap += ENTITY_STATS[e.type].population ?? 0;
        if (e.built && !e.central) buildings++;
      }
    }
    player.pop = pop;
    player.popCap = Math.min(MAX_POPULATION, cap);
    const { stats } = player;
    const central = this.central?.owner === player.id ? this.central.controlTime : 0;
    player.score = Math.floor(stats.gathered * SCORE.perGathered + stats.kills * SCORE.perKill
      + stats.trained * SCORE.perTrained + buildings * SCORE.perBuilding
      + player.gatherLevel * SCORE.perUpgrade + (player.age - 1) * SCORE.perAge + central * SCORE.perCentralSecond);
  }

  tick() {
    this.tickCount++;
    for (const e of this.entities.values()) { e.prevX = e.x; e.prevY = e.y; }
    for (const s of this.resources.values()) if (isSheep(s)) { s.prevX = s.x; s.prevY = s.y; }
    for (const e of [...this.entities.values()]) {
      if (!this.entities.has(e.id)) continue; // removed earlier this tick
      if (isBuilding(e)) { this.updateProduction(e); this.updateResearch(e); this.updateAgeUp(e); this.updateTower(e); continue; }
      e.action = 'idle';
      e.cooldown = Math.max(0, e.cooldown - DT);
      // Stunned units (flyer impact) can't move or act until it wears off
      if (e.stun > 0) { e.stun -= DT; e.action = 'stunned'; continue; }
      if (e.post) this.leashGuard(e);
      const task = e.task?.type;
      if (task === 'heal') this.updateHealer(e);
      else if (task === 'gather') this.updateGatherer(e);
      else if (task === 'build') this.updateBuilder(e);
      else if (task === 'attack') this.updateAttacker(e);
      else if (task === 'capture') this.updateCapturer(e);
      else if (task === 'farm') this.updateFarmer(e);
      else if (this.moveToward(e, e.tx, e.ty)) {
        e.formationSpeed = null;
        if (this.nextOrder(e)) continue;
        if (ENTITY_STATS[e.type].heal) this.autoHeal(e);
        else this.autoAcquire(e);
      }
      else if (e.unreachable) { e.tx = e.x; e.ty = e.y; } // stop on the river bank / forest edge
    }
    this.updateSheep();
    this.applyKnockback();
    this.applyBurns();
    this.separateUnits();
    if (this.central?.owner) this.central.controlTime += DT;

    if (this.shots.length) {
      this.io.to(this.id).emit('game:shots', this.shots);
      this.shots = [];
    }

    if (this.resourceChanges.size) {
      this.io.to(this.id).emit('game:resources', [...this.resourceChanges].map(([id, amount]) => ({ id, amount })));
      this.resourceChanges.clear();
    }

    for (const p of this.players.values()) this.updatePopulation(p);
    // Not volatile: a volatile state is dropped whenever the socket is still busy, and the resources
    // and shots sent just before it in the same tick kept it busy, so states never arrived. Clients
    // skip stale states themselves (they only read the newest one each frame).
    this.io.to(this.id).emit('game:state', {
      players: [...this.players.values()].map(({ flag, ...p }) => p), // flags are sent once, at the start
      sheep: this.sheepState(),
      entities: [...this.entities.values()].map((e) => this.serialize(e)),
    });
    this.checkGameOver();
  }

  // Players without a town center of their own (the central one doesn't count) are defeated
  checkGameOver() {
    if (this.status !== RoomStatus.PLAYING) return;

    if (this.central?.owner && this.central.controlTime >= CENTRAL_CONTROL_TIME) {
      this.endGame(this.central.owner, 'dominó la Fortaleza central');
      return;
    }

    for (const player of this.players.values()) {
      if (player.defeated) continue;
      const hasTownCenter = [...this.entities.values()].some(
        (e) => e.owner === player.id && e.type === EntityType.TOWN_CENTER && !e.central,
      );
      if (hasTownCenter) continue;
      player.defeated = true;
      if (this.central?.owner === player.id) this.loseCentral();
      for (const e of [...this.entities.values()]) if (e.owner === player.id) this.removeEntity(e);
      this.io.to(player.id).emit('game:defeated');
      this.notice(`${player.name} ha sido derrotado`);
    }

    // Over when everyone still standing is on one side (a lone player, or one team)
    const alive = [...this.players.values()].filter((p) => !p.defeated);
    const oneSide = alive.length > 0 && alive.every((p) => this.allied(p.id, alive[0].id));
    if (this.startingPlayers > 1 && oneSide && [...this.players.values()].some((p) => !this.allied(p.id, alive[0].id))) {
      this.endGame(alive[0].id, alive.length > 1 ? 'destruyeron todos los Centros urbanos enemigos' : 'destruyó todos los Centros urbanos enemigos');
    } else if (alive.length === 0) this.endGame(null, 'nadie sobrevivió');
  }

  endGame(winnerId, reason) {
    this.status = RoomStatus.FINISHED;
    clearInterval(this.interval);
    const winner = this.players.get(winnerId);
    // The whole team wins (defeated teammates too)
    const winners = winner ? [...this.players.values()].filter((p) => this.allied(p.id, winnerId)) : [];
    this.io.to(this.id).emit('game:over', {
      winnerId,
      winnerIds: winners.map((p) => p.id),
      winnerName: winners.length > 1 ? winners.map((p) => p.name).join(' y ') : winner?.name ?? null,
      winnerFaction: winner?.faction ?? null,
      reason,
      duration: (Date.now() - this.startedAt) / 1000,
      players: [...this.players.values()].map(({
        id, name, faction, color, stats,
      }) => ({
        id, name, faction, color, stats,
      })),
    });
    this.broadcastRoom();
    this.onStatusChange();
  }

  // Sent 20 times a second for every entity, so it's kept lean: positions and numbers rounded, and
  // fields left out while they hold their default (the client fills those in)
  serialize(e) {
    const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
    const o = { id: e.id, type: e.type, x: r1(e.x), y: r1(e.y), hp: r1(e.hp) };
    if (e.owner != null) o.owner = e.owner;
    if (e.burn) o.burning = true;
    if (e.chill) o.chilled = true;
    if (e.civ) o.civ = e.civ;
    if (isBuilding(e)) {
      o.tx = e.tx; o.ty = e.ty;
      if (!e.built) { o.built = false; o.buildProgress = r2(e.buildProgress); }
      if (e.queue?.length) { o.queue = e.queue; o.trainProgress = r2(e.trainProgress); }
      if (e.central) { o.central = true; o.controlTime = r1(e.controlTime ?? 0); }
      if (e.food != null) o.food = r1(e.food);
      if (e.maxHp != null && e.maxHp !== ENTITY_STATS[e.type].hp) o.maxHp = e.maxHp;
      if (e.research) o.research = { ...e.research, progress: r2(e.research.progress ?? 0) };
      if (e.ageUp) o.ageUp = { ...e.ageUp, progress: r2(e.ageUp.progress ?? 0) };
      return o;
    }
    const t = e.task;
    if (t) o.task = t.type;
    if (t?.type === 'build' || t?.type === 'farm') o.buildingId = t.buildingId;
    if (t?.type === 'attack' || t?.type === 'heal') o.targetId = t.targetId;
    if (t?.type === 'gather') o.resourceId = t.resourceId;
    if (e.orders?.length) o.orders = e.orders.map((q) => [Math.round(q.x), Math.round(q.y)]);
    if (e.action) o.action = e.action;
    if (e.carry?.amount > 0 || e.carry?.type) o.carry = e.carry;
    if (e.type === EntityType.VILLAGER) {
      const capacity = ENTITY_STATS[e.type].carryCapacity ?? 1;
      // 0..1 fill of the villager's carry load, including the partial unit being gathered
      const fill = r2(Math.min(1, (e.carry.amount + e.gatherProgress) / capacity));
      if (fill > 0) o.gatherFill = fill;
    }
    return o;
  }

  destroy() { clearInterval(this.interval); }
}
