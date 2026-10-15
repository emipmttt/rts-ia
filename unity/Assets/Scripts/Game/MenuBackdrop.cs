using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using RTS.UI;

// Behind the main menu: two villages on a small map, run locally (no server). Villagers chop wood,
// mine gold and raise a house; every few seconds each barracks sends out a squad that marches to the
// middle, shouts its battle cry and fights the other side's. It feeds the real GameView with the same
// state format the server sends, so everything looks and animates exactly as in a game. A slow
// cinematic camera drifts over it and cuts to a new angle every few seconds behind a soft fade.
namespace RTS.Game
{
    public class MenuBackdrop : MonoBehaviour
    {
        const int N = 64;                       // map side in tiles
        const float T = C.TileSize, Dt = 0.05f;  // server px per tile; simulation step (20 Hz like the server)
        const int MaxSoldiers = 11;              // per side
        const float SquadEvery = 9;              // seconds between squads
        const float ShotLength = 9, FadeTime = 0.9f;

        GameView view;
        int nextId = 1;
        float acc, squadTimer = 2, shotTimer, fade = 1, fadeTarget;
        int shotIndex = -1;
        (Vector2 from, Vector2 to, float yaw, float yawDrift, float dist, float distTo) shot;
        float shotTime;

        class Side { public string id, civ, faction; public int color, age; public Vector2 barracksFront, rally, tc, camp; }
        class Building { public int id; public string type, owner; public int tx, ty; public float hp; public bool built = true; public float progress = 1; public Vector2 Center => new Vector2((tx + Defs.Entity[type].tiles / 2f) * T, (ty + Defs.Entity[type].tiles / 2f) * T); }
        class Worker { public int id; public Side side; public Vector2 pos, work, drop; public int resId; public string kind; public int state; public float timer; public int carry; public int buildingId; }
        class Soldier { public int id; public Side side; public string type; public Vector2 pos, goal; public float hp, maxHp, cd, cheer; public bool cheered; public int? target; public string action = "idle"; }

        readonly Side[] sides = new Side[2];
        readonly List<Building> buildings = new List<Building>();
        readonly List<Worker> workers = new List<Worker>();
        readonly List<Soldier> soldiers = new List<Soldier>();
        readonly List<JObject> resources = new List<JObject>();
        readonly JArray shots = new JArray();
        Building house; // the one being built
        float houseDoneAt = -1;

        public static MenuBackdrop Create(Camera cam)
        {
            var go = new GameObject("MenuBackdropDriver");
            var b = go.AddComponent<MenuBackdrop>();
            b.Build(cam);
            return b;
        }

