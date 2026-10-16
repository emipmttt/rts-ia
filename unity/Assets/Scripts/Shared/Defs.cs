using System.Collections.Generic;
using System.Linq;

// Port of shared/constants.js and shared/rules.js. Must stay in sync with the server, which is the
// authority for every rule; the client only uses these for display, previews and validation hints.
namespace RTS
{
    public static class C
    {
        public const int TileSize = 40;
        public const float PxToUnit = 1f / TileSize; // 1 Unity unit = 1 tile
        public const int MaxTrainQueue = 5;
        public const int MaxPopulation = 300;
        public const float CentralControlTime = 180;
        public const int DefaultPort = 3001;

        public static readonly (string id, int color)[] Factions =
        {
            ("blue", 0x6c9bd6), ("red", 0xd9776d), ("yellow", 0xe2bf5c), ("purple", 0xa489c8), ("black", 0x7e8794),
            ("green", 0x7dbd6c), ("orange", 0xe8975a), ("teal", 0x5cbcb8), ("pink", 0xe08ab8), ("brown", 0xa8835e),
        };
        public static readonly (string id, string name)[] Civilizations = { ("air", "Aire"), ("fire", "Fuego"), ("earth", "Tierra"), ("water", "Agua") };
    }

    public static class Terrain
    {
        public const int Grass = 0, Sand = 1, Water = 2, Bridge = 3;
    }

    public class Cost : Dictionary<string, int>
    {
        public Cost() { }
        public Cost(params (string k, int v)[] items) { foreach (var (k, v) in items) this[k] = v; }
    }

    public class AttackStats
    {
        public float damage, range, cooldown, area, knockback, stun;
        public bool burn;
        public float chill;        // speed factor of slowed targets (0 = no ice)
        public float line;         // width of the geomancer's line of spikes (0 = none)
        public float vsBuildings = 1;
        public float vsFast = 1;   // damage multiplier against the fast units (horseman)
    }

    public class HealStats { public float amount, range, cooldown, searchRange; }

    public class Stats
    {
        public string kind, name;
        public int tiles, hp;
        public Cost cost = new Cost();
        public float buildTime, trainTime;
        public string[] trains;   // units it produces, in button order
        public int population;
        public AttackStats attack;
        public HealStats heal;
        public bool dropOff;
        public int farmFood;
        public Cost reseedCost;
        public float radius, speed;
        public int carryCapacity;
        public float aggroRange;
        public int age = 1;        // first age it can be built/trained in
        public bool wall, gate;    // one-tile wall pieces
        public float shield = 1;   // share of ranged damage that gets through
        public bool IsBuilding => kind == "building";
        public bool IsFarm => farmFood > 0;

        public Stats With(string name, AttackStats attack, float? speed = null) => new Stats
        {
            kind = kind, name = name, tiles = tiles, hp = hp, cost = cost, buildTime = buildTime, trainTime = trainTime,
            trains = trains, population = population, attack = attack, heal = heal, dropOff = dropOff, farmFood = farmFood,
            reseedCost = reseedCost, radius = radius, speed = speed ?? this.speed, carryCapacity = carryCapacity, aggroRange = aggroRange,
            age = age, wall = wall, gate = gate, shield = shield,
        };
    }

