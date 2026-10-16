using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using RTS.Net;
using RTS.World;

// Port of client/src/game.js in 3D: renders what the server sends and turns input into orders.
// All game logic runs on the server. Split into partial files: this one holds state and the
// world objects; GameView.Render.cs draws units and buildings every frame; GameView.Fx.cs the
// particles and projectiles; GameView.Input.cs selection and orders; GameView.Hud.cs the UI.
namespace RTS.Game
{
    public partial class GameView : MonoBehaviour
    {
        // Sprite sheet base and scale per unit type; rigs are the baked pixel rigs (pixelRig.js)
        static readonly Dictionary<string, (string sheet, float scale, bool rig)> UnitArt = new Dictionary<string, (string, float, bool)>
        {
            ["villager"] = ("villager", 2.2f, true),
            ["swordsman"] = ("warrior", 2.2f, true),
            ["archer"] = ("air", 2.2f, true),
            ["bowman"] = ("bowman", 2.2f, true),
            ["spearman"] = ("spearman", 2.2f, true),
            ["horseman"] = ("flyer", 2.2f, true),
            ["monk"] = ("monk", 2.2f, true),
            ["guard"] = ("spearman", 2.6f, true), // the central fortress's knights: big neutral spearmen
        };
        static readonly string[] HairStyles = { "male", "female" };
        static readonly HashSet<string> Soldiers = new HashSet<string> { "spearman", "swordsman", "archer", "bowman", "horseman" };
        const int FlagEvery = 5;
        const string NeutralFaction = "black";
        const int NeutralColor = 0x9e9e9e;

        // Building texture per type; width = footprint * widthFactor
        static readonly Dictionary<string, (string texture, float widthFactor, int tint, bool logs, bool centerTile, string[] variants)> BuildingArt =
            new Dictionary<string, (string, float, int, bool, bool, string[])>
            {
                ["townCenter"] = ("castle", 1.1f, 0xffffff, false, false, null),
                ["barracks"] = ("barracks", 1.15f, 0xffffff, false, false, null),
                ["monastery"] = ("monastery", 1.15f, 0xffffff, false, false, null),
                ["lumberCamp"] = ("house3", 0.95f, 0xffffff, true, false, null),
                ["tower"] = ("tower", 1.5f, 0xffffff, false, false, null),
                ["house"] = ("house1", 1.3f, 0xffffff, false, false, new[] { "house1", "house2", "house3" }),
                ["farm"] = ("house2", 0.45f, 0xffffff, false, true, null),
                ["wall"] = ("tower", 1f, 0xffffff, false, false, null),
                ["gate"] = ("tower", 1f, 0xffffff, false, false, null),
                ["fortress"] = ("castle", 1f, 0xffffff, false, false, null),
            };

        // Buildings drawn as 3D models (glTF in Resources, built by unity/Tools) instead of sprites:
        // resource path (other civilizations' versions add "_fire", "_earth", "_water") and width as a
        // fraction of the footprint
        static readonly Dictionary<string, (string path, float widthFactor)> BuildingModels = new Dictionary<string, (string, float)>
        {
            ["townCenter"] = ("models/center", 1.08f), // fills its 7-tile footprint
            ["house"] = ("models/house", 0.95f),
            ["farm"] = ("models/farm", 0.54f),         // the windmill in the middle; fields around it
            ["lumberCamp"] = ("models/lumber", 0.95f),  // a storage yard filling its footprint
            ["barracks"] = ("models/barracks", 0.95f),
            ["monastery"] = ("models/monastery", 0.95f),
            ["tower"] = ("models/tower", 0.9f),
            ["fortress"] = ("models/fortress", 0.95f),
            ["gate"] = ("models/gate", 1f),
        };
        const int ResourceModelVariants = 3;

        SocketIO socket;
        string myId;
        Dictionary<string, PlayerInfo> players = new Dictionary<string, PlayerInfo>();
        readonly Dictionary<string, Texture2D> flagTextures = new Dictionary<string, Texture2D>();
        readonly Dictionary<int, EntityView> sprites = new Dictionary<int, EntityView>();
        readonly Dictionary<int, ResourceView> resources = new Dictionary<int, ResourceView>();
        readonly Dictionary<long, int> resourceAt = new Dictionary<long, int>();
        HashSet<int> selected = new HashSet<int>();
        HashSet<int> bearers = new HashSet<int>();
        Dictionary<string, int> stock = new Dictionary<string, int>();
        int popUsed, popCap;
        bool stateSeen, focused;