        void Build(Camera cam)
        {
            // Two different civilizations, colours and ages each time the menu opens
            var civs = C.Civilizations.Select(c => c.id).OrderBy(_ => Random.value).Take(2).ToArray();
            var factions = C.Factions.OrderBy(_ => Random.value).Take(2).ToArray();
            int age = Random.Range(1, 4);
            for (int i = 0; i < 2; i++)
                sides[i] = new Side { id = "menu-" + i, civ = civs[i], faction = factions[i].id, color = factions[i].color, age = age };

            // Grass with a sandy patch and a little brook crossing the middle under a bridge
            var tiles = new int[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    int brook = Mathf.RoundToInt(N / 2 + Mathf.Sin(y * 0.18f) * 2.2f);
                    bool water = Mathf.Abs(x - brook) <= 0 && (y < N / 2 - 3 || y > N / 2 + 3) && y > 4 && y < N - 5;
                    tiles[y * N + x] = water ? 2 : Mathf.Abs(x - brook) <= 1 && (y < N / 2 - 3 || y > N / 2 + 3) && y > 4 && y < N - 5 ? 1 : 0;
                }

            // Forest along the top and bottom edges plus clumps; mines by each town center
            var taken = new HashSet<int>();
            void AddRes(string type, int tx, int ty, string variant = null)
            {
                if (tx < 0 || ty < 0 || tx >= N || ty >= N || tiles[ty * N + tx] == 2 || !taken.Add(ty * N + tx)) return;
                resources.Add(new JObject { ["id"] = nextId++, ["type"] = type, ["variant"] = variant, ["tx"] = tx, ["ty"] = ty, ["amount"] = 300, ["max"] = 300 });
            }

            // Bases: mirrored left and right
            for (int i = 0; i < 2; i++)
            {
                var s = sides[i];
                int Mx(int tx, string type) => i == 0 ? tx : N - tx - Defs.Entity[type].tiles;
                int Mt(int tx) => i == 0 ? tx : N - 1 - tx;
                Building B(string type, int tx, int ty, bool built = true)
                {
                    var b = new Building { id = nextId++, type = type, owner = s.id, tx = Mx(tx, type), ty = ty, hp = Defs.Entity[type].hp, built = built, progress = built ? 1 : 0 };
                    buildings.Add(b);
                    for (int y = b.ty; y < b.ty + Defs.Entity[type].tiles; y++) for (int x = b.tx; x < b.tx + Defs.Entity[type].tiles; x++) taken.Add(y * N + x);
                    return b;
                }
                var tc = B("townCenter", 6, 28);
                B("house", 5, 23); B("house", 8, 23); B("house", 5, 37);
                var barracks = B("barracks", 16, 22);
                B("farm", 15, 35);
                var camp = B("lumberCamp", 6, 14);
                if (age >= 2) B("tower", 18, 29);
                if (i == 0) house = B("house", 11, 38, false);
                s.tc = tc.Center;
                s.camp = camp.Center;
                var bf = barracks.Center;
                s.barracksFront = new Vector2(bf.x + (i == 0 ? 1 : -1) * 90, bf.y + 40);
                s.rally = new Vector2(N * T / 2 + (i == 0 ? -1 : 1) * 160, N * T / 2 + 40);

                // Trees behind the lumber camp; gold and stone beside the town center
                for (int k = 0; k < 26; k++) AddRes("wood", Mt(2 + k % 9), 8 + k / 9 + (k % 3 == 0 ? 1 : 0));
                for (int k = 0; k < 4; k++) AddRes("gold", Mt(3 + k), 40 + (k % 2));
                for (int k = 0; k < 3; k++) AddRes("stone", Mt(14 + k), 41);
            }
            for (int x = 0; x < N; x++) for (int d = 0; d < 3; d++) { if ((x + d) % 3 != 0) { AddRes("wood", x, d); AddRes("wood", x, N - 1 - d); } }
            for (int k = 0; k < 18; k++) AddRes("wood", Random.Range(24, 40), Random.Range(6, 14));
            for (int k = 0; k < 18; k++) AddRes("wood", Random.Range(24, 40), Random.Range(48, 57));
            for (int k = 0; k < 12; k++) AddRes("wood", Random.Range(4, N - 4), Random.Range(4, N - 4), "bush");

            // Villagers: woodcutters, gold miners and a builder per side
            foreach (var s in sides)
            {
                var trees = resources.Where(r => (string)r["type"] == "wood" && (string)r["variant"] == null)
                    .OrderBy(r => Vector2.Distance(Tile(r), s.camp)).Take(5).ToList();
                foreach (var t in trees.Take(4)) workers.Add(new Worker { id = nextId++, side = s, pos = s.camp + Random.insideUnitCircle * 40, work = Tile(t), drop = s.camp, resId = (int)t["id"], kind = "wood", timer = Random.value * 3 });
                var gold = resources.Where(r => (string)r["type"] == "gold").OrderBy(r => Vector2.Distance(Tile(r), s.tc)).Take(2).ToList();
                foreach (var g in gold) workers.Add(new Worker { id = nextId++, side = s, pos = s.tc + Random.insideUnitCircle * 60, work = Tile(g), drop = s.tc, resId = (int)g["id"], kind = "gold", timer = Random.value * 3 });
            }
            workers.Add(new Worker { id = nextId++, side = sides[0], pos = house.Center + new Vector2(60, 0), kind = "build", buildingId = house.id });

            var start = new JObject
            {
                ["map"] = new JObject { ["width"] = N * T, ["height"] = N * T, ["tiles"] = new JArray(tiles) },
                ["resources"] = new JArray(resources),
                ["players"] = new JArray(sides.Select(PlayerJson)),
                ["sheep"] = new JArray(),
            };
            view = GameView.CreateDemo(start, cam);
            // A few soldiers already out so the first shot has a fight in it
            for (int i = 0; i < 2; i++) for (int k = 0; k < 4; k++) SpawnSoldier(sides[i], sides[i].rally + new Vector2((i == 0 ? -1 : 1) * Random.Range(40, 220), Random.Range(-120, 120)));
            Step();
            NextShot(true);
        }

