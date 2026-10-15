export const TICK_RATE = 20; // server updates per second
export const PORT = Number(globalThis.process?.env?.PORT) || 3001;
// One faction per player (matches the Tiny Swords colour sets); color is used for UI accents
// Pastel but still distinct from each other and from the muted scenery
export const FACTIONS = [
  { id: 'blue', color: 0x6c9bd6 },
  { id: 'red', color: 0xd9776d },
  { id: 'yellow', color: 0xe2bf5c },
  { id: 'purple', color: 0xa489c8 },
  { id: 'black', color: 0x7e8794 },
  { id: 'green', color: 0x7dbd6c },
  { id: 'orange', color: 0xe8975a },
  { id: 'teal', color: 0x5cbcb8 },
  { id: 'pink', color: 0xe08ab8 },
  { id: 'brown', color: 0xa8835e },
];
// Civilizations each player picks in the waiting room; they change the units' art
export const CIVILIZATIONS = [
  { id: 'air', name: 'Aire' },
  { id: 'fire', name: 'Fuego' },
  { id: 'earth', name: 'Tierra' },
  { id: 'water', name: 'Agua' },
];
// Per-civilization stat changes, merged over ENTITY_STATS by unitStats(). Balance: swordsmen all deal
// ~9 dmg/s; ranged units ~3.5 dmg/s on one target, each with a trade-off (range, burn, a line that hits
// several units and wrecks buildings, slowing ice); fast units trade crowd control for damage or speed.
// Attack extras: burn { dps, duration } sets the target on fire; chill { factor, duration } slows it
// (speed x factor); line { width, splash } strikes every enemy unit on a line of rock spikes through
// the target (the others for damage x splash), and against buildings throws a boulder for damage x
// vsBuildings; area/knockback/stun as in ENTITY_STATS
export const CIV_STATS = {
  fire: {
    // Fire flyer: dives that set everything around burning instead of stunning
    horseman: {
      name: 'Volador de fuego',
      attack: {
        damage: 8, range: 0, cooldown: 2.4, area: 60, knockback: 480, burn: { dps: 3, duration: 3 },
      },
    },
    // Fire mage: slow fireballs that keep the target burning
    archer: { name: 'Mago de fuego', attack: { damage: 6.2, range: 160, cooldown: 2, burn: { dps: 2, duration: 2 } } },
    swordsman: { name: 'Espadachín de fuego', attack: { damage: 10, range: 0, cooldown: 1.15 } },
  },
  earth: {
    // Earth rider: surfs a slab of rock; slams the ground, hard hits and a big shove, no stun
    horseman: {
      name: 'Surfista de roca', speed: 129,
      attack: {
        damage: 11, range: 0, cooldown: 2, area: 55, knockback: 320,
      },
    },
    // Geomancer: a line of rock spikes erupting toward units, boulders against buildings
    archer: {
      name: 'Geomante',
      attack: {
        damage: 7.2, range: 160, cooldown: 2.2, line: { width: 16, splash: 0.4 }, vsBuildings: 3,
      },
    },
    // Rock-fisted brawler: slower, heavier punches
    swordsman: { name: 'Guerrero de tierra', speed: 64, attack: { damage: 12, range: 0, cooldown: 1.3 } },
  },
  water: {
    // Water rider: surfs a slab of ice, the fastest unit; its wave slows everything it hits
    horseman: {
      name: 'Surfista de hielo', speed: 133,
      attack: {
        damage: 7.5, range: 0, cooldown: 1.8, area: 60, knockback: 260, chill: { factor: 0.82, duration: 1.5 },
      },
    },
    // Hydromancer: ice shards that slow the target
    archer: { name: 'Hidromante', attack: { damage: 4.8, range: 160, cooldown: 1.3, chill: { factor: 0.88, duration: 1.2 } } },
    // Water whip: quick, light lashes
    swordsman: { name: 'Guerrero de agua', speed: 74, attack: { damage: 8, range: 0, cooldown: 0.85 } },
  },
};
export const unitStats = (type, civ) => {
  const over = CIV_STATS[civ]?.[type];
  return over ? { ...ENTITY_STATS[type], ...over } : ENTITY_STATS[type];
};
export const MAX_PLAYERS_PER_ROOM = FACTIONS.length; // 10
export const MAX_TEAMS = 4; // team 0 = on your own

// World: square grid of tiles
export const TILE_SIZE = 40;
// Map side in tiles grows with the number of players (big buildings need roomy bases)
export const mapTilesFor = (players) => Math.min(168, Math.max(112, 96 + players * 8));