        int[] tiles;
        int mapTiles;
        Ground ground;
        RtsCamera rts;
        PixelBatch pixels, overlay, ordersBatch;
        TerritoryMap territory;
        GrassField grass;
        Transform worldRoot, objectsRoot;
        Quaternion billboardRot = Quaternion.identity;
        float lastYaw = float.NaN, lastTilt = float.NaN;

        public Camera Cam => rts.cam;

        static long TileKey(int x, int y) => ((long)x << 32) | (uint)y;

        public static GameView Create(SocketIO socket, string myId, JToken start, Camera cam)
        {
            var go = new GameObject("Game");
            var g = go.AddComponent<GameView>();
            g.Init(socket, myId, start, cam);
            return g;
        }

        // The main menu's backdrop: the same world, fed by a local scripted battle (UI.MenuBackdrop)
        // instead of the server; no HUD, no input, quieter sounds, everything revealed
        public bool Demo { get; private set; }
        public RtsCamera Camera => rts;
        public static GameView CreateDemo(JToken start, Camera cam)
        {
            var go = new GameObject("MenuBackdrop");
            var g = go.AddComponent<GameView>();
            g.Demo = true;
            g.Init(null, "menu-viewer", start, cam);
            return g;
        }

        void Init(SocketIO socket, string myId, JToken start, Camera cam)
        {
            this.socket = socket;
            this.myId = myId;
            foreach (var p in (JArray)start["players"])
            {
                var info = PlayerInfo.Parse(p);
                players[info.id] = info;
                var tex = LoadFlag(info.flag);
                if (tex != null) flagTextures[info.id] = tex;
            }
            tiles = start["map"]["tiles"].Select(t => (int)t).ToArray();
            mapTiles = Mathf.RoundToInt(Mathf.Sqrt(tiles.Length));

            worldRoot = transform;
            bool spirit = (string)start["map"]["theme"] == "spirit";
            ground = Ground.Build(worldRoot, tiles, spirit);
            Atmosphere.Set(spirit);
            objectsRoot = new GameObject("Objects").transform;
            objectsRoot.SetParent(worldRoot, false);
            rts = new RtsCamera(cam, ground);
            pixels = PixelBatch.Create("Pixels", worldRoot, Materials.Pixels, ground, cam);
            overlay = PixelBatch.Create("Overlay", worldRoot, Materials.Overlay, ground, cam);
            ordersBatch = PixelBatch.Create("Orders", worldRoot, Materials.OverlayTop, ground, cam);
            territory = new TerritoryMap(tiles, mapTiles, spirit);
            fog = new FogOfWar(mapTiles);
            Materials.ApplyOutlines();

            foreach (var r in (JArray)start["resources"]) AddResource(ResourceInfo.Parse(r));
            ApplySheep(Parse.Sheep(start["sheep"]));
            grass = GrassField.Build(worldRoot, ground, (x, y) => resourceAt.ContainsKey(TileKey(x, y)));
            rts.FocusOn(mapTiles * C.TileSize / 2f, mapTiles * C.TileSize / 2f);
        }

        // The player's hand-drawn shape (white on transparent PNG data URL)
        static Texture2D LoadFlag(string dataUrl)
        {
            if (string.IsNullOrEmpty(dataUrl)) return null;
            int comma = dataUrl.IndexOf(',');
            if (comma < 0) return null;
            try
            {
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
                return tex.LoadImage(System.Convert.FromBase64String(dataUrl.Substring(comma + 1))) ? tex : null;
            }
            catch { return null; }
        }

        // ---------- Resources ----------

        // Mirrors a sprite left-right with a negative x scale. (SpriteRenderer.flipX is applied by the
        // shader in URP, unreliably in the shadow pass, so the custom shaders don't use it.)
        static void Mirror(Transform t, bool mirrored)
        {
            var s = t.localScale;
            s.x = Mathf.Abs(s.x) * (mirrored ? -1 : 1);
            t.localScale = s;
        }