    public static class Defs
    {
        public static readonly Dictionary<string, Stats> Entity = new Dictionary<string, Stats>
        {
            ["townCenter"] = new Stats { kind = "building", name = "Centro urbano", tiles = 7, hp = 2400, cost = new Cost(("wood", 275), ("stone", 200)), buildTime = 60, trains = new[] { "villager" }, age = 2, population = 5, attack = new AttackStats { damage = 6, range = 360, cooldown = 3 } },
            ["house"] = new Stats { kind = "building", name = "Casa", tiles = 2, hp = 500, cost = new Cost(("wood", 30)), buildTime = 15, population = 5 },
            ["farm"] = new Stats { kind = "building", name = "Granja", tiles = 4, hp = 300, cost = new Cost(("wood", 60)), buildTime = 20, farmFood = 250, reseedCost = new Cost(("wood", 40)) },
            ["lumberCamp"] = new Stats { kind = "building", name = "Aserradero", tiles = 4, hp = 600, cost = new Cost(("wood", 100)), buildTime = 20, dropOff = true },
            ["monastery"] = new Stats { kind = "building", name = "Monasterio", tiles = 4, hp = 1100, cost = new Cost(("wood", 175), ("stone", 75)), buildTime = 35, age = 2, trains = new[] { "monk", "archer", "horseman" } },
            ["barracks"] = new Stats { kind = "building", name = "Cuartel", tiles = 4, hp = 1200, cost = new Cost(("wood", 150)), buildTime = 25, trains = new[] { "spearman", "swordsman", "bowman" } },
            ["tower"] = new Stats { kind = "building", name = "Torre", tiles = 2, age = 2, hp = 350, cost = new Cost(("wood", 25), ("stone", 100)), buildTime = 30, attack = new AttackStats { damage = 6, range = 220, cooldown = 1.5f } },
            ["wall"] = new Stats { kind = "building", name = "Muro", tiles = 2, hp = 700, cost = new Cost(("stone", 5)), buildTime = 5, age = 2, wall = true },
            ["gate"] = new Stats { kind = "building", name = "Puerta", tiles = 2, hp = 1000, cost = new Cost(("stone", 25)), buildTime = 12, age = 2, gate = true },
            ["fortress"] = new Stats { kind = "building", name = "Fortaleza", tiles = 6, hp = 4200, cost = new Cost(("wood", 200), ("stone", 400)), buildTime = 120, age = 3, attack = new AttackStats { damage = 7, range = 340, cooldown = 1 }, trains = new[] { "spearman", "swordsman", "bowman", "archer", "horseman" } },
            ["villager"] = new Stats { kind = "unit", name = "Aldeano", radius = 10, speed = 78, hp = 25, carryCapacity = 10, cost = new Cost(("food", 50)), trainTime = 10, attack = new AttackStats { damage = 3, range = 0, cooldown = 1.5f } },
            ["swordsman"] = new Stats { kind = "unit", name = "Espadachín", radius = 11, speed = 70, hp = 60, cost = new Cost(("food", 60), ("gold", 20)), trainTime = 12, attack = new AttackStats { damage = 9, range = 0, cooldown = 1 }, aggroRange = 180 },
            ["spearman"] = new Stats { kind = "unit", name = "Lancero", radius = 11, speed = 66, hp = 70, cost = new Cost(("food", 35), ("wood", 25)), trainTime = 11, shield = 0.6f, attack = new AttackStats { damage = 6, range = 0, cooldown = 1.25f, vsFast = 4 }, aggroRange = 190 },
            ["archer"] = new Stats { kind = "unit", name = "Místico del viento", radius = 10, speed = 74, hp = 35, cost = new Cost(("food", 40), ("gold", 45)), trainTime = 15, age = 2, attack = new AttackStats { damage = 5.8f, range = 230, cooldown = 1.4f }, aggroRange = 290 },
            ["bowman"] = new Stats { kind = "unit", name = "Arquero", radius = 10, speed = 74, hp = 35, cost = new Cost(("food", 30), ("wood", 40)), trainTime = 12, attack = new AttackStats { damage = 4.6f, range = 250, cooldown = 1.5f }, aggroRange = 310 },
            ["horseman"] = new Stats { kind = "unit", name = "Volador", radius = 13, speed = 117, hp = 100, cost = new Cost(("food", 80), ("gold", 60)), trainTime = 18, age = 2, attack = new AttackStats { damage = 8, range = 0, cooldown = 1.6f, area = 60, knockback = 480, stun = 1 }, aggroRange = 200 },
            ["monk"] = new Stats { kind = "unit", name = "Monje", radius = 10, speed = 62, hp = 30, cost = new Cost(("gold", 80)), trainTime = 16, age = 2, heal = new HealStats { amount = 4, range = 90, cooldown = 1, searchRange = 260 } },
            ["guard"] = new Stats { kind = "unit", name = "Caballero guardián", radius = 13, speed = 109, hp = 220, attack = new AttackStats { damage = 14, range = 0, cooldown = 1.1f }, aggroRange = 260 },
        };

