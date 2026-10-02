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
export const MAP_TILES = 60;
export const MAP_WIDTH = MAP_TILES * TILE_SIZE;
export const MAP_HEIGHT = MAP_TILES * TILE_SIZE;

export const Terrain = { GRASS: 0, SAND: 1 };

// Distance from the map border to the centre of each player's town center
export const SPAWN_MARGIN = 200;
export const STARTING_VILLAGERS = 3;

export const STARTING_STOCK = { wood: 200, gold: 100 };
export const MAX_TRAIN_QUEUE = 5;

// Victory: hold the central town center this many seconds, or destroy every enemy town center
export const CENTRAL_CONTROL_TIME = 180;

export const EntityType = {
  TOWN_CENTER: 'townCenter',
  BARRACKS: 'barracks',
  ARCHERY_RANGE: 'archeryRange',
  STABLE: 'stable',
  TOWER: 'tower',
  VILLAGER: 'villager',
  SWORDSMAN: 'swordsman',
  ARCHER: 'archer',
  HORSEMAN: 'horseman',
};

// Stats per entity type, shared by server (logic) and client (rendering/UI).
// Buildings: tiles = square footprint, buildTime in seconds (1 villager), trains = unit it produces,
// attack = buildings that shoot enemy units in range (towers).
// Units: trainTime in seconds, speed in px/s, attack range in px (0 = melee), cooldown in seconds,
// aggroRange = distance at which idle soldiers attack enemies on their own.
export const ENTITY_STATS = {
  [EntityType.TOWN_CENTER]: {
    kind: 'building', name: 'Town Center', tiles: 3, hp: 2400, cost: { wood: 300, gold: 100 }, buildTime: 60, trains: EntityType.VILLAGER,
  },
  [EntityType.BARRACKS]: {
    kind: 'building', name: 'Barracks', tiles: 2, hp: 1200, cost: { wood: 150 }, buildTime: 25, trains: EntityType.SWORDSMAN,
  },
  [EntityType.ARCHERY_RANGE]: {
    kind: 'building', name: 'Archery Range', tiles: 2, hp: 1000, cost: { wood: 175 }, buildTime: 25, trains: EntityType.ARCHER,
  },
  [EntityType.STABLE]: {
    kind: 'building', name: 'Stable', tiles: 2, hp: 1000, cost: { wood: 175 }, buildTime: 30, trains: EntityType.HORSEMAN,
  },
  [EntityType.TOWER]: {
    kind: 'building', name: 'Tower', tiles: 1, hp: 700, cost: { wood: 100, gold: 50 }, buildTime: 30,
    attack: { damage: 6, range: 220, cooldown: 1.5 },
  },
  [EntityType.VILLAGER]: {
    kind: 'unit', name: 'Villager', radius: 10, speed: 100, hp: 25, carryCapacity: 10, cost: { wood: 50 }, trainTime: 10,
    attack: { damage: 3, range: 0, cooldown: 1.5 },
  },
  [EntityType.SWORDSMAN]: {
    kind: 'unit', name: 'Swordsman', radius: 11, speed: 90, hp: 60, cost: { wood: 20, gold: 30 }, trainTime: 12,
    attack: { damage: 9, range: 0, cooldown: 1 }, aggroRange: 180,
  },
  [EntityType.ARCHER]: {
    kind: 'unit', name: 'Archer', radius: 10, speed: 95, hp: 35, cost: { wood: 25, gold: 45 }, trainTime: 14,
    attack: { damage: 5, range: 160, cooldown: 1.5 }, aggroRange: 220,
  },
  [EntityType.HORSEMAN]: {
    kind: 'unit', name: 'Horseman', radius: 13, speed: 150, hp: 100, cost: { wood: 20, gold: 70 }, trainTime: 18,
    attack: { damage: 8, range: 0, cooldown: 1.2 }, aggroRange: 200,
  },
};

export const ResourceType = { WOOD: 'wood', GOLD: 'gold' };

// amount: per tile; gatherRate: units per second per villager
export const RESOURCE_STATS = {
  [ResourceType.WOOD]: { amount: 100, gatherRate: 0.8 },
  [ResourceType.GOLD]: { amount: 400, gatherRate: 0.6 },
};