        static float Hash01(float v) { float f = Mathf.Sin(v) * 9631.17f; return ((f % 1) + 1) % 1; }

        GameObject Billboard(string name, Transform parent, out Transform billboard, out SpriteRenderer sr, bool castShadows = true)
        {
            var root = new GameObject(name);
            root.transform.SetParent(parent, false);
            var bb = new GameObject("Sprite");
            bb.transform.SetParent(root.transform, false);
            sr = bb.AddComponent<SpriteRenderer>();
            sr.sharedMaterial = Materials.SpriteLit;
            sr.shadowCastingMode = castShadows ? ShadowCastingMode.On : ShadowCastingMode.Off;
            sr.receiveShadows = true;
            billboard = bb.transform;
            billboard.rotation = billboardRot;
            return root;
        }

        // Trees and bushes sway, sheep graze, gold uses one of the stone variants
        void AddResource(ResourceInfo r)
        {
            var v = new ResourceView { r = r, x = (r.tx + 0.5f) * C.TileSize, y = (r.ty + 0.5f) * C.TileSize };
            v.root = Billboard($"{r.type} {r.id}", objectsRoot, out v.billboard, out v.sprite);
            float scale;
            bool mirrored = false;
            float px = v.x, py = (r.ty + 0.5f) * C.TileSize;
            if (r.type == "food")
            {
                v.frames = GameAssets.Sheep("idle");
                v.sprite.sharedMaterial = Materials.UnitSprite(Color.white, false);
                v.fps = 6;
                scale = 2.2f; // same pixel size as the people
                mirrored = r.id % 3 == 0;
            }
            else if (r.variant == "bush")
            {
                // Two flat copies crossed at right angles: depth from any side, still 2D art
                v.sprite.sprite = GameAssets.BushCross;
                v.crossed = true;
                scale = C.TileSize / 16f;
                var second = new GameObject("Sprite 2");
                second.transform.SetParent(v.billboard, false);
                second.transform.localRotation = Quaternion.Euler(0, 90, 0);
                var sr2 = second.AddComponent<SpriteRenderer>();
                sr2.sprite = v.sprite.sprite;
                sr2.sharedMaterial = Materials.SpriteLit;
                Mirror(second.transform, true);
                sr2.shadowCastingMode = ShadowCastingMode.On;
                sr2.receiveShadows = true;
                v.billboard.rotation = Quaternion.Euler(0, 45 + r.id * 37 % 90, 0);
            }
            else if ((r.type == "stone" || r.type == "gold") && GlbLoader.Load($"models/{r.type}_1") is { } _)
            {
                // Low-poly pile of rocks (gold veins and nuggets, or a quarried block), turned at random
                var model = GlbLoader.Load($"models/{r.type}_{r.id % ResourceModelVariants + 1}");
                v.model = GlbLoader.Instantiate(model, v.root.transform, 0.92f, (tex, normal, ds) => Materials.Model(tex, normal, ds));
                v.model.transform.localRotation = Quaternion.Euler(0, (r.id * 67) % 360, 0);
                v.modelRenderers = v.model.GetComponentsInChildren<Renderer>();
                v.sprite.enabled = false;
                scale = 1;
            }
            else if (r.type == "stone")
            {
                v.sprite.sprite = GameAssets.Stone(r.id % 4);
                scale = 0.8f;
            }
            else if (r.type == "wood")
            {
                // Pixel-art pine or oak, one tile wide, mirrored on some; about 1 in 8 autumn orange
                // (the other way round in the spirit dimension: mostly orange, a few green)
                float roll = Hash01(r.id * 3.7f);
                int greens = GameAssets.TreeTintCount - GameAssets.AutumnTints;
                float autumn = ground != null && ground.Spirit ? 0.85f : 0.12f;
                int tint = roll < autumn ? greens + Mathf.FloorToInt(roll / autumn * GameAssets.AutumnTints) : Mathf.FloorToInt((roll - autumn) / (1 - autumn) * greens);
                v.sprite.sprite = GameAssets.Tree(r.id % 2, Mathf.Clamp(tint, 0, GameAssets.TreeTintCount - 1));
                mirrored = (r.id / 2) % 2 == 1;
                scale = C.TileSize / 16f;
                // Each tree sits at a stable spot inside its tile, snapped to the art's pixel grid
                float artPx = C.TileSize / 16f;
                float H(int n) { float f = Mathf.Sin(r.id * 12.9898f + n * 78.233f) * 43758.5453f; return ((f % 1) + 1) % 1; }
                px += Mathf.Round((H(1) - 0.5f) * 6) * artPx;
                py += Mathf.Round((H(2) - 0.5f) * 5) * artPx;
            }
            else
            {
                v.sprite.sprite = GameAssets.Gold(r.id % 6);
                scale = 0.42f;
            }
            if (v.frames != null)
            {
                v.animTime = Random.value * 10;
                v.sprite.sprite = v.frames[0];
            }
            v.billboard.localScale = Vector3.one * scale;
            Mirror(v.billboard, mirrored);
            v.gx = px;
            v.gy = py;
            v.root.transform.position = ground.ToWorld(px, py);
            resources[r.id] = v;
            // Sheep walk around, so they are picked by distance instead of by tile
            if (!v.IsSheep) resourceAt[TileKey(r.tx, r.ty)] = r.id;
        }