        // Civilization overrides (CIV_STATS in shared/constants.js)
        static readonly Dictionary<string, Dictionary<string, Stats>> CivStats = new Dictionary<string, Dictionary<string, Stats>>
        {
            ["fire"] = new Dictionary<string, Stats>
            {
                ["horseman"] = Entity["horseman"].With("Volador de fuego", new AttackStats { damage = 8, range = 0, cooldown = 2.4f, area = 60, knockback = 480, burn = true }),
                ["archer"] = Entity["archer"].With("Mago de fuego", new AttackStats { damage = 6.2f, range = 230, cooldown = 2, burn = true }),
                ["swordsman"] = Entity["swordsman"].With("Espadachín de fuego", new AttackStats { damage = 10, range = 0, cooldown = 1.15f }),
            },
            ["earth"] = new Dictionary<string, Stats>
            {
                ["horseman"] = Entity["horseman"].With("Surfista de roca", new AttackStats { damage = 11, range = 0, cooldown = 2, area = 55, knockback = 320 }, 129),
                ["archer"] = Entity["archer"].With("Geomante", new AttackStats { damage = 7.2f, range = 230, cooldown = 2.2f, line = 16, vsBuildings = 3 }),
                ["swordsman"] = Entity["swordsman"].With("Guerrero de tierra", new AttackStats { damage = 12, range = 0, cooldown = 1.3f }, 64),
            },
            ["water"] = new Dictionary<string, Stats>
            {
                ["horseman"] = Entity["horseman"].With("Surfista de hielo", new AttackStats { damage = 7.5f, range = 0, cooldown = 1.8f, area = 60, knockback = 260, chill = 0.82f }, 133),
                ["archer"] = Entity["archer"].With("Hidromante", new AttackStats { damage = 4.8f, range = 230, cooldown = 1.3f, chill = 0.88f }),
                ["swordsman"] = Entity["swordsman"].With("Guerrero de agua", new AttackStats { damage = 8, range = 0, cooldown = 0.85f }, 74),
            },
        };

        public static Stats UnitStats(string type, string civ)
        {
            if (civ != null && CivStats.TryGetValue(civ, out var over) && over.TryGetValue(type, out var s)) return s;
            return Entity[type];
        }

        // Build menu order: by the age they unlock in
        public static readonly string[] Buildable =
            { "house", "lumberCamp", "barracks", "farm", "townCenter", "monastery", "tower", "wall", "gate", "fortress" };

        // AGES in shared/constants.js
        public static readonly (string name, Cost cost, float time)[] Ages =
        {
            ("Edad de la Aldea", null, 0),
            ("Edad de la Ciudad", new Cost(("food", 400)), 50),
            ("Edad del Imperio", new Cost(("food", 700), ("gold", 250)), 70),
        };
        public static readonly string[] AgeNumerals = { "I", "II", "III" };

        public const int WallStep = 2; // wall pieces are 2x2 tiles

        // Walls and gates sit on a fixed grid of 2x2 cells so pieces always line up (snapWall in shared/rules.js)
        public static int SnapWall(int v) => (int)System.Math.Floor(v / (double)WallStep) * WallStep;

        // Tiles a wall piece takes: the free ones of its cell; it fills round trees, mines, water and
        // buildings (wallCells in shared/rules.js)
        public static List<(int x, int y)> WallCells(int tx, int ty, System.Func<int, int, bool> isWallBlocked, int mapTiles) =>
            Footprint("wall", tx, ty).Where(c => c.x >= 0 && c.y >= 0 && c.x < mapTiles && c.y < mapTiles && !isWallBlocked(c.x, c.y)).ToList();

        // Top-left tiles of the pieces of a wall dragged between two tiles: an 8-connected line of
        // 2x2 pieces (wallLine in shared/rules.js)
        static int JsRound(double v) => (int)System.Math.Floor(v + 0.5);
        public static List<(int x, int y)> WallLine(int x0, int y0, int x1, int y1, int max = 20)
        {
            x0 = SnapWall(x0); y0 = SnapWall(y0); x1 = SnapWall(x1); y1 = SnapWall(y1);
            var cells = new List<(int, int)>();
            int ex = JsRound((x1 - x0) / (double)WallStep), ey = JsRound((y1 - y0) / (double)WallStep);
            int n = System.Math.Max(System.Math.Abs(ex), System.Math.Abs(ey));
            for (int i = 0; i <= n && cells.Count < max; i++)
            {
                double t = n == 0 ? 0 : (double)i / n;
                var c = (x0 + WallStep * JsRound(ex * t), y0 + WallStep * JsRound(ey * t));
                if (cells.Count == 0 || cells[cells.Count - 1] != c) cells.Add(c);
            }
            return cells;
        }

