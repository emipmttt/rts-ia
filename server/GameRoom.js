import {
  MAP_WIDTH, MAP_HEIGHT, TICK_RATE, TILE_SIZE, MAX_PLAYERS_PER_ROOM, STARTING_VILLAGERS, STARTING_STOCK,
  MAX_TRAIN_QUEUE, CENTRAL_CONTROL_TIME, FACTIONS, EntityType, ENTITY_STATS, RESOURCE_STATS, MAX_POPULATION,
  MAP_TILES, Terrain, ResourceType,
} from '../shared/constants.js';
import {
  isBuildingType, isUnitType, buildingSize, buildingCenter, tileForCenter, footprint, canPlace, canAfford,
} from '../shared/rules.js';
import { assignSpawns } from './spawns.js';
import { generateWorld } from './worldgen.js';
import { findPath, clearLine } from './pathfinding.js';

const DT = 1 / TICK_RATE;
const RETARGET_RADIUS = 400; // how far a villager looks for more of the same resource
const SEPARATION_CELL = 32; // grid cell size for unit collision lookups (>= largest unit diameter)
const SEPARATION_ITERATIONS = 4;
const COLLISION_PADDING = 3; // units keep this much extra space between each other, matching their sprites
const TERRAIN_RADIUS = 0.8; // fraction of a unit's radius that must stay out of trees and water
const REPATH_TICKS = TICK_RATE; // a blocked unit retries its path at most once a second
const RECONNECT_GRACE_MS = 5 * 60 * 1000; // a playing room with nobody connected is closed after this