        static Vector2 Tile(JObject r) => new Vector2(((int)r["tx"] + 0.5f) * T, ((int)r["ty"] + 0.5f) * T);

        JObject PlayerJson(Side s) => new JObject
        {
            ["id"] = s.id, ["name"] = s.civ, ["faction"] = s.faction, ["color"] = s.color, ["civ"] = s.civ, ["age"] = s.age,
            ["team"] = 0, ["pop"] = 0, ["popCap"] = 0, ["stock"] = new JObject(), ["connected"] = true,
        };

        static readonly string[] SquadTypes = { "spearman", "swordsman", "swordsman", "bowman", "archer", "horseman", "spearman", "bowman", "monk" };

        void SpawnSoldier(Side s, Vector2? at = null)
        {
            var type = SquadTypes[Random.Range(0, SquadTypes.Length)];
            var st = Defs.UnitStats(type, s.civ);
            soldiers.Add(new Soldier
            {
                id = nextId++, side = s, type = type, pos = at ?? s.barracksFront + Random.insideUnitCircle * 30, hp = st.hp, maxHp = st.hp,
                goal = s.rally + new Vector2(Random.Range(-60, 60), Random.Range(-100, 100)),
            });
        }

        void Update()
        {
            if (view == null) return;
            acc += Mathf.Min(Time.deltaTime, 0.25f);
            while (acc >= Dt) { acc -= Dt; Step(); }
            UpdateCamera(Time.deltaTime);
        }

        // ---------- Simulation ----------

        void Step()
        {
            float now = Time.time;
            squadTimer -= Dt;
            if (squadTimer <= 0)
            {
                squadTimer = SquadEvery;
                foreach (var s in sides)
                {
                    int have = soldiers.Count(x => x.side == s);
                    for (int k = 0; k < 3 && have + k < MaxSoldiers; k++) SpawnSoldier(s);
                }
            }

            foreach (var w in workers) StepWorker(w);
            foreach (var u in soldiers) StepSoldier(u);
            soldiers.RemoveAll(u => u.hp <= 0);
            Separate();

            // The house under construction rises, stands finished a while, then starts over
            if (house != null)
            {
                if (!house.built)
                {
                    house.progress = Mathf.Min(1, house.progress + Dt / 30);
                    house.hp = Mathf.Max(1, Defs.Entity["house"].hp * house.progress);
                    if (house.progress >= 1) { house.built = true; houseDoneAt = now; }
                }
                else if (houseDoneAt > 0 && now - houseDoneAt > 12) { house.built = false; house.progress = 0; houseDoneAt = -1; }
            }

            view.ApplyState(new JObject
            {
                ["players"] = new JArray(sides.Select(PlayerJson)),
                ["sheep"] = new JArray(),
                ["entities"] = new JArray(buildings.Select(BuildingJson).Concat(workers.Select(WorkerJson)).Concat(soldiers.Select(SoldierJson))),
            });
            if (shots.Count > 0) { view.AddShots(new JArray(shots)); shots.Clear(); }
        }

        JObject BuildingJson(Building b)
        {
            var c = b.Center;
            var o = new JObject { ["id"] = b.id, ["type"] = b.type, ["owner"] = b.owner, ["x"] = c.x, ["y"] = c.y, ["hp"] = b.hp, ["tx"] = b.tx, ["ty"] = b.ty };
            if (!b.built) { o["built"] = false; o["buildProgress"] = b.progress; }
            if (b.type == "farm") o["food"] = 250;
            return o;
        }

        JObject WorkerJson(Worker w)
        {
            var o = new JObject { ["id"] = w.id, ["type"] = "villager", ["owner"] = w.side.id, ["x"] = w.pos.x, ["y"] = w.pos.y, ["hp"] = 25 };
            bool working = w.state == 1;
            if (w.kind == "build")
            {
                bool building = house != null && !house.built;
                o["action"] = building ? "building" : "idle";
                if (building) { o["task"] = "build"; o["buildingId"] = w.buildingId; }
                return o;
            }
            o["action"] = working ? "gathering" : w.state == 3 ? "idle" : "moving";
            o["task"] = "gather";
            o["resourceId"] = w.resId;
            if (w.carry > 0 || working) o["carry"] = new JObject { ["type"] = w.kind, ["amount"] = w.carry };
            return o;
        }