        public void ApplyResourceChanges(JToken changes)
        {
            foreach (var c in (JArray)changes)
            {
                int id = (int)c["id"];
                int amount = (int)(double)c["amount"];
                if (!resources.TryGetValue(id, out var r)) continue;
                r.r.amount = amount;
                if (amount > 0) continue;
                if (r.active && InSight(r.gx, r.gy)) SpawnFx(r.r.type == "wood" ? "dust2" : "dust1", r.root.transform.position + Vector3.up * 0.2f, 0.6f);
                Destroy(r.root);
                resources.Remove(id);
                resourceAt.Remove(TileKey(r.r.tx, r.r.ty));
            }
        }

        void ApplySheep(List<SheepInfo> sheep)
        {
            foreach (var s in sheep)
            {
                if (!resources.TryGetValue(s.id, out var r)) continue;
                r.x = s.x;
                r.y = s.y;
                r.owner = s.owner;
            }
        }

        // One soldier in every FlagEvery of each player's army (at least one) carries their flag
        void PickFlagBearers()
        {
            bearers = new HashSet<int>();
            foreach (var army in sprites.Values.Where(s => Soldiers.Contains(s.s.type) && s.s.owner != null).GroupBy(s => s.s.owner))
            {
                int i = 0;
                foreach (var s in army.OrderBy(s => s.s.id)) { if (i % FlagEvery == 0) bearers.Add(s.s.id); i++; }
            }
        }

        // ---------- State ----------

        int stateCount;

        public void ApplyState(JToken state) => ApplyState(StateMsg.From(state));

        readonly HashSet<int> seenIds = new HashSet<int>();
        readonly List<int> goneIds = new List<int>();

        public void ApplyState(StateMsg state)
        {
            stateCount++;
            ApplySheep(state.sheep);
            var newPlayers = new Dictionary<string, PlayerInfo>();
            foreach (var info in state.players) newPlayers[info.id] = info;
            players = newPlayers;
            if (players.TryGetValue(myId, out var me))
            {
                stock = me.stock;
                popUsed = me.pop;
                popCap = me.popCap;
            }

            var seen = seenIds;
            seen.Clear();
            foreach (var e in state.entities)
            {
                seen.Add(e.id);
                if (!sprites.TryGetValue(e.id, out var s))
                {
                    s = CreateView(e);
                    s.inSight = e.owner == myId;
                    SetActive(s, s.inSight);
                    sprites[e.id] = s;
                    // A new unit of ours after the first update was just trained
                    if (stateSeen && e.owner == myId && !s.isBuilding) SfxAt("trained", e.x, e.y);
                }
                // Enemy buildings out of sight keep the look they had when last seen
                else if (s.isBuilding && !s.inSight && !Allied(e.owner) && !e.central) continue;
                else if (e.hp < s.s.hp && s.inSight)
                {
                    SfxAt(s.isBuilding ? "hit" : e.type == "spearman" ? "block" : "sword", e.x, e.y);
                    OnHit(s);
                }
                s.s = e;
            }
            stateSeen = true;
            goneIds.Clear();
            foreach (var id in sprites.Keys) if (!seen.Contains(id)) goneIds.Add(id);
            foreach (var id in goneIds)
            {
                var s = sprites[id];
                if (s.gone) continue;
                selected.Remove(id);
                // Out of sight: a known building stays as last seen, anything else just vanishes
                if (!s.inSight)
                {
                    if (s.isBuilding && s.seen) { s.gone = true; continue; }
                    UnregisterWall(s);
                    Destroy(s.root);
                    sprites.Remove(id);
                    continue;
                }
                var pos = s.root.transform.position;
                // Buildings blow up, units leave a puff of dust and burst into pixels
                if (s.isBuilding) SpawnFx(s.s.id % 2 == 1 ? "explosion1" : "explosion2", pos, Defs.BuildingSize(s.s.type) / 120f);
                else
                {
                    SpawnFx("dust1", pos, 0.7f);
                    Burst(pos + Vector3.up * 0.3f, 26, new[] { ColorOf(s.s.owner), 0xebcaa6, 0xb3261e, 0x2c2c2c }, 110, 60, 0.6f, 260);
                }
                SfxAt(s.isBuilding ? "collapse" : "death", s.s.x, s.s.y);
                UnregisterWall(s);
                Destroy(s.root);
                sprites.Remove(id);
            }
            PickFlagBearers();
            if (!focused) FocusOnBase();
        }

