using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using RTS.UI;

// Ages and walls. Every building is drawn in its owner's age (rustic, standard or grand models, see
// unity/Tools); advancing plays a short transformation on each of the player's buildings and shows
// a banner. Walls are one-tile pieces joined into lines: a post on each tile and a span toward every
// neighbouring piece (diagonals too); gates turn to follow the wall and open for their owner's units.
namespace RTS.Game
{
    public partial class GameView
    {
        const float AgeAnimTime = 1.1f;
        const float WallPostWidth = 0.8f, WallSpanScale = 2f;
        const float GateOverlap = 0.3f; // spans toward a gate run this far into its pillar so they meet
        static readonly (int dx, int dy)[] Around = { (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1) };

        readonly Dictionary<long, EntityView> wallAt = new Dictionary<long, EntityView>(); // walls and gates by tile
        readonly Dictionary<string, float> agedAt = new Dictionary<string, float>(); // when each player last advanced
        float ageBannerAt = -10;
        int ageBannerAge;

        int AgeOf(string owner) => owner != null && players.TryGetValue(owner, out var p) ? p.age : 2;
        static string AgeSuffix(int age) => age == 1 ? "_a1" : age == 3 ? "_a3" : "";

        // The model a building of `owner` uses: its civilization's and age's version, falling back to
        // the civilization's, then the age's, then the plain one
        string ModelPath(string path, string owner, string civOverride = null)
        {
            var civ = owner == null && civOverride != null ? civOverride : CivOf(owner);
            var civPath = string.IsNullOrEmpty(civ) || civ == "air" ? path : path + "_" + civ;
            var age = AgeSuffix(AgeOf(owner));
            foreach (var candidate in new[] { civPath + age, civPath, path + age })
                if (GlbLoader.Exists(candidate)) return candidate;
            return path;
        }

        // ---------- Age up ----------

        public void OnAgeUp(string playerId, int age)
        {
            agedAt[playerId] = Time.time;
            if (players.TryGetValue(playerId, out var p)) p.age = Mathf.Max(p.age, age);
            if (playerId != myId) return;
            ageBannerAt = Time.time;
            ageBannerAge = age;
            buildIconsFor = null; // re-render the build menu in the new age's look
            Sfx.Play("start");
            Sfx.Play("unlock");
            rts.Shake = Mathf.Max(rts.Shake, 0.25f);
        }

        // A building just rebuilt in its owner's new age grows out with a puff of dust and sparkles
        void StartAgeAnim(EntityView s)
        {
            if (!s.s.owner.HasValue() || !agedAt.TryGetValue(s.s.owner, out var at) || Time.time - at > 6) return;
            s.ageAnimAt = Time.time;
            var pos = s.root.transform.position;
            float size = Defs.BuildingSize(s.s.type) * C.PxToUnit;
            SpawnFx("dust2", pos + Vector3.up * 0.2f, size * 0.8f);
            Burst(pos + Vector3.up * 0.4f, 24 + (int)(size * 6), new[] { 0xfff3b0, 0xffd34d, 0xffffff, ColorOf(s.s.owner) }, 90 + size * 25, 160, 0.9f, 140);
            SfxAt("ageup", s.s.x, s.s.y);
        }

        // Scale of a building's model during its age animation: squashed low, then springing up
        float AgeAnimScale(EntityView s)
        {
            float t = (Time.time - s.ageAnimAt) / AgeAnimTime;
            if (t < 0 || t >= 1) return 1;
            return 1 - Mathf.Exp(-6 * t) * Mathf.Cos(t * 11) * 0.45f;
        }

        // Big ribbon in the middle of the screen when we advance
        void DrawAgeBanner(float W, float H)
        {
            float t = Time.time - ageBannerAt;
            if (t > 4 || ageBannerAge < 1) return;
            float pop = Mathf.Clamp01(t / 0.35f), fade = Mathf.Clamp01((4 - t) / 0.6f);
            float k = Mathf.SmoothStep(0.6f, 1, pop);
            var old = GUI.color;
            GUI.color = new Color(1, 1, 1, fade);
            float w = 560 * k, h = 96 * k;
            var r = new Rect((W - w) / 2, H * 0.22f, w, h);
            var style = new GUIStyle(Skin.Ribbon("yellow", 70)) { fontSize = Mathf.RoundToInt(32 * k) };
            GUI.Box(r, $"¡{Defs.Ages[ageBannerAge - 1].name}!", style);
            var sub = new GUIStyle(Skin.Center) { fontSize = 16 };
            Shadowed(new Rect(r.x, r.yMax + 4, r.width, 24), "Nuevos edificios y unidades disponibles", sub, new Color(1f, 0.95f, 0.8f, fade));
            GUI.color = old;
        }

        // ---------- Walls ----------

        void RegisterWall(EntityView v)
        {
            if (v.stats.wall || v.stats.gate) wallAt[TileKey(v.s.tx, v.s.ty)] = v;
        }

        void UnregisterWall(EntityView v)
        {
            var key = TileKey(v.s.tx, v.s.ty);
            if (wallAt.TryGetValue(key, out var w) && w == v) wallAt.Remove(key);
        }