// Water can't be crossed except over bridges; neither can be built on
export const Terrain = {
  GRASS: 0, SAND: 1, WATER: 2, BRIDGE: 3,
};

// Bases stand on a ring around the map centre, this fraction of the map side away from it
export const SPAWN_RING = 0.36;
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

// Ranking points
export const SCORE = {
  perGathered: 0.1, // per resource unit delivered
  perKill: 10,
  perTrained: 3,
  perBuilding: 10, // per finished building standing
  perUpgrade: 30,
  perAge: 60, // per age advanced
  perCentralSecond: 2, // per second holding the central town center
};

export const EntityType = {
  TOWN_CENTER: 'townCenter',
  BARRACKS: 'barracks',
  TOWER: 'tower',
  HOUSE: 'house',
  FARM: 'farm',
  LUMBER_CAMP: 'lumberCamp',
  MONASTERY: 'monastery',
  WALL: 'wall',
  GATE: 'gate',
  FORTRESS: 'fortress',
  VILLAGER: 'villager',
  SWORDSMAN: 'swordsman',
  ARCHER: 'archer', // elementalist: each civilization's caster (trained at the monastery)
  BOWMAN: 'bowman', // plain archer with a bow (trained at the barracks)
  SPEARMAN: 'spearman', // spear and shield: holds the line against fast units and arrows
  HORSEMAN: 'horseman',
  MONK: 'monk',
  GUARD: 'guard',
};

// Ages, Age of Empires style: every player starts in the first and advances at a town center (it
// can't train villagers meanwhile). Buildings and units have the age they become available in.
export const AGES = [
  { name: 'Edad de la Aldea' },
  { name: 'Edad de la Ciudad', cost: { food: 400 }, time: 50 },
  { name: 'Edad del Imperio', cost: { food: 700, gold: 250 }, time: 70 },
];