        EntityView CreateView(EntityState e)
        {
            var v = new EntityView { s = e, gx = e.x, gy = e.y, isBuilding = Defs.IsBuilding(e.type), stats = Defs.Entity[e.type] };
            v.root = Billboard($"{e.type} {e.id}", objectsRoot, out v.billboard, out v.sprite);
            if (v.isBuilding)
            {
                int n = v.stats.tiles;
                ground.Flatten(e.id, e.tx, e.ty, n);
                grass?.Clear(e.tx, e.ty, n);
                ReseatResources(e.tx - 2, e.ty - 2, e.tx + n + 2, e.ty + n + 2);
                v.root.transform.position = ground.ToWorld(e.x, e.y);
                // Flames while badly damaged: an animated sprite and a flickering light
                var fireGo = new GameObject("Fire");
                fireGo.transform.SetParent(v.root.transform, false);
                v.fire = fireGo.AddComponent<SpriteRenderer>();
                v.fire.sharedMaterial = Materials.SpriteGlow;
                v.fire.shadowCastingMode = ShadowCastingMode.Off;
                v.fireFrames = GameAssets.Fx($"fire{e.id % 3 + 1}");
                fireGo.SetActive(false);
                var lightGo = new GameObject("FireLight");
                lightGo.transform.SetParent(v.root.transform, false);
                lightGo.transform.localPosition = new Vector3(0, 1.2f, -0.4f);
                v.fireLight = lightGo.AddComponent<Light>();
                v.fireLight.type = LightType.Point;
                v.fireLight.color = new Color(1, 0.55f, 0.2f);
                v.fireLight.range = 4.5f;
                v.fireLight.intensity = 0;
                v.fireLight.shadows = LightShadows.None;
                lightGo.SetActive(false);
                if (v.stats.IsFarm) CreateFields(v);
                if (BuildingArt[e.type].logs && !BuildingModels.ContainsKey(e.type)) CreateLogs(v);
                if (BuildingModels.TryGetValue(e.type, out var modelInfo)) CreateModel(v, modelInfo.path, modelInfo.widthFactor);
                if (v.stats.wall || v.stats.gate) RegisterWall(v);
                if (v.stats.wall) BuildWall(v);
                if (e.central) CreateCrown(v);
            }
            else
            {
                v.facing = 1;
                v.sprite.sharedMaterial = Materials.UnitSprite(GameAssets.Hex(ColorOf(e.owner)));
                SetUnitFrames(v, "idle", "front");
            }
            v.root.transform.position = ground.ToWorld(e.x, e.y);
            return v;
        }

        // Trees and rocks near a new terrace drop to the levelled ground
        void ReseatResources(int x0, int y0, int x1, int y1)
        {
            foreach (var r in resources.Values)
            {
                if (r.IsSheep || r.r.tx < x0 || r.r.ty < y0 || r.r.tx > x1 || r.r.ty > y1) continue;
                r.root.transform.position = ground.ToWorld(r.gx, r.gy);
            }
        }