        JObject SoldierJson(Soldier u)
        {
            var o = new JObject { ["id"] = u.id, ["type"] = u.type, ["owner"] = u.side.id, ["x"] = u.pos.x, ["y"] = u.pos.y, ["hp"] = u.hp, ["action"] = u.action };
            if (u.target != null) { o["task"] = u.type == "monk" ? "heal" : "attack"; o["targetId"] = u.target; }
            return o;
        }

        bool MoveTo(ref Vector2 pos, Vector2 to, float speed, float stopAt = 4)
        {
            var d = to - pos;
            float len = d.magnitude;
            if (len <= stopAt) return true;
            pos += d / len * Mathf.Min(len - stopAt + 0.01f, speed * Dt);
            return false;
        }

        // Walk to the resource, work a few seconds, carry the load back, drop it, repeat
        void StepWorker(Worker w)
        {
            if (w.kind == "build")
            {
                if (house != null) MoveTo(ref w.pos, house.Center + new Vector2(55, 10), 78);
                return;
            }
            switch (w.state)
            {
                case 0: if (MoveTo(ref w.pos, w.work, 78, 26)) { w.state = 1; w.timer = 3.5f + Random.value * 2; } break;
                case 1: w.timer -= Dt; w.carry = Mathf.Min(10, w.carry + 1); if (w.timer <= 0) { w.state = 2; w.carry = 10; } break;
                case 2: if (MoveTo(ref w.pos, w.drop, 78, 60)) { w.state = 3; w.timer = 0.4f; w.carry = 0; } break;
                case 3: w.timer -= Dt; if (w.timer <= 0) w.state = 0; break;
            }
        }

        Soldier Closest(Soldier u, bool enemy, float range)
        {
            Soldier best = null;
            float bd = range;
            foreach (var o in soldiers)
            {
                if (o == u || o.hp <= 0 || (o.side != u.side) != enemy) continue;
                if (!enemy && o.hp >= o.maxHp) continue;
                float d = Vector2.Distance(o.pos, u.pos);
                if (d < bd) { bd = d; best = o; }
            }
            return best;
        }

        // March to the rally point, shout when an enemy comes near, close in and fight; monks heal
        void StepSoldier(Soldier u)
        {
            var st = Defs.UnitStats(u.type, u.side.civ);
            u.cd = Mathf.Max(0, u.cd - Dt);
            if (u.cheer > 0) { u.cheer -= Dt; u.action = "cheering"; return; }
            if (u.type == "monk")
            {
                var hurt = Closest(u, false, 260);
                u.target = hurt?.id;
                if (hurt == null) { u.action = MoveTo(ref u.pos, u.goal - new Vector2(u.side == sides[0] ? 60 : -60, 0), st.speed) ? "idle" : "moving"; return; }
                if (!MoveTo(ref u.pos, hurt.pos, st.speed, st.heal.range * 0.8f)) { u.action = "moving"; return; }
                u.action = "healing";
                if (u.cd <= 0) { u.cd = st.heal.cooldown; hurt.hp = Mathf.Min(hurt.maxHp, hurt.hp + st.heal.amount); }
                return;
            }
            var foe = Closest(u, true, 420);
            u.target = foe?.id;
            if (foe == null) { u.action = MoveTo(ref u.pos, u.goal, st.speed) ? "idle" : "moving"; return; }
            if (!u.cheered && Vector2.Distance(foe.pos, u.pos) > st.attack.range + 80) { u.cheered = true; u.cheer = 0.9f; u.action = "cheering"; return; }
            float reach = st.attack.range > 0 ? st.attack.range : st.radius * 2 + 12;
            if (!MoveTo(ref u.pos, foe.pos, st.speed, reach)) { u.action = "moving"; return; }
            u.action = "attacking";
            if (u.cd > 0) return;
            u.cd = st.attack.cooldown;
            Hit(u, foe, st.attack);
        }