        // Which of the 8 neighbouring tiles hold a wall piece of the same owner (bit i = Around[i]).
        // A diagonal is left out when the corner it cuts is already joined through a side tile.
        int WallMask(EntityView s)
        {
            int m = 0;
            for (int i = 0; i < 8; i++)
            {
                var (dx, dy) = Around[i];
                if (wallAt.TryGetValue(TileKey(s.s.tx + dx * Defs.WallStep, s.s.ty + dy * Defs.WallStep), out var o) && o.s.owner == s.s.owner && !o.gone) m |= 1 << i;
            }
            for (int i = 1; i < 8; i += 2)
                if ((m & (1 << i)) != 0 && ((m & (1 << ((i + 7) % 8))) != 0 || (m & (1 << ((i + 1) % 8))) != 0)) m &= ~(1 << i);
            return m;
        }

        // Rebuilds a wall tile: its post and a span toward each joined neighbour
        void BuildWall(EntityView s)
        {
            if (s.model != null) Destroy(s.model);
            var postPath = ModelPath("models/wall_post", s.s.owner);
            var spanPath = ModelPath("models/wall_span", s.s.owner);
            var post = GlbLoader.Load(postPath);
            var span = GlbLoader.Load(spanPath);
            if (post == null || span == null) return;
            int team = ColorOf(s.s.owner);
            Material MaterialFor(Texture2D tex, Texture2D normal, bool ds) => Materials.Model(GameAssets.TeamRecolor(tex, team), normal, ds);
            s.model = new GameObject("Wall");
            s.model.transform.SetParent(s.root.transform, false);
            GlbLoader.Instantiate(post, s.model.transform, WallPostWidth, MaterialFor);
            s.wallMask = WallMask(s);
            for (int i = 0; i < 8; i++)
            {
                if ((s.wallMask & (1 << i)) == 0) continue;
                var (dx, dy) = Around[i];
                var dir = new Vector3(dx, 0, -dy) * Defs.WallStep;
                float len = dir.magnitude * 0.5f; // halfway to the neighbour, which draws the other half
                // A gate draws no spans of its own: run into its pillar so there's no gap
                if (wallAt.TryGetValue(TileKey(s.s.tx + dx * Defs.WallStep, s.s.ty + dy * Defs.WallStep), out var n) && n.stats.gate) len += GateOverlap;
                var piece = GlbLoader.Instantiate(span, s.model.transform, WallSpanScale, MaterialFor);
                piece.transform.localRotation = Quaternion.LookRotation(dir.normalized);
                piece.transform.localScale = new Vector3(1, 1, len / WallSpanScale);
                piece.transform.localPosition = dir.normalized * len / 2;
            }
            s.modelPath = postPath;
            s.modelColor = team;
            s.modelHeight = 1.8f;
            s.modelTop = new Vector3(0, 1.8f, 0);
            s.modelRenderers = s.model.GetComponentsInChildren<Renderer>();
            foreach (var r in s.modelRenderers) r.sharedMaterial.SetColor("_OutlineColor", GameAssets.Hex(team));
            MakePickable(s);
            s.modelProps ??= new MaterialPropertyBlock();
            s.sprite.enabled = false;
        }

        // Walls rejoin when a neighbour appears or goes, and take the owner's new age's look
        void UpdateWall(EntityView s)
        {
            bool aged = s.model != null && s.modelPath != ModelPath("models/wall_post", s.s.owner);
            if (s.model == null || aged || s.wallMask != WallMask(s) || s.modelColor != ColorOf(s.s.owner))
            {
                BuildWall(s);
                if (aged) StartAgeAnim(s);
            }
        }

        // A gate turns its opening along the wall it sits in, and its door sinks into the ground while
        // one of its owner's units is close
        void UpdateGate(EntityView s, float dt)
        {
            if (s.model == null) return;
            int m = WallMask(s);
            float yaw = 0;
            for (int i = 0; i < 8; i++)
                if ((m & (1 << i)) != 0) { var (dx, dy) = Around[i]; yaw = Mathf.Atan2(dy, dx) * Mathf.Rad2Deg; break; }
            s.model.transform.localRotation = Quaternion.Euler(0, yaw, 0);
            if (s.door == null)
            {
                s.door = FindDoor(s.model.transform);
                if (s.door == null) return;
                s.doorBase = s.door.localPosition;
            }
            // Who is near is checked a few times a second (staggered per gate), not every frame
            bool open = s.doorWasOpen;
            if ((Time.frameCount + s.s.id) % 6 == 0)
            {
                open = false;
                foreach (var u in sprites.Values)
                    if (!u.isBuilding && u.s.owner == s.s.owner && Mathf.Abs(u.gx - s.s.x) < 90 && Mathf.Abs(u.gy - s.s.y) < 90) { open = true; break; }
            }
            if (open != s.doorWasOpen) { SfxAt(open ? "gateOpen" : "gateClose", s.s.x, s.s.y); s.doorWasOpen = open; }
            s.doorOpen = Mathf.MoveTowards(s.doorOpen, open ? 1 : 0, dt * 2.5f);
            s.door.localPosition = new Vector3(s.doorBase.x, s.doorBase.y - s.doorOpen * 1.5f, s.doorBase.z);
        }

        Transform FindDoor(Transform model)
        {
            foreach (var t in model.GetComponentsInChildren<Transform>())
                if (t.name == "Door") return t;
            return null;
        }
    }

    static class StringExt
    {
        public static bool HasValue(this string s) => !string.IsNullOrEmpty(s);
    }
}