        // Stacked logs beside the lumber camp: real cylinders
        void CreateLogs(EntityView v)
        {
            float half = Defs.BuildingSize(v.s.type) / 2;
            var mat = Materials.Lit(GameAssets.Hex(0x8b5a2b));
            foreach (var (lx, ly, lh) in new[] { (-6f, 0f, 0f), (6f, 0f, 0f), (0f, -7f, 0.27f) })
            {
                var log = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                Destroy(log.GetComponent<Collider>());
                log.transform.SetParent(v.root.transform, false);
                log.transform.localPosition = new Vector3((half - 14 + lx) * C.PxToUnit, 0.15f + lh, -(half - 8) * C.PxToUnit + 0.15f);
                log.transform.localRotation = Quaternion.Euler(90, 0, 0);
                log.transform.localScale = new Vector3(0.3f, 0.35f, 0.3f);
                log.GetComponent<MeshRenderer>().sharedMaterial = mat;
            }
        }

        // Roofs and spires painted in team green take the owner's colour (grey while neutral); a
        // captured building is rebuilt in its new owner's colour and civilization
        void CreateModel(EntityView v, string path, float widthFactor)
        {
            path = ModelPath(path, v.s.owner, v.s.civ);
            var model = GlbLoader.Load(path);
            if (model == null) return;
            if (v.model != null) Destroy(v.model);
            float width = Defs.BuildingSize(v.s.type) * widthFactor * C.PxToUnit;
            int team = ColorOf(v.s.owner);
            v.model = GlbLoader.Instantiate(model, v.root.transform, width, (tex, normal, ds) => Materials.Model(GameAssets.TeamRecolor(tex, team), normal, ds));
            // Its front faces the default camera (south)
            v.model.transform.localRotation = Quaternion.Euler(0, 180, 0);
            v.modelHeight = GlbLoader.Height(model, width);
            v.modelTop = GlbLoader.Top(model, width);
            v.modelColor = team;
            v.modelPath = path;
            v.door = null;
            MakePickable(v);
            v.modelRenderers = v.model.GetComponentsInChildren<Renderer>();
            // Its material is this team's own (the recoloured texture), so it can carry the outline colour
            foreach (var r in v.modelRenderers) r.sharedMaterial.SetColor("_OutlineColor", GameAssets.Hex(team));
            v.modelProps = new MaterialPropertyBlock();
            v.sprite.enabled = false;
        }

        // Clicks hit a building's model by its real shape: a collider per part on the picking layer
        public const int PickLayer = 30;
        void MakePickable(EntityView v)
        {
            v.model.AddComponent<PickTag>().id = v.s.id;
            foreach (var mf in v.model.GetComponentsInChildren<MeshFilter>())
            {
                mf.gameObject.layer = PickLayer;
                mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
            }
        }

        // Height of a building's art above its base, in world units
        float ArtHeight(EntityView s) =>
            s.model != null ? s.modelHeight * s.model.transform.localScale.y
            : s.sprite.sprite != null ? s.sprite.sprite.rect.height * s.billboard.localScale.y / GameAssets.PPU : 2;