        void Hit(Soldier u, Soldier foe, AttackStats a)
        {
            float dmg = a.damage * (foe.type == "horseman" ? a.vsFast : 1);
            if (a.area > 0)
            {
                shots.Add(new JObject { ["x"] = u.pos.x, ["y"] = u.pos.y, ["targetId"] = foe.id, ["kind"] = "blast", ["radius"] = a.area, ["attackerId"] = u.id, ["fire"] = a.burn, ["element"] = u.side.civ });
                foreach (var o in soldiers) if (o.side != u.side && Vector2.Distance(o.pos, foe.pos) <= a.area) o.hp -= dmg;
                return;
            }
            if (a.range > 0)
            {
                string kind = u.type == "bowman" ? "bowman" : u.side.civ == "fire" ? "fireball" : u.side.civ == "water" ? "ice" : u.side.civ == "earth" ? "earthLine" : "archer";
                var shotJson = new JObject { ["x"] = u.pos.x, ["y"] = u.pos.y, ["targetId"] = foe.id, ["kind"] = kind, ["attackerId"] = u.id };
                if (kind == "earthLine")
                {
                    var dir = (foe.pos - u.pos).normalized;
                    var end = foe.pos + dir * 30;
                    shotJson["tx"] = end.x; shotJson["ty"] = end.y;
                }
                shots.Add(shotJson);
            }
            foe.hp -= dmg;
        }

        // Keep bodies from piling up on one spot
        void Separate()
        {
            for (int i = 0; i < soldiers.Count; i++)
                for (int j = i + 1; j < soldiers.Count; j++)
                {
                    var a = soldiers[i]; var b = soldiers[j];
                    var d = b.pos - a.pos;
                    float len = d.magnitude, min = 24;
                    if (len >= min || len < 0.001f) continue;
                    var push = d / len * (min - len) * 0.5f;
                    a.pos -= push; b.pos += push;
                }
        }

        // ---------- Camera ----------

        // Slow drifts over the villages and the battle; each shot fades out into the next
        void NextShot(bool instant)
        {
            shotIndex = (shotIndex + 1) % 6;
            float mid = N * T / 2;
            var a = sides[0]; var b = sides[1];
            var fight = soldiers.Count > 0 ? soldiers.Aggregate(Vector2.zero, (s, u) => s + u.pos) / soldiers.Count : new Vector2(mid, mid);
            switch (shotIndex)
            {
                case 0: shot = (fight + new Vector2(-260, 60), fight + new Vector2(260, 60), 10, 12, 15, 13); break;          // along the battle line
                case 1: shot = (a.tc + new Vector2(-80, 120), a.camp + new Vector2(60, 80), -30, -15, 11, 10); break;      // low over a village at work
                case 2: shot = (new Vector2(mid, mid - 300), new Vector2(mid, mid + 300), 180, 20, 30, 34); break;         // high, from behind the brook
                case 3: shot = (b.tc + new Vector2(80, 60), b.barracksFront, 40, 18, 12, 14); break;                        // the other village, troops leaving
                case 4: shot = (fight + new Vector2(0, -120), fight + new Vector2(0, 120), 90, -25, 9, 10); break;          // close in the melee
                default: shot = (a.camp, b.camp, -10, 10, 40, 42); break;                                                  // the whole valley
            }
            shotTime = 0;
            view.Camera.SetShot(shot.from.x, shot.from.y, shot.yaw, shot.dist, instant);
        }

        void UpdateCamera(float dt)
        {
            shotTime += dt;
            float k = Mathf.Clamp01(shotTime / ShotLength);
            float e = k * k * (3 - 2 * k);
            var p = Vector2.Lerp(shot.from, shot.to, e);
            view.Camera.SetShot(p.x, p.y, shot.yaw + shot.yawDrift * e, Mathf.Lerp(shot.dist, shot.distTo, e), false);
            // Fade to black just before the cut, back in after it
            if (shotTime > ShotLength - FadeTime) fadeTarget = 1;
            if (fade >= 0.99f && fadeTarget >= 1) { NextShot(true); fadeTarget = 0; }
            else if (shotTime < ShotLength - FadeTime) fadeTarget = 0;
            fade = Mathf.MoveTowards(fade, fadeTarget, dt / (FadeTime * 0.6f));
        }

        void OnGUI()
        {
            if (fade <= 0.01f || Event.current.type != EventType.Repaint) return;
            GUI.depth = 20; // under the menus
            var old = GUI.color;
            GUI.color = new Color(0, 0, 0, fade);
            GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
            GUI.color = old;
        }

        void OnDestroy()
        {
            if (view != null) Destroy(view.gameObject);
        }
    }
}
