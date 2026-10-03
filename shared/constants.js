export const TICK_RATE = 20; // server updates per second
export const PORT = Number(globalThis.process?.env?.PORT) || 3001;
// One faction per player (matches the Tiny Swords colour sets); color is used for UI accents
export const FACTIONS = [
  { id: 'blue', color: 0x3b82f6 },
  { id: 'red', color: 0xe74c3c },
  { id: 'yellow', color: 0xf1c40f },
  { id: 'purple', color: 0x9b59b6 },
  { id: 'black', color: 0x6b7280 },
];
export const MAX_PLAYERS_PER_ROOM = FACTIONS.length;

// World: square grid of tiles
export const TILE_SIZE = 40;
// Map side in tiles grows with the number of players (the client draws it into one texture, so it
// must stay under 4096px = 102 tiles)
export const mapTilesFor = (players) => Math.min(100, Math.max(60, 50 + players * 10));

// Water can't be crossed except over bridges; neither can be built on
export const Terrain = {
  GRASS: 0, SAND: 1, WATER: 2, BRIDGE: 3,
};

// Distance from the map border to the centre of each player's town center
export const SPAWN_MARGIN = 200;
export const STARTING_VILLAGERS = 3;

export const STARTING_STOCK = {
  food: 200, wood: 250, gold: 100, stone: 100,
};
export const MAX_POPULATION = 300;
export const MAX_TRAIN_QUEUE = 5;

// Victory: hold the central town center this many seconds, or destroy every enemy town center
export const CENTRAL_CONTROL_TIME = 180;
// The central town center is tougher than a normal one and starts guarded by neutral knights
export const CENTRAL_HP = 6000;
export const CENTRAL_GUARDS = 6;
export const GUARD_LEASH = 320; // guards chase intruders at most this far from their post

export const EntityType = {
  TOWN_CENTER: 'townCenter',
  BARRACKS: 'barracks',
  ARCHERY_RANGE: 'archeryRange',
  STABLE: 'stable',
  TOWER: 'tower',
  HOUSE: 'house',
  FARM: 'farm',
  LUMBER_CAMP: 'lumberCamp',
  MONASTERY: 'monastery',
  VILLAGER: 'villager',
  SWORDSMAN: 'swordsman',
  ARCHER: 'archer',
  HORSEMAN: 'horseman',
  MONK: 'monk',
  GUARD: 'guard',
};