// Trees and gold mines are solid; bushes and sheep can be walked through
const isSolidResource = (r) => r.type === ResourceType.GOLD || (r.type === ResourceType.WOOD && r.variant !== 'bush');

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
    this.walkBlocked = new Uint8Array(MAP_TILES * MAP_TILES); // 1 = water, tree or gold mine
    this.tickCount = 0;
    this.emptySince = null; // when the last player of a running game lost connection
    this.resourceChanges = new Map(); // resourceId -> new amount (0 = depleted), flushed each tick
    this.shots = []; // arrows fired this tick, sent to clients for the animation
    this.world = null;
    this.central = null; // the neutral, indestructible town center in the middle of the map
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
    };
  }

  details() {
    return {
      ...this.summary(),
      hostId: this.hostId,
      players: [...this.players.values()].map(({ id, name, faction, color }) => ({ id, name, faction, color })),
    };
  }

  broadcastRoom() { this.io.to(this.id).emit('room:update', this.details()); }

  addPlayer(playerId, name) {
    // Random faction among the ones not taken yet in this room
    const used = new Set([...this.players.values()].map((p) => p.faction));
    const free = FACTIONS.filter((f) => !used.has(f.id));
    const faction = free[Math.floor(Math.random() * free.length)];
    this.players.set(playerId, {
      id: playerId, name, faction: faction.id, color: faction.color, stock: { ...STARTING_STOCK }, defeated: false,
      connected: true, pop: 0, popCap: 0, stats: { trained: 0, lost: 0, kills: 0, gathered: 0 },
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
    const spawns = assignSpawns([...this.players.keys()]);
    const mapCenter = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
    this.world = generateWorld(Math.floor(Math.random() * 2 ** 31), [...spawns.values()], [mapCenter]);
    for (const r of this.world.resources) {
      this.resources.set(r.id, r);
      this.resourceTiles.set(tileKey(r.tx, r.ty), r.id);
    }
    for (const [playerId, point] of spawns) this.spawnPlayer(playerId, point);

    const { tx, ty } = tileForCenter(EntityType.TOWN_CENTER, mapCenter.x, mapCenter.y);
    this.central = this.addBuilding(EntityType.TOWN_CENTER, null, tx, ty, true);
    this.central.central = true;
    this.central.controlTime = 0;

    this.world.tiles.forEach((t, i) => { if (t === Terrain.WATER) this.walkBlocked[i] = 1; });
    for (const r of this.resources.values()) if (isSolidResource(r)) this.walkBlocked[r.ty * MAP_TILES + r.tx] = 1;

    this.io.to(this.id).emit('game:start', this.startPayload());
    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.broadcastRoom();
  }

  // Everything a client needs to draw the game from scratch (at the start, or after reconnecting)
  startPayload() {
    return {
      map: { width: MAP_WIDTH, height: MAP_HEIGHT, tiles: this.world.tiles },
      resources: [...this.resources.values()].map(({
        id, type, variant, tx, ty, amount, max,
      }) => ({
        id, type, variant, tx, ty, amount, max,
      })),
      players: this.details().players,
    };
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
    const maxHp = ENTITY_STATS[type].hp;
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
    };
    for (const [cx, cy] of footprint(type, tx, ty)) this.buildingTiles.set(tileKey(cx, cy), id);
    this.entities.set(id, building);
    return building;
  }

  removeEntity(e) {
    this.entities.delete(e.id);
    if (isBuilding(e)) for (const [cx, cy] of footprint(e.type, e.tx, e.ty)) this.buildingTiles.delete(tileKey(cx, cy));
  }

  isTileBlocked = (x, y) => this.resourceTiles.has(tileKey(x, y)) || this.buildingTiles.has(tileKey(x, y))
    || this.world.tiles[y * MAP_TILES + x] === Terrain.WATER || this.world.tiles[y * MAP_TILES + x] === Terrain.BRIDGE;

  // Town center at the spawn point, villagers placed on the side facing the map centre
  spawnPlayer(owner, point) {
    const { tx, ty } = tileForCenter(EntityType.TOWN_CENTER, point.x, point.y);
    const tc = this.addBuilding(EntityType.TOWN_CENTER, owner, tx, ty, true);

    const toCenter = Math.atan2(MAP_HEIGHT / 2 - tc.y, MAP_WIDTH / 2 - tc.x);
    const distance = buildingSize(tc.type) / 2 + 30;
    for (let i = 0; i < STARTING_VILLAGERS; i++) {
      const angle = toCenter + (i - (STARTING_VILLAGERS - 1) / 2) * 0.5;
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

  handleMove(playerId, { unitIds, x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const units = this.ownedUnits(playerId, unitIds);
    const cols = Math.ceil(Math.sqrt(units.length));
    units.forEach((u, i) => {
      u.task = null;
      u.tx = clamp(x + (i % cols) * 30 - cols * 15, 0, MAP_WIDTH);
      u.ty = clamp(y + Math.floor(i / cols) * 30 - cols * 15, 0, MAP_HEIGHT);
    });
  }

  handleGather(playerId, { unitIds, resourceId }) {
    const resource = this.resources.get(resourceId);
    if (!resource) return;
    // A tree deep inside a forest can't be reached yet: work on the closest exposed one instead
    const target = this.isExposed(resource) ? resource : this.closest(
      [...this.resources.values()].filter((r) => r.type === resource.type && this.isExposed(r)), resource.x, resource.y, RETARGET_RADIUS,
    ) ?? resource;
    for (const u of this.ownedVillagers(playerId, unitIds)) {
      u.task = { type: 'gather', resourceId: target.id, resourceType: target.type };
    }
  }

  // Place a new building: pays the cost and sends villagers to build it
  handleBuild(playerId, { type, tx, ty, unitIds }) {
    const player = this.players.get(playerId);
    if (!player || this.status !== RoomStatus.PLAYING || !isBuildingType(type)) return;
    if (!Number.isInteger(tx) || !Number.isInteger(ty)) return;
    const { cost } = ENTITY_STATS[type];
    if (!canAfford(player.stock, cost)) return this.error(playerId, 'Recursos insuficientes');
    if (!canPlace(type, tx, ty, this.isTileBlocked)) return this.error(playerId, 'No se puede construir ahí');

    let builders = this.ownedVillagers(playerId, unitIds);
    if (!builders.length) {
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
    for (const u of builders) u.task = { type: 'build', buildingId: building.id };
  }

  // Send villagers to help finish an existing construction
  handleConstruct(playerId, { unitIds, buildingId }) {
    const building = this.entities.get(buildingId);
    if (!building || building.owner !== playerId || !isBuilding(building) || building.built) return;
    for (const u of this.ownedVillagers(playerId, unitIds)) u.task = { type: 'build', buildingId };
  }

  // Assign villagers to harvest a finished farm
  handleFarm(playerId, { unitIds, buildingId }) {
    const farm = this.entities.get(buildingId);
    if (!farm || farm.owner !== playerId || !ENTITY_STATS[farm.type].farm || !farm.built) return;
    for (const u of this.ownedVillagers(playerId, unitIds)) u.task = { type: 'farm', buildingId };
  }

  // Replant a harvested farm, paying wood
  handleReseed(playerId, { buildingId }) {
    const player = this.players.get(playerId);
    const farm = this.entities.get(buildingId);
    const stats = farm && ENTITY_STATS[farm.type].farm;
    if (!player || !stats || farm.owner !== playerId || !farm.built || this.status !== RoomStatus.PLAYING) return;
    if (farm.food > 0) return this.error(playerId, 'La siembra aún no se ha acabado');
    if (!canAfford(player.stock, stats.reseedCost)) return this.error(playerId, 'Recursos insuficientes');
    for (const [k, v] of Object.entries(stats.reseedCost)) player.stock[k] -= v;
    farm.food = stats.food;
  }

  // Attack an enemy entity. Villagers ordered onto a fallen central town center capture it instead.
  handleAttack(playerId, { unitIds, targetId }) {
    const target = this.entities.get(targetId);
    if (!target) return;
    for (const u of this.ownedUnits(playerId, unitIds)) {
      if (target.central && target.hp <= 0) {
        if (u.type === EntityType.VILLAGER) u.task = { type: 'capture', buildingId: target.id };
      } else if (target.owner !== playerId) {
        u.task = { type: 'attack', targetId: target.id };
      }
    }
  }

  // Queue a unit in a finished building, paying its cost up front
  handleTrain(playerId, { buildingId }) {
    const player = this.players.get(playerId);
    const building = this.entities.get(buildingId);
    if (!player || !building || building.owner !== playerId || !isBuilding(building) || !building.built) return;
    const unitType = ENTITY_STATS[building.type].trains;
    if (!unitType) return;
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
      return x >= 0 && y >= 0 && x < MAP_TILES && y < MAP_TILES && !this.walkBlocked[y * MAP_TILES + x];
    });
  }

  // Moves toward (x, y), around trees and water; returns true once within stopDistance.
  // Sets u.unreachable when the destination can't be reached and the unit got as close as it can.
  moveToward(u, x, y, stopDistance = 0) {
    const dist = Math.hypot(x - u.x, y - u.y);
    u.unreachable = false;
    if (dist <= stopDistance) { u.path = null; return true; }
    u.action = 'moving';
    const r = ENTITY_STATS[u.type].radius * TERRAIN_RADIUS;
    const gx = clamp(Math.floor(x / TILE_SIZE), 0, MAP_TILES - 1);
    const gy = clamp(Math.floor(y / TILE_SIZE), 0, MAP_TILES - 1);
    const goal = gy * MAP_TILES + gx;
    // Walking up to a tree or mine: its own tile doesn't count as an obstacle
    const ignore = stopDistance > 0 && this.resourceTiles.has(tileKey(gx, gy)) ? goal : -1;

    // Straight line when nothing is in the way, otherwise follow an A* path (recomputed when the goal tile changes)
    let wp = { x, y };
    if (!clearLine(this.walkBlocked, u.x, u.y, x, y, r, ignore)) {
      if (!u.path || u.path.goal !== goal || (!u.path.points.length && this.tickCount - u.path.tick >= REPATH_TICKS)) {
        const sx = clamp(Math.floor(u.x / TILE_SIZE), 0, MAP_TILES - 1);
        const sy = clamp(Math.floor(u.y / TILE_SIZE), 0, MAP_TILES - 1);
        u.path = { goal, tick: this.tickCount, ...findPath(this.walkBlocked, sx, sy, gx, gy, ignore === goal) };
      }
      const pts = u.path.points;
      // Drop reached waypoints, and skip ahead whenever the next one is already in plain sight
      while (pts.length && Math.hypot(pts[0].x - u.x, pts[0].y - u.y) < 4) pts.shift();
      while (pts.length > 1 && clearLine(this.walkBlocked, u.x, u.y, pts[1].x, pts[1].y, r, ignore)) pts.shift();
      if (!pts.length) {
        if (u.path.partial) { u.unreachable = true; u.action = 'idle'; return false; }
      } else if (pts.length > 1 || u.path.partial) wp = pts[0];
    }

    const step = ENTITY_STATS[u.type].speed * DT;
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
            a.x = clamp(a.x - nx * half, 0, MAP_WIDTH);
            a.y = clamp(a.y - ny * half, 0, MAP_HEIGHT);
            b.x = clamp(b.x + nx * half, 0, MAP_WIDTH);
            b.y = clamp(b.y + ny * half, 0, MAP_HEIGHT);
            pushed.add(a); pushed.add(b);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    for (const u of units) this.pushOutOfTerrain(u);
    // A unit with a plain move order that got shoved near its destination settles where it is,
    // otherwise idle units would keep walking back into each other forever
    for (const u of pushed) {
      if (u.task) continue;
      if (Math.hypot(u.tx - u.x, u.ty - u.y) <= ENTITY_STATS[u.type].radius * 3) { u.tx = u.x; u.ty = u.y; }
    }
  }

  // Keeps a unit's body out of trees, gold mines and water
  pushOutOfTerrain(u) {
    const r = ENTITY_STATS[u.type].radius * TERRAIN_RADIUS;
    const cx = Math.floor(u.x / TILE_SIZE);
    const cy = Math.floor(u.y / TILE_SIZE);
    for (let ty = cy - 1; ty <= cy + 1; ty++) {
      for (let tx = cx - 1; tx <= cx + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES || !this.walkBlocked[ty * MAP_TILES + tx]) continue;
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

    // Resource gone: look for another of the same type nearby
    if (!resource) {
      const sameType = [...this.resources.values()].filter((r) => r.type === task.resourceType && this.isExposed(r));
      resource = this.closest(sameType, u.x, u.y, RETARGET_RADIUS);
      if (resource) task.resourceId = resource.id;
    }

    // Full, or nothing left to gather: carry it back to the closest finished town center
    if (carry.amount >= stats.carryCapacity || (!resource && carry.amount > 0)) {
      this.deliverCarry(u);
      return;
    }

    if (!resource) { u.task = null; return; }
    if (!this.moveToward(u, resource.x, resource.y, TILE_SIZE / 2 + stats.radius)) return;

    u.action = 'gathering';
    // Switching resource type drops what was being carried, like in AoE
    if (carry.type !== resource.type) {
      carry.type = resource.type;
      carry.amount = 0;
      u.gatherProgress = 0;
    }
    u.gatherProgress += RESOURCE_STATS[resource.type].gatherRate * DT;
    while (u.gatherProgress >= 1 && resource.amount > 0 && carry.amount < stats.carryCapacity) {
      u.gatherProgress -= 1;
      resource.amount -= 1;
      carry.amount += 1;
    }
    this.resourceChanges.set(resource.id, resource.amount);
    if (resource.amount <= 0) {
      this.resources.delete(resource.id);
      this.resourceTiles.delete(tileKey(resource.tx, resource.ty));
      this.walkBlocked[resource.ty * MAP_TILES + resource.tx] = 0;
    }
  }

  // Walks the villager's load to the closest finished town center and adds it to the stock
  deliverCarry(u) {
    const dropOffs = [...this.entities.values()].filter(
      (e) => e.owner === u.owner && e.type === EntityType.TOWN_CENTER && e.built,
    );
    const dropOff = this.closest(dropOffs, u.x, u.y);
    if (!dropOff) { u.task = null; return; }
    if (!this.moveToward(u, dropOff.x, dropOff.y, buildingSize(dropOff.type) / 2 + ENTITY_STATS[u.type].radius)) return;
    const player = this.players.get(u.owner);
    if (player) {
      player.stock[u.carry.type] += u.carry.amount;
      player.stats.gathered += u.carry.amount;
    }
    u.carry.amount = 0;
  }

  // Farmers harvest the crop fields around the farm; when the crops run out they drop off what
  // they carry and wait at the farm until it is reseeded
  updateFarmer(u) {
    const farm = this.entities.get(u.task.buildingId);
    const { carry } = u;
    const stats = ENTITY_STATS[u.type];
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
    u.gatherProgress += RESOURCE_STATS.food.gatherRate * DT;
    while (u.gatherProgress >= 1 && farm.food > 0 && carry.amount < stats.carryCapacity) {
      u.gatherProgress -= 1;
      farm.food -= 1;
      carry.amount += 1;
    }
  }

  // Each villager working on a building adds its own build speed, so more villagers = faster
  updateBuilder(u) {
    const building = this.entities.get(u.task.buildingId);
    if (!building || building.built) { u.task = null; return; }
    const reach = buildingSize(building.type) / 2 + ENTITY_STATS[u.type].radius;
    if (!this.moveToward(u, building.x, building.y, reach)) return;

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
  bodyRadius(e) { return isBuilding(e) ? buildingSize(e.type) / 2 : ENTITY_STATS[e.type].radius; }

  updateAttacker(u) {
    const target = this.entities.get(u.task.targetId);
    if (!target || target.owner === u.owner || (target.central && target.hp <= 0)) { u.task = null; return; }
    const { attack } = ENTITY_STATS[u.type];
    const reach = attack.range + ENTITY_STATS[u.type].radius + this.bodyRadius(target) + 2;
    if (!this.moveToward(u, target.x, target.y, reach)) return;

    u.action = 'attacking';
    if (u.cooldown > 0) return;
    u.cooldown = attack.cooldown;
    if (attack.range > 0) this.shots.push({ x: u.x, y: u.y, targetId: target.id });
    this.damage(target, attack.damage, u.owner);
  }

  // Finished towers and town centers shoot the closest enemy unit in range, sticking to a target while it stays in range
  updateTower(b) {
    const { attack } = ENTITY_STATS[b.type];
    if (!attack || !b.built || !b.owner || b.hp <= 0) return;
    b.cooldown = Math.max(0, b.cooldown - DT);
    const inRange = (e) => e && isUnit(e) && e.owner !== b.owner
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
    this.damage(target, attack.damage, b.owner);
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
    if (!this.moveToward(u, c.x, c.y, buildingSize(c.type) / 2 + ENTITY_STATS[u.type].radius + 2)) return;
    c.owner = u.owner;
    c.hp = ENTITY_STATS[c.type].hp;
    c.controlTime = 0;
    this.removeEntity(u);
    this.notice(`¡${this.players.get(u.owner)?.name} capturó el Centro urbano central!`);
  }

  // Idle soldiers attack the closest enemy unit in range
  autoAcquire(u) {
    const { aggroRange } = ENTITY_STATS[u.type];
    if (!aggroRange) return;
    const enemies = [...this.entities.values()].filter((e) => isUnit(e) && e.owner !== u.owner);
    const target = this.closest(enemies, u.x, u.y, aggroRange);
    if (target) u.task = { type: 'attack', targetId: target.id };
  }

  updateProduction(b) {
    if (!b.built || !b.queue.length) return;
    b.trainProgress += DT / ENTITY_STATS[b.queue[0]].trainTime;
    if (b.trainProgress < 1) return;

    // Spawn on the side of the building facing the map centre
    const unitType = b.queue.shift();
    b.trainProgress = 0;
    const angle = Math.atan2(MAP_HEIGHT / 2 - b.y, MAP_WIDTH / 2 - b.x) + (Math.random() - 0.5);
    const distance = buildingSize(b.type) / 2 + ENTITY_STATS[unitType].radius + 6;
    const player = this.players.get(b.owner);
    if (player) player.stats.trained++;
    this.addUnit(
      unitType,
      b.owner,
      clamp(b.x + Math.cos(angle) * distance, 0, MAP_WIDTH),
      clamp(b.y + Math.sin(angle) * distance, 0, MAP_HEIGHT),
    );
  }

  // Units alive plus units waiting in queues count against the cap, which houses and town centers raise
  updatePopulation(player) {
    let pop = 0;
    let cap = 0;
    for (const e of this.entities.values()) {
      if (e.owner !== player.id) continue;
      if (isUnit(e)) pop++;
      else {
        pop += e.queue.length;
        if (e.built) cap += ENTITY_STATS[e.type].population ?? 0;
      }
    }
    player.pop = pop;
    player.popCap = Math.min(MAX_POPULATION, cap);
  }

  tick() {
    this.tickCount++;
    for (const e of [...this.entities.values()]) {
      if (!this.entities.has(e.id)) continue; // removed earlier this tick
      if (isBuilding(e)) { this.updateProduction(e); this.updateTower(e); continue; }
      e.action = 'idle';
      e.cooldown = Math.max(0, e.cooldown - DT);
      const task = e.task?.type;
      if (task === 'gather') this.updateGatherer(e);
      else if (task === 'build') this.updateBuilder(e);
      else if (task === 'attack') this.updateAttacker(e);
      else if (task === 'capture') this.updateCapturer(e);
      else if (task === 'farm') this.updateFarmer(e);
      else if (this.moveToward(e, e.tx, e.ty)) this.autoAcquire(e);
      else if (e.unreachable) { e.tx = e.x; e.ty = e.y; } // stop on the river bank / forest edge
    }
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
    this.io.to(this.id).emit('game:state', {
      players: [...this.players.values()],
      entities: [...this.entities.values()].map((e) => this.serialize(e)),
    });
    this.checkGameOver();
  }

  // Players without a town center of their own (the central one doesn't count) are defeated
  checkGameOver() {
    if (this.status !== RoomStatus.PLAYING) return;

    if (this.central?.owner && this.central.controlTime >= CENTRAL_CONTROL_TIME) {
      this.endGame(this.central.owner, 'dominó el Centro urbano central');
      return;
    }

    for (const player of this.players.values()) {
      if (player.defeated) continue;
      const hasTownCenter = [...this.entities.values()].some(
        (e) => e.owner === player.id && e.type === EntityType.TOWN_CENTER && !e.central,
      );
      if (hasTownCenter) continue;
      player.defeated = true;
      if (this.central.owner === player.id) this.loseCentral();
      for (const e of [...this.entities.values()]) if (e.owner === player.id) this.removeEntity(e);
      this.io.to(player.id).emit('game:defeated');
      this.notice(`${player.name} ha sido derrotado`);
    }

    const alive = [...this.players.values()].filter((p) => !p.defeated);
    if (this.startingPlayers > 1 && alive.length === 1) this.endGame(alive[0].id, 'destruyó todos los Centros urbanos enemigos');
    else if (alive.length === 0) this.endGame(null, 'nadie sobrevivió');
  }

  endGame(winnerId, reason) {
    this.status = RoomStatus.FINISHED;
    clearInterval(this.interval);
    const winner = this.players.get(winnerId);
    this.io.to(this.id).emit('game:over', {
      winnerId,
      winnerName: winner?.name ?? null,
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

  serialize(e) {
    const base = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp };
    if (isBuilding(e)) {
      return {
        ...base, tx: e.tx, ty: e.ty, built: e.built, buildProgress: e.buildProgress,
        queue: e.queue, trainProgress: e.trainProgress,
        central: !!e.central, controlTime: e.controlTime ?? 0, food: e.food,
      };
    }
    const capacity = ENTITY_STATS[e.type].carryCapacity ?? 1;
    return {
      ...base,
      task: e.task?.type ?? null,
      buildingId: e.task?.type === 'build' || e.task?.type === 'farm' ? e.task.buildingId : null,
      targetId: e.task?.type === 'attack' ? e.task.targetId : null,
      action: e.action,
      carry: e.carry,
      // 0..1 fill of the villager's carry load, including the partial unit being gathered
      gatherFill: Math.min(1, (e.carry.amount + e.gatherProgress) / capacity),
    };
  }

  destroy() { clearInterval(this.interval); }
}