        public static readonly (string name, float bonus, Cost cost, float time)[] GatherUpgrades =
        {
            ("Herramientas de hierro", 1.25f, new Cost(("food", 100), ("wood", 100)), 30),
            ("Herramientas de acero", 1.5f, new Cost(("food", 200), ("wood", 150), ("gold", 50)), 45),
            ("Carretillas", 1.8f, new Cost(("food", 300), ("wood", 200), ("gold", 100)), 60),
        };

        public const float SheepRadius = 9;

        public static readonly Dictionary<string, string> ResourceNames = new Dictionary<string, string>
        {
            ["food"] = "comida", ["wood"] = "madera", ["gold"] = "oro", ["stone"] = "piedra",
        };

        // ---- rules.js ----
        public static bool IsBuilding(string type) => type != null && Entity.TryGetValue(type, out var s) && s.IsBuilding;
        public static float BuildingSize(string type) => Entity[type].tiles * C.TileSize;

        // Buildings that shoot reach this much further with each age past the first (shared/constants.js)
        public const float AgeRangeBonus = 45;
        public static float BuildingRange(string type, int age) => Entity[type].attack.range + AgeRangeBonus * System.Math.Max(0, age - 1);

        // Every building sees this much further with each age past the first
        public const float AgeSightBonus = 0.15f;

        // Line of sight in px for the fog of war (client only): soldiers see a bit past the archers'
        // range so they spot who shoots them; archers see past their own; town centers and towers
        // watch over the base
        static readonly Dictionary<string, float> Sights = new Dictionary<string, float>
        {
            ["villager"] = 200, ["swordsman"] = 270, ["spearman"] = 270, ["archer"] = 310, ["bowman"] = 330, ["horseman"] = 300, ["monk"] = 240, ["guard"] = 260,
            ["townCenter"] = 520, ["tower"] = 340, ["house"] = 170, ["farm"] = 150,
            ["wall"] = 80, ["gate"] = 110, ["fortress"] = 440,
        };
        public const float SheepSight = 90;
        public static float Sight(string type) => Sights.TryGetValue(type, out var s) ? s : IsBuilding(type) ? 230 : 200;
        public static float Sight(string type, int age) => Sight(type) * (IsBuilding(type) ? 1 + AgeSightBonus * System.Math.Max(0, age - 1) : 1);

        public static (int tx, int ty) TileForCenter(string type, float x, float y)
        {
            float half = Entity[type].tiles / 2f;
            return (UnityEngine.Mathf.RoundToInt(x / C.TileSize - half), UnityEngine.Mathf.RoundToInt(y / C.TileSize - half));
        }

        public static IEnumerable<(int x, int y)> Footprint(string type, int tx, int ty)
        {
            int n = Entity[type].tiles;
            for (int y = ty; y < ty + n; y++) for (int x = tx; x < tx + n; x++) yield return (x, y);
        }

        public static bool CanPlace(string type, int tx, int ty, System.Func<int, int, bool> isBlocked, int mapTiles) =>
            Footprint(type, tx, ty).All(c => c.x >= 0 && c.y >= 0 && c.x < mapTiles && c.y < mapTiles && !isBlocked(c.x, c.y));

        public static bool CanAfford(Dictionary<string, int> stock, Cost cost) =>
            cost.All(kv => stock != null && stock.TryGetValue(kv.Key, out var have) && have >= kv.Value);

        public static string FormatCost(Cost cost) =>
            string.Join(", ", cost.Select(kv => $"{kv.Value} {(ResourceNames.TryGetValue(kv.Key, out var n) ? n : kv.Key)}"));

        public static string FormatTime(float seconds) => $"{(int)(seconds / 60)}:{(int)(seconds % 60):00}";
    }
}