        // Crown floating over the central town center
        void CreateCrown(EntityView v)
        {
            var tex = new Texture2D(15, 10, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
            string[] art =
            {
                "...............",
                ".......#.......",
                "#.....###.....#",
                "##...##.##...##",
                "###.##...##.###",
                "#####.....#####",
                "###############",
                "###############",
                "###############",
                "...............",
            };
            for (int y = 0; y < 10; y++)
                for (int x = 0; x < 15; x++)
                    tex.SetPixel(x, 9 - y, art[y][x] == '#' ? Color.white : Color.clear);
            tex.Apply();
            var go = new GameObject("Crown");
            go.transform.SetParent(v.model != null ? v.root.transform : v.billboard, false);
            v.crown = go.AddComponent<SpriteRenderer>();
            v.crown.sprite = Sprite.Create(tex, new Rect(0, 0, 15, 10), new Vector2(0.5f, 0), 21);
            v.crown.sharedMaterial = Materials.SpriteLit;
            v.crown.shadowCastingMode = ShadowCastingMode.On;
        }

        void CreateFields(EntityView v)
        {
            int n = v.stats.tiles;
            v.fieldsTexture = new Texture2D(n * C.TileSize, n * C.TileSize, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            v.fields = new GameObject("Fields");
            v.fields.transform.SetParent(v.root.transform, false);
            v.fields.transform.position = Vector3.zero;
            var m = new Mesh();
            float x0 = v.s.tx, z0 = -v.s.ty, x1 = v.s.tx + n, z1 = -(v.s.ty + n);
            float h = ground.HeightAtTile(v.s.tx + n / 2f, v.s.ty + n / 2f) + 0.02f;
            m.vertices = new[] { new Vector3(x0, h, z0), new Vector3(x1, h, z0), new Vector3(x0, h, z1), new Vector3(x1, h, z1) };
            m.uv = new[] { new Vector2(0, 1), new Vector2(1, 1), new Vector2(0, 0), new Vector2(1, 0) };
            m.triangles = new[] { 0, 1, 3, 0, 3, 2 };
            m.normals = new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up };
            m.colors = new[] { Color.white, Color.white, Color.white, Color.white };
            m.RecalculateBounds();
            v.fields.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = v.fields.AddComponent<MeshRenderer>();
            v.fieldsMaterial = new Material(Materials.SpriteLit);
            v.fieldsMaterial.SetTexture("_MainTex", v.fieldsTexture);
            v.fieldsMaterial.SetFloat("_Cutoff", 0.3f);
            mr.sharedMaterial = v.fieldsMaterial;
            mr.shadowCastingMode = ShadowCastingMode.Off;
        }

        // Ours or a teammate's: shares vision and is never attacked
        public bool Allied(string owner)
        {
            if (owner == myId) return true;
            if (owner == null || !players.TryGetValue(owner, out var p) || !players.TryGetValue(myId ?? "", out var me)) return false;
            return me.team != 0 && p.team == me.team;
        }

        public string FactionOf(string owner) => owner != null && players.TryGetValue(owner, out var p) ? p.faction : NeutralFaction;
        public int ColorOf(string owner) => owner != null && players.TryGetValue(owner, out var p) ? p.color : NeutralColor;
        // A unit's or building's civilization: its owner's, or its own (the neutral central garrison)
        string EntityCiv(EntityView v) => v.s.owner == null && v.s.civ != null ? v.s.civ : CivOf(v.s.owner);
        string CivOf(string owner) => owner != null && players.TryGetValue(owner, out var p) ? p.civ : null;
        // Earth and water fast units surf a slab over the ground instead of flying
        bool IsRider(string owner) => CivOf(owner) is "earth" or "water";
        bool IsFire(string owner) => owner != null && players.TryGetValue(owner, out var p) && p.civ == "fire";

        // Rigged units alternate hair styles by id and have a sheet per view; fire civilization
        // players use the `_fire` rig of a unit when one exists
        Sprite[] UnitFrames(EntityView v, string anim, string view)
        {
            var art = UnitArt[v.s.type];
            var faction = FactionOf(v.s.owner);
            var civ = EntityCiv(v);
            var rig = civ != null && civ != "air" && GameAssets.HasRig($"{art.sheet}_{civ}") ? $"{art.sheet}_{civ}" : art.sheet;
            if (!GameAssets.RigHasAnim(rig, anim)) anim = "idle";
            return GameAssets.RigFrames(faction, rig, HairStyles[v.s.id % HairStyles.Length], view, anim);
        }

        // Centre the camera on this player's town center
        void FocusOnBase()
        {
            var tc = sprites.Values.FirstOrDefault(s => s.s.owner == myId && s.s.type == "townCenter");
            if (tc == null) return;
            rts.FocusOn(tc.s.x, tc.s.y);
            focused = true;
        }

        void OnDestroy()
        {
            // The menu backdrop is destroyed at the end of the frame the game starts in, after the
            // game's view set up its fog: only the view that owns the global fog switches it (and the
            // ambience) off, or the game would run with the whole map uncovered
            bool current = fog == null || Shader.GetGlobalTexture("_FogOfWarTex") == fog.Texture;
            if (current)
            {
                FogOfWar.Disable();
                Sfx.StopAmbient();
                Atmosphere.Set(false);
            }
            if (fog != null) Destroy(fog.Texture);
        }
    }
}