// Stats per entity type, shared by server (logic) and client (rendering/UI).
// Buildings: tiles = square footprint, buildTime in seconds (1 villager), trains = unit it produces,
// attack = buildings that shoot enemy units in range (towers, town centers), population = pop cap it provides.
// Units: trainTime in seconds, speed in px/s, attack range in px (0 = melee), cooldown in seconds,
// aggroRange = distance at which idle soldiers attack enemies on their own.
export const ENTITY_STATS = {
  [EntityType.TOWN_CENTER]: {
    kind: 'building', name: 'Centro urbano', tiles: 3, hp: 2400, cost: { wood: 275, stone: 200 }, buildTime: 60, trains: EntityType.VILLAGER,
    population: 5, attack: { damage: 6, range: 220, cooldown: 3 },
  },
  [EntityType.HOUSE]: {
    kind: 'building', name: 'Casa', tiles: 1, hp: 500, cost: { wood: 30 }, buildTime: 15, population: 5,
  },
  // Farm: a small house surrounded by crop fields. Villagers assigned to it harvest food until the
  // crops run out; reseeding costs wood.
  [EntityType.FARM]: {
    kind: 'building', name: 'Granja', tiles: 3, hp: 300, cost: { wood: 60 }, buildTime: 20,
    farm: { food: 250, reseedCost: { wood: 40 } },
  },
  // Lumber camp: drop-off for every resource, and researches better gathering (see GATHER_UPGRADES)
  [EntityType.LUMBER_CAMP]: {
    kind: 'building', name: 'Aserradero', tiles: 2, hp: 600, cost: { wood: 100 }, buildTime: 20, dropOff: true,
  },
  [EntityType.MONASTERY]: {
    kind: 'building', name: 'Monasterio', tiles: 2, hp: 900, cost: { wood: 150, stone: 75 }, buildTime: 35, trains: EntityType.MONK,
  },
  [EntityType.BARRACKS]: {
    kind: 'building', name: 'Cuartel', tiles: 2, hp: 1200, cost: { wood: 150 }, buildTime: 25, trains: EntityType.SWORDSMAN,
  },
  [EntityType.ARCHERY_RANGE]: {
    kind: 'building', name: 'Arquería', tiles: 2, hp: 1000, cost: { wood: 175 }, buildTime: 25, trains: EntityType.ARCHER,
  },
  [EntityType.STABLE]: {
    kind: 'building', name: 'Establo', tiles: 2, hp: 1000, cost: { wood: 175 }, buildTime: 30, trains: EntityType.HORSEMAN,
  },
  [EntityType.TOWER]: {
    kind: 'building', name: 'Torre', tiles: 1, hp: 350, cost: { wood: 25, stone: 100 }, buildTime: 30,
    attack: { damage: 6, range: 220, cooldown: 1.5 },
  },
  [EntityType.VILLAGER]: {
    kind: 'unit', name: 'Aldeano', radius: 10, speed: 100, hp: 25, carryCapacity: 10, cost: { food: 50 }, trainTime: 10,
    attack: { damage: 3, range: 0, cooldown: 1.5 },
  },
  [EntityType.SWORDSMAN]: {
    kind: 'unit', name: 'Espadachín', radius: 11, speed: 90, hp: 60, cost: { food: 60, gold: 20 }, trainTime: 12,
    attack: { damage: 9, range: 0, cooldown: 1 }, aggroRange: 180,
  },
  [EntityType.ARCHER]: {
    kind: 'unit', name: 'Arquero', radius: 10, speed: 95, hp: 35, cost: { food: 30, wood: 40 }, trainTime: 14,
    attack: { damage: 5, range: 160, cooldown: 1.5 }, aggroRange: 220,
  },
  [EntityType.HORSEMAN]: {
    kind: 'unit', name: 'Jinete', radius: 13, speed: 150, hp: 100, cost: { food: 80, gold: 60 }, trainTime: 18,
    attack: { damage: 8, range: 0, cooldown: 1.2 }, aggroRange: 200,
  },
  // Monks don't fight: they walk up to hurt friendly units nearby and heal them
  [EntityType.MONK]: {
    kind: 'unit', name: 'Monje', radius: 10, speed: 80, hp: 30, cost: { gold: 80 }, trainTime: 16,
    heal: { amount: 4, range: 90, cooldown: 1, searchRange: 260 },
  },
  // Neutral knights guarding the central town center; can't be trained
  [EntityType.GUARD]: {
    kind: 'unit', name: 'Caballero guardián', radius: 13, speed: 140, hp: 220,
    attack: { damage: 14, range: 0, cooldown: 1.1 }, aggroRange: 260,
  },
};

// Lumber camp research: each level multiplies every villager's gather rate
export const GATHER_UPGRADES = [
  { name: 'Herramientas de hierro', bonus: 1.25, cost: { food: 100, wood: 100 }, time: 30 },
  { name: 'Herramientas de acero', bonus: 1.5, cost: { food: 200, wood: 150, gold: 50 }, time: 45 },
  { name: 'Carretillas', bonus: 1.8, cost: { food: 300, wood: 200, gold: 100 }, time: 60 },
];

// Sheep wander until a player's unit comes near; then they belong to that player and walk to their
// closest drop-off, where villagers butcher them
export const SHEEP = { speed: 55, radius: 9, captureRange: 150, idleDistance: 70 };

export const ResourceType = {
  FOOD: 'food', WOOD: 'wood', GOLD: 'gold', STONE: 'stone',
};
export const RESOURCE_NAMES = {
  food: 'comida', wood: 'madera', gold: 'oro', stone: 'piedra',
};

// amount: per tile; gatherRate: units per second per villager
export const RESOURCE_STATS = {
  [ResourceType.FOOD]: { amount: 100, gatherRate: 0.9 },
  [ResourceType.WOOD]: { amount: 100, gatherRate: 0.8 },
  [ResourceType.GOLD]: { amount: 400, gatherRate: 0.6 },
  [ResourceType.STONE]: { amount: 350, gatherRate: 0.6 },
};
// Bushes are small decorative wood resources
export const BUSH_WOOD = 40;