// Stats per entity type, shared by server (logic) and client (rendering/UI).
// Buildings: tiles = square footprint, buildTime in seconds (1 villager), trains = units it produces,
// attack = buildings that shoot enemy units in range (towers, town centers), population = pop cap it provides.
// age = first age it can be built/trained in (1 when missing); wall/gate are one-tile pieces placed
// in lines (gates only let their owner's units through).
// Units: trainTime in seconds, speed in px/s, attack range in px (0 = melee), cooldown in seconds,
// aggroRange = distance at which idle soldiers attack enemies on their own.
export const ENTITY_STATS = {
  [EntityType.TOWN_CENTER]: {
    // 7 tiles: the 3D town centers stand on a platform this wide, so units can't walk into them;
    // range is from its middle (220 px past the walls)
    kind: 'building', name: 'Centro urbano', tiles: 7, hp: 2400, cost: { wood: 275, stone: 200 }, buildTime: 60, trains: [EntityType.VILLAGER], age: 2,
    population: 5, attack: { damage: 6, range: 360, cooldown: 3 },
  },
  [EntityType.HOUSE]: {
    kind: 'building', name: 'Casa', tiles: 2, hp: 500, cost: { wood: 30 }, buildTime: 15, population: 5,
  },
  // Farm: a windmill surrounded by crop fields. Villagers assigned to it harvest food until the
  // crops run out; reseeding costs wood.
  [EntityType.FARM]: {
    kind: 'building', name: 'Granja', tiles: 4, hp: 300, cost: { wood: 60 }, buildTime: 20,
    farm: { food: 250, reseedCost: { wood: 40 } },
  },
  // Lumber camp: drop-off for every resource, and researches better gathering (see GATHER_UPGRADES)
  [EntityType.LUMBER_CAMP]: {
    kind: 'building', name: 'Aserradero', tiles: 4, hp: 600, cost: { wood: 100 }, buildTime: 20, dropOff: true,
  },
  [EntityType.MONASTERY]: {
    // Monks and the civilization's two elemental warriors: the elementalist and the flyer/surfer
    kind: 'building', name: 'Monasterio', tiles: 4, hp: 1100, cost: { wood: 175, stone: 75 }, buildTime: 35, age: 2,
    trains: [EntityType.MONK, EntityType.ARCHER, EntityType.HORSEMAN],
  },
  [EntityType.BARRACKS]: {
    // Foot soldiers: melee warriors and bowmen
    kind: 'building', name: 'Cuartel', tiles: 4, hp: 1200, cost: { wood: 150 }, buildTime: 25,
    trains: [EntityType.SPEARMAN, EntityType.SWORDSMAN, EntityType.BOWMAN],
  },
  [EntityType.TOWER]: {
    kind: 'building', name: 'Torre', tiles: 2, age: 2, hp: 350, cost: { wood: 25, stone: 100 }, buildTime: 30,
    attack: { damage: 6, range: 220, cooldown: 1.5 },
  },
  // City walls: 2x2-tile pieces, placed in straight or diagonal lines
  [EntityType.WALL]: {
    kind: 'building', name: 'Muro', tiles: 2, hp: 700, cost: { stone: 5 }, buildTime: 5, age: 2, wall: true,
  },
  // Gate: a wall piece the owner's units walk through
  [EntityType.GATE]: {
    kind: 'building', name: 'Puerta', tiles: 2, hp: 1000, cost: { stone: 25 }, buildTime: 12, age: 2, gate: true,
  },
  // Fortress: the third age's stronghold; shoots arrows and trains every soldier
  [EntityType.FORTRESS]: {
    kind: 'building', name: 'Fortaleza', tiles: 6, hp: 4200, cost: { wood: 200, stone: 400 }, buildTime: 120, age: 3,
    attack: { damage: 7, range: 340, cooldown: 1 },
    trains: [EntityType.SPEARMAN, EntityType.SWORDSMAN, EntityType.BOWMAN, EntityType.ARCHER, EntityType.HORSEMAN],
  },
  [EntityType.VILLAGER]: {
    kind: 'unit', name: 'Aldeano', radius: 10, speed: 78, hp: 25, carryCapacity: 10, cost: { food: 50 }, trainTime: 10,
    attack: { damage: 3, range: 0, cooldown: 1.5 },
  },
  [EntityType.SWORDSMAN]: {
    kind: 'unit', name: 'Espadachín', radius: 11, speed: 70, hp: 60, cost: { food: 60, gold: 20 }, trainTime: 12,
    attack: { damage: 9, range: 0, cooldown: 1 }, aggroRange: 180,
  },
  // Spearman: cheap and sturdy; its spear deals bonus x damage to the fast units (attack.bonus) and its
  // shield lets through only `shield` of ranged damage
  [EntityType.SPEARMAN]: {
    kind: 'unit', name: 'Lancero', radius: 11, speed: 66, hp: 70, cost: { food: 35, wood: 25 }, trainTime: 11, shield: 0.6,
    attack: { damage: 6, range: 0, cooldown: 1.25, bonus: { horseman: 4 } }, aggroRange: 190,
  },
  // Elementalist (air: gusts from two fans); the other civilizations' casters in CIV_STATS
  [EntityType.ARCHER]: {
    kind: 'unit', name: 'Místico del viento', radius: 10, speed: 74, hp: 35, cost: { food: 40, gold: 45 }, trainTime: 15, age: 2,
    attack: { damage: 5.8, range: 160, cooldown: 1.4 }, aggroRange: 220,
  },
  // Bowman: the same for every civilization; cheaper than an elementalist, plain arrows a little further
  [EntityType.BOWMAN]: {
    kind: 'unit', name: 'Arquero', radius: 10, speed: 74, hp: 35, cost: { food: 30, wood: 40 }, trainTime: 12,
    attack: { damage: 4.6, range: 175, cooldown: 1.5 }, aggroRange: 235,
  },
  [EntityType.HORSEMAN]: {
    // Wind flyer: flies when moving; attacks by diving onto the target, and the impact gust hits every
    // enemy unit around it, shoves them away and stuns them for `stun` seconds
    kind: 'unit', name: 'Volador', radius: 13, speed: 117, hp: 100, cost: { food: 80, gold: 60 }, trainTime: 18, age: 2,
    attack: { damage: 8, range: 0, cooldown: 1.6, area: 60, knockback: 480, stun: 1 }, aggroRange: 200,
  },
  // Monks don't fight: they walk up to hurt friendly units nearby and heal them
  [EntityType.MONK]: {
    kind: 'unit', name: 'Monje', radius: 10, speed: 62, hp: 30, cost: { gold: 80 }, trainTime: 16, age: 2,
    heal: { amount: 4, range: 90, cooldown: 1, searchRange: 260 },
  },
  // Neutral knights guarding the central town center; can't be trained
  [EntityType.GUARD]: {
    kind: 'unit', name: 'Caballero guardián', radius: 13, speed: 109, hp: 220,
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
export const SHEEP = { speed: 43, radius: 9, captureRange: 150, idleDistance: 70 };

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
