using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;

namespace RTS.Game
{
    public partial class GameView
    {
        static readonly Dictionary<string, float> AnimCycle = new Dictionary<string, float> { ["idle"] = 1.2f, ["run"] = 0.75f, ["work"] = 0.9f, ["cheer"] = 0.6f };
        static readonly Dictionary<string, string> AnimGroup = new Dictionary<string, string>
        {
            ["idle"] = "idle", ["run"] = "run", ["cheer"] = "cheer", ["run_wood"] = "run", ["run_gold"] = "run", ["run_meat"] = "run", ["attack"] = "attack", ["shoot"] = "attack",
        };
        const float LowHpFire = 0.5f;
        const float HitFlash = 0.11f;
        const float WorkSoundEvery = 0.9f, HealSoundEvery = 1.5f;
        const float FlyAlt = 44, DiveAlt = 70, TakeoffCrouch = 0.22f, TakeoffTime = 0.4f;
        const float FlagPole = 58;
        static readonly Color SelectColor = new Color(0, 1, 0, 0.95f);
        static readonly Color HoverColor = new Color(1, 1, 1, 0.9f);

        Vector3 camRight, camFwdFlat;
        int settingsVersion = -1;

        void Update()
        {
            float dt = Time.deltaTime;
            if (!Demo) HandleInput(dt);
            rts.Update(dt);
            if (settingsVersion != Settings.Version)
            {
                settingsVersion = Settings.Version;
                if (grass != null) grass.gameObject.SetActive(Settings.Grass);
            }
            var t = rts.cam.transform;
            camRight = t.right;
            camFwdFlat = Vector3.ProjectOnPlane(t.forward, Vector3.up).normalized;

            float tilt = rts.SpriteTilt;
            if (!Mathf.Approximately(tilt, lastTilt) || !Mathf.Approximately(rts.Yaw, lastYaw))
            {
                lastTilt = tilt;
                lastYaw = rts.Yaw;
                billboardRot = Quaternion.Euler(tilt, rts.Yaw, 0);
                foreach (var r in resources.Values) if (!r.crossed) r.billboard.rotation = billboardRot;
            }

            UpdateFog(dt);
            if (!Demo) PrepareBuildIcons();
            UpdateAmbience(dt);
            DrawResources(dt);
            DrawArrows(dt);
            DrawGusts(dt);
            DrawFireballs(dt);
            DrawBoulders(dt);
            DrawShards(dt);
            DrawMarkers(dt);
            UpdateFx(dt);

            float k = 1 - Mathf.Pow(0.7f, dt * 60);
            foreach (var kv in sprites)
            {
                var s = kv.Value;
                float dx = s.s.x - s.gx, dy = s.s.y - s.gy;
                s.gx += dx * k;
                s.gy += dy * k;
                // Only what the player knows about is drawn; only what is near the screen is animated
                // (Unity culls the rest itself, shadows included)
                SetActive(s, Known(s));
                if (!s.active) continue;
                if (!NearView(s))
                {
                    if (s.isBuilding) s.wasBuilt = s.s.built; // no late "built" puff when scrolled back to
                    else s.root.transform.position = ground.ToWorld(s.gx, s.gy);
                    continue;
                }
                var (sx, sy) = ScreenDir(dx, dy);
                if (Mathf.Abs(sx) > 0.3f) s.facing = (int)Mathf.Sign(sx);
                if (UnitArt.TryGetValue(s.s.type, out var art) && art.rig) UpdateView(s, sx, sy);
                s.billboard.rotation = billboardRot;
                if (s.isBuilding) DrawBuilding(s, selected.Contains(kv.Key), dt);
                else DrawUnit(s, selected.Contains(kv.Key), dt);
                if (s.s.burning) DrawBurning(s);
                if (s.s.type == "archer" && IsFire(s.s.owner)) MageFire(s);
            }

            PushGrass(dt);

            if (territory.Due)
            {
                var things = new List<TerritoryMap.Thing>(sprites.Count);
                foreach (var s in sprites.Values)
                    if (Known(s)) things.Add(new TerritoryMap.Thing { owner = s.s.owner, x = s.gx, y = s.gy, building = s.isBuilding });
                territory.Update(things, ColorOf, fog);
            }

            hovered = placing != null || dragStart != null || PointerOverUI ? null : PickAt(Input.mousePosition);
            DrawOverlay();
        }

        readonly List<Vector4> grassPushers = new List<Vector4>();

        // Units and sheep near the screen bend the grass around them, much harder while walking;
        // flyers in the air don't touch it. The closest to the camera win if there are too many.
        void PushGrass(float dt)
        {
            grassPushers.Clear();
            float ease = Mathf.Min(1, dt * 5);
            var focus = rts.cam.transform.position;
            foreach (var s in sprites.Values)
            {
                if (s.isBuilding || !s.active) continue;
                bool moving = Mathf.Abs(s.s.x - s.gx) + Mathf.Abs(s.s.y - s.gy) > 0.5f;
                s.push += ((s.alt > 12 ? 0 : moving ? 1 : 0.4f) - s.push) * ease;
                if (s.push < 0.02f) continue;
                var p = s.root.transform.position;
                grassPushers.Add(new Vector4(p.x, p.z, (s.stats.radius + 14) * C.PxToUnit, s.push));
            }
            foreach (var r in resources.Values)
            {
                if (!r.IsSheep || !r.active) continue;
                var p = r.root.transform.position;
                grassPushers.Add(new Vector4(p.x, p.z, 0.45f, Mathf.Abs(r.x - r.gx) + Mathf.Abs(r.y - r.gy) > 0.3f ? 0.8f : 0.3f));
            }
            if (grassPushers.Count > RTS.World.GrassField.MaxPushers)
                grassPushers.Sort((a, b) => ((a.x - focus.x) * (a.x - focus.x) + (a.y - focus.z) * (a.y - focus.z))
                    .CompareTo((b.x - focus.x) * (b.x - focus.x) + (b.y - focus.z) * (b.y - focus.z)));
            grass.SetPushers(grassPushers);
        }

        float marchAt, riverAt;

        // Armies on the move are heard marching; rivers in view are heard flowing
        void UpdateAmbience(float dt)
        {
            if (Time.time - marchAt > 0.42f)
            {
                int marching = 0;
                foreach (var s in sprites.Values)
                    if (s.active && Soldiers.Contains(s.s.type) && s.s.action == "moving" && s.alt < 4 && OnScreen(s, out _)) marching++;
                if (marching >= 3) { Sfx.Play("march", Mathf.Min(1, marching / 8f)); marchAt = Time.time + Random.value * 0.12f; }
            }
            if (Time.time - riverAt < 0.5f) { Sfx.SetRiver(lastRiver); return; }
            riverAt = Time.time;
            var f = rts.FocusServer;
            int cx = Mathf.FloorToInt(f.x / C.TileSize), cy = Mathf.FloorToInt(f.y / C.TileSize), water = 0, total = 0;
            for (int y = cy - 9; y <= cy + 9; y += 2)
                for (int x = cx - 9; x <= cx + 9; x += 2) { total++; if (ground.TileAt(x, y) == Terrain.Water) water++; }
            lastRiver = water * 4f / total;
            Sfx.SetRiver(lastRiver);
        }
        float lastRiver;

        // A server-space movement as seen on screen: x to the right, y downward
        (float, float) ScreenDir(float dx, float dy)
        {
            var move = new Vector3(dx, 0, -dy);
            return (Vector3.Dot(move, camRight), -Vector3.Dot(move, camFwdFlat));
        }

        Vector3 ScreenVec(float x, float y) => camRight * x - camFwdFlat * y;

        // Rigged units are drawn from the front, back or side: toward whatever they work on,
        // otherwise along their movement (the side view is mirrored by `facing`)
        void UpdateView(EntityView s, float dx, float dy)
        {
            Vector2? target = null;
            int? tid = s.s.targetId ?? s.s.buildingId;
            if (tid != null && sprites.TryGetValue(tid.Value, out var te)) target = new Vector2(te.gx, te.gy);
            else if (s.s.resourceId != null && resources.TryGetValue(s.s.resourceId.Value, out var tr)) target = new Vector2(tr.gx, tr.gy);
            if (target != null && s.s.action != "moving")
            {
                (dx, dy) = ScreenDir(target.Value.x - s.gx, target.Value.y - s.gy);
                if (Mathf.Abs(dx) > 1) s.facing = (int)Mathf.Sign(dx);
            }
            else if (Mathf.Sqrt(dx * dx + dy * dy) < 0.3f) return;
            s.view = Mathf.Abs(dx) >= Mathf.Abs(dy) * 0.8f ? "side" : dy < 0 ? "back" : "front";
        }

        // Picks the sheet that matches what the unit is doing this tick
        string UnitAnim(EntityView s)
        {
            var e = s.s;
            if (e.type == "villager")
            {
                if (e.action == "gathering") return e.carryType == "gold" || e.carryType == "stone" ? "pickaxe" : e.carryType == "food" ? "knife" : "axe";
                if (e.action == "building") return "hammer";
                if (e.action == "attacking") return "axe";
                if (e.action == "moving")
                {
                    if (e.carryAmount > 0) return "run_" + (e.carryType == "gold" || e.carryType == "stone" ? "gold" : e.carryType == "food" ? "meat" : "wood");
                    return "run";
                }
                return "idle";
            }
            if (e.type == "monk" && e.action == "healing") return "heal";
            if (e.action == "cheering") return "cheer";
            if (e.action == "attacking") return e.type == "archer" || e.type == "bowman" ? "shoot" : "attack";
            return e.action == "moving" ? "run" : "idle";
        }

        void SetUnitFrames(EntityView s, string anim, string view)
        {
            bool keepFrame = anim == s.anim; // turning mid-animation keeps its rhythm
            s.anim = anim;
            s.shownView = view;
            s.frames = UnitFrames(s, anim, view);
            AnimGroup.TryGetValue(anim, out var group);
            group ??= "work";
            float cycle = group == "attack"
                ? Defs.UnitStats(s.s.type, players.TryGetValue(s.s.owner ?? "", out var p) ? p.civ : null).attack?.cooldown ?? 1
                : AnimCycle[group];
            s.frameDuration = cycle / s.frames.Length;
            if (!keepFrame) s.animTime = 0;
        }

        // ---------- Buildings ----------

        // Selection and hover rings hug the 3D model (round it: the circle through its corners would be
        // far too big, the one touching its sides too small) and thicken as the camera pulls away
        float RingRadius(EntityView s)
        {
            float half = Defs.BuildingSize(s.s.type) / 2;
            if (s.model != null && BuildingModels.TryGetValue(s.s.type, out var m)) half = Mathf.Max(half, half * m.widthFactor);
            return half * 1.18f + 6;
        }

        float RingZoom => Mathf.Clamp(rts.Distance / 18f, 1, 2.6f);

        void DrawBuilding(EntityView s, bool isSelected, float dt)
        {
            var e = s.s;
            float size = Defs.BuildingSize(e.type);
            float half = size / 2;
            var art = BuildingArt[e.type];
            bool fallen = e.central && e.hp <= 0;

            // Owner's faction art; the central town center uses neutral art until claimed
            var textureName = art.variants != null ? art.variants[e.id % art.variants.Length] : art.texture;
            var faction = FactionOf(e.owner);
            if (s.model == null && (s.textureName != textureName || s.shownFaction != faction))
            {
                s.textureName = textureName;
                s.shownFaction = faction;
                s.sprite.sprite = GameAssets.Building(faction, textureName);
                s.billboard.localScale = Vector3.one * (size * art.widthFactor / s.sprite.sprite.texture.width);
            }
            // The farmhouse stands on the middle tile, everything else in the middle of its footprint
            Color tint = fallen ? new Color(0.33f, 0.33f, 0.33f) : e.central && e.owner == null ? new Color(0.73f, 0.73f, 0.73f) : GameAssets.Hex(art.tint);
            if (!e.built)
            {
                // Under construction: translucent, filling in as it is built
                s.sprite.sharedMaterial = Materials.SpriteGlow;
                tint *= 0.8f;
                tint.a = 0.35f + 0.5f * e.buildProgress;
                s.sprite.shadowCastingMode = ShadowCastingMode.Off;
            }
            else if (s.sprite.sharedMaterial != Materials.SpriteLit)
            {
                s.sprite.sharedMaterial = Materials.SpriteLit;
                s.sprite.shadowCastingMode = ShadowCastingMode.On;
            }
            if (Time.time - s.hitAt < HitFlash) tint = Color.Lerp(tint, new Color(1, 0.42f, 0.42f, tint.a), 0.6f);
            s.sprite.color = tint;
            if (s.stats.wall) UpdateWall(s);
            else if (s.model != null && BuildingModels.TryGetValue(e.type, out var modelInfo))
            {
                // Rebuilt in a captured building's new colours, or in its owner's new age (animated)
                bool aged = s.modelColor == ColorOf(e.owner) && s.modelPath != ModelPath(modelInfo.path, e.owner, e.civ);
                if (s.modelColor != ColorOf(e.owner) || aged)
                {
                    CreateModel(s, modelInfo.path, modelInfo.widthFactor);
                    if (aged) StartAgeAnim(s);
                }
            }
            if (s.stats.gate) UpdateGate(s, dt);
            if (s.model != null)
            {
                // A model rises out of the ground as it is built, darker until finished; bounces when it
                // changes age
                float grow = AgeAnimScale(s);
                s.model.transform.localScale = new Vector3(grow, (e.built ? 1 : 0.12f + 0.88f * e.buildProgress) * grow, grow);
                var c = tint;
                if (!e.built) c = c * 0.75f;
                c.a = 1;
                s.modelProps.SetColor("_Color", c);
                foreach (var r in s.modelRenderers) r.SetPropertyBlock(s.modelProps);
            }

            // Puff of dust the moment construction finishes; flames while badly damaged
            if (e.built && s.wasBuilt == false)
            {
                SpawnFx("dust2", s.root.transform.position + ScreenVec(0, half * C.PxToUnit), size / 70f);
                SfxAt("built", e.x, e.y);
            }
            s.wasBuilt = e.built;
            bool burning = e.built && !fallen && e.hp < s.MaxHp * LowHpFire;
            if (burning && !s.fire.gameObject.activeSelf) SfxAt("ignite", e.x, e.y);
            s.fire.gameObject.SetActive(burning);
            s.fireLight.gameObject.SetActive(burning);
            if (burning)
            {
                s.fire.transform.rotation = billboardRot;
                s.fire.transform.localScale = Vector3.one * (size / 70f);
                s.fire.transform.position = s.root.transform.position + camRight * (((e.id * 13) % 11) - 5) * C.PxToUnit - camFwdFlat * 0.3f + Vector3.up * size * 0.25f * C.PxToUnit;
                s.fire.sprite = s.fireFrames[(int)(Time.time * 12 + e.id) % s.fireFrames.Length];
                s.fireLight.intensity = 2.2f + Mathf.Sin(Time.time * 17 + e.id) * 0.6f + Mathf.Sin(Time.time * 7.3f) * 0.4f;
            }

            if (isSelected) overlay.GroundRing(e.x, e.y, RingRadius(s), RingRadius(s), 3 * RingZoom, SelectColor);
            if (s.stats.IsFarm) DrawFields(s);
            if (s.crown != null)
            {
                s.crown.color = fallen ? new Color(0.47f, 0.47f, 0.47f) : GameAssets.Hex(0xffd34d);
                if (s.model != null)
                {
                    // Over the tallest spire, above the flag once someone holds it
                    bool flagged = s.flag != null && s.flag.activeSelf;
                    s.crown.transform.position = ModelTop(s) + Vector3.up * (flagged ? (FlagPole + 12) * C.PxToUnit : 0.25f);
                    s.crown.transform.rotation = billboardRot;
                }
                else
                {
                    float top = s.sprite.sprite.rect.height;
                    s.crown.transform.localPosition = new Vector3(0, top / GameAssets.PPU + 0.15f / s.billboard.localScale.y, 0);
                    s.crown.transform.localScale = Vector3.one / s.billboard.localScale.y;
                }
            }
            var stats = s.stats;
            if (stats.attack != null && e.built && (isSelected || hovered?.id == e.id && hovered?.kind == PickKind.Entity))
                overlay.GroundRing(e.x, e.y, stats.attack.range, stats.attack.range, 2.5f * RingZoom, GameAssets.Hex(ColorOf(e.owner), 0.6f));
            DrawFlag(s);
        }

        // Tilled soil on every footprint tile except the farmhouse's; plants disappear as food is harvested
        void DrawFields(EntityView s)
        {
            var e = s.s;
            float max = s.stats.farmFood;
            var key = e.built ? $"{e.food}" : $"b{Mathf.RoundToInt(e.buildProgress * 10)}";
            if (s.fieldsKey == key) return;
            s.fieldsKey = key;
            const int T = C.TileSize, RowGap = 5;
            int n = s.stats.tiles;
            var tex = s.fieldsTexture;
            var px = new Color32[tex.width * tex.height];
            // Muted earth tones: furrow shadow, soil, ridge top, dry clods
            var furrow = new Color32(0x63, 0x4a, 0x38, 255);
            var soil = new Color32(0x84, 0x65, 0x4a, 255);
            var ridge = new Color32(0x9e, 0x7e, 0x5f, 255);
            var clod = new Color32(0xb3, 0x95, 0x74, 255);
            var edge = new Color32(0x56, 0x40, 0x31, 255);
            Color32 stem = new Color32(0x7f, 0xa6, 0x6a, 255), leaf = new Color32(0x9c, 0xc0, 0x80, 255);
            Color32 wheat = new Color32(0xd6, 0xbb, 0x6e, 255), wheatLight = new Color32(0xe8, 0xd3, 0x93, 255);
            Color32 post = new Color32(0x6e, 0x55, 0x40, 255), rail = new Color32(0x8f, 0x72, 0x56, 255);
            void Set(int x, int y, Color32 c)
            {
                if (x >= 0 && y >= 0 && x < tex.width && y < tex.height) px[(tex.height - 1 - y) * tex.width + x] = c;
            }
            float Noise(int x, int y) { float f = Mathf.Sin(x * 12.9898f + y * 78.233f + e.id) * 43758.5453f; return f - Mathf.Floor(f); }
            bool Middle(int t) => Mathf.Abs(t - (n - 1) / 2f) < 1;
            int ridgesPerTile = (T - 5 + RowGap - 1) / RowGap; // the last one is cut at the plot's edge
            // How much is tilled (while building) and how many crops are left (as it is harvested)
            float tilled = e.built ? 1 : e.buildProgress;
            float crops = e.built ? Mathf.Clamp01(e.food / max) : 0;
            int fieldTiles = 0;
            for (int ty = 0; ty < n; ty++) for (int tx = 0; tx < n; tx++) if (!(Middle(tx) && Middle(ty))) fieldTiles++;
            int totalRows = fieldTiles * ridgesPerTile, rowIndex = 0;
            for (int ty = 0; ty < n; ty++)
                for (int tx = 0; tx < n; tx++)
                {
                    if (Middle(tx) && Middle(ty)) continue; // the windmill stands here
                    int x0 = tx * T, y0 = ty * T;
                    for (int r = 0; r < ridgesPerTile; r++, rowIndex++)
                    {
                        bool tilledRow = rowIndex < totalRows * tilled;
                        int ry = y0 + 3 + r * RowGap;
                        for (int x = x0 + 2; x < x0 + T - 2; x++)
                            for (int k = 0; k < RowGap && ry + k < y0 + T - 2; k++)
                            {
                                float nz = Noise(x, ry + k);
                                Color32 c = !tilledRow ? (nz < 0.5f ? soil : furrow)
                                    : k == 0 ? furrow : k == 1 ? (nz < 0.3f ? soil : ridge) : k == 2 ? (nz < 0.15f ? clod : ridge) : soil;
                                if (tilledRow && nz > 0.97f) c = clod;
                                Set(x, ry + k, c);
                            }
                        if (!tilledRow) continue;
                        // Crops along the ridge, growing from sprouts into ripe wheat; the last rows
                        // harvested first go bare
                        bool hasCrops = (rowIndex + 0.5f) / totalRows <= crops;
                        if (!hasCrops) continue;
                        float growth = Mathf.Clamp01(crops * 1.4f - 0.2f);
                        if (ry + 2 >= y0 + T - 2) continue;
                        for (int x = x0 + 4 + (r % 2) * 2; x < x0 + T - 4; x += 5)
                        {
                            int top = ry + 1;
                            if (growth < 0.35f) { Set(x, top, stem); Set(x + 1, top, leaf); continue; }   // sprout
                            Set(x, top, stem); Set(x, top - 1, stem); Set(x - 1, top - 1, leaf); Set(x + 1, top - 2, leaf);
                            if (growth < 0.7f) { Set(x, top - 2, stem); continue; }                         // young plant
                            Set(x, top - 2, stem); Set(x, top - 3, wheat); Set(x + 1, top - 3, wheat); Set(x, top - 4, wheatLight); // ripe ear
                        }
                    }
                    // Plot border
                    for (int i = x0 + 1; i < x0 + T - 1; i++) { Set(i, y0 + 1, edge); Set(i, y0 + T - 2, edge); }
                    for (int j = y0 + 1; j < y0 + T - 1; j++) { Set(x0 + 1, j, edge); Set(x0 + T - 2, j, edge); }
                }
            // Wooden fence around the whole farm: a rail with a post every 8 px
            int W = n * T;
            for (int i = 0; i < W; i++)
            {
                foreach (var (x, y) in new[] { (i, 0), (i, W - 1), (0, i), (W - 1, i) }) Set(x, y, rail);
                if (i % 8 == 0) foreach (var (x, y) in new[] { (i, 0), (i, 1), (i, W - 1), (i, W - 2), (0, i), (1, i), (W - 1, i), (W - 2, i) }) Set(x, y, post);
            }
            tex.SetPixels32(px);
            tex.Apply();
            s.fieldsMaterial.SetColor("_Color", new Color(1, 1, 1, e.built ? 1 : 0.35f + 0.5f * e.buildProgress));
            s.fieldsMaterial.SetFloat("_Cutoff", e.built ? 0.3f : 0.05f);
        }

        // ---------- Units ----------

        void DrawUnit(EntityView s, bool isSelected, float dt)
        {
            var e = s.s;
            float r = s.stats.radius;
            if (e.type == "horseman")
            {
                if (IsRider(e.owner)) UpdateRider(s);
                else UpdateFlyer(s);
            }
            var anim = e.type == "horseman" ? s.flyAnim : UnitAnim(s);
            if (anim != s.anim || s.view != s.shownView) SetUnitFrames(s, anim, s.view);
            // Stepped animations (flyer takeoff/attack) follow the game's timing instead of playing
            if (s.stepFrame != null) s.frame = Mathf.Min(s.stepFrame.Value, s.frames.Length - 1);
            else
            {
                s.animTime += dt;
                s.frame = (int)(s.animTime / s.frameDuration) % s.frames.Length;
            }
            s.sprite.sprite = s.frames[s.frame];
            if (e.action == "stunned") DrawStun(s, r);
            // Frame events (impact particles) and footstep dust
            if (s.frame != s.lastFrame)
            {
                s.lastFrame = s.frame;
                FrameEvent(s, s.anim, s.frame);
                bool walking = s.anim.StartsWith("run") && e.type != "horseman";
                if (walking && s.frame % 2 == 0 && Random.value < 0.6f)
                    Burst(Feet(s) - camRight * s.facing * 0.1f, 2, Dust, 25, 15, 0.35f, 60);
            }
            // Hit flash (burning units flicker orange from DrawBurning, which runs after this)
            s.sprite.color = Time.time - s.hitAt < HitFlash ? GameAssets.Hex(0xff6b6b) : Color.white;
            if (e.chilled) DrawChill(s);
            if (e.chilled && !s.wasChilled) SfxAt("freeze", s.gx, s.gy);
            s.wasChilled = e.chilled;
            // Battle cry: the blade comes out (or the bow is drawn), shout marks burst over the head
            if (e.action == "cheering" && s.lastAction != "cheering")
            {
                SfxAt(e.type == "bowman" || e.type == "archer" ? "bowDraw" : "battlecry", s.gx, s.gy);
                var headTop = Feet(s) + Vector3.up * (1.05f + s.alt * C.PxToUnit);
                for (int i = 0; i < 6; i++)
                {
                    float a = Mathf.PI * (0.15f + 0.7f * i / 5f);
                    AddBit(headTop, (camRight * Mathf.Cos(a) * 70 + Vector3.up * Mathf.Sin(a) * 90) * C.PxToUnit, 0.35f, null, i % 2 == 0 ? 0xffffff : 0xffe08a);
                }
            }
            s.lastAction = e.action;
            // Flyers leave a trail of wind pixels (fire: embers cooling to smoke) behind them
            if (e.type == "horseman" && s.slab == null && s.alt > 8 && Random.value < 0.7f)
            {
                bool fire = IsFire(e.owner);
                var pos = Feet(s) + Vector3.up * ((s.alt + 4) * C.PxToUnit + 0.3f) - camRight * s.facing * 0.2f + Random.insideUnitSphere * 0.25f;
                var vel = -camRight * s.facing * (20 + Random.value * 20) * C.PxToUnit + Vector3.up * (fire ? 10 : -(15 + Random.value * 15)) * C.PxToUnit;
                AddBit(pos, vel, 0.5f, fire ? Embers : null, WindColors[Random.Range(0, WindColors.Length)], fire ? -40 : 0);
            }
            // Face the target while attacking
            if (e.action == "attacking" && e.targetId != null && sprites.TryGetValue(e.targetId.Value, out var target))
            {
                var (tx, _) = ScreenDir(target.gx - s.gx, target.gy - s.gy);
                if (Mathf.Abs(tx) > 1) s.facing = (int)Mathf.Sign(tx);
            }
            var art = UnitArt[e.type];
            s.billboard.localScale = Vector3.one * art.scale;
            Mirror(s.billboard, s.facing < 0);
            s.root.transform.position = ground.ToWorld(s.gx, s.gy);
            s.billboard.localPosition = Vector3.up * s.alt * C.PxToUnit;

            if (isSelected) overlay.GroundRing(s.gx, s.gy, r + 6, r + 6, 2.4f * RingZoom, SelectColor);
            if (isSelected && e.owner == myId && e.orders != null) DrawQueuedOrders(s);
            if (e.action == "healing" && e.targetId != null && sprites.TryGetValue(e.targetId.Value, out var patient))
            {
                float pulse = 0.4f + 0.3f * Mathf.Sin(Time.time * 1000 / 120);
                var heal = GameAssets.Hex(0x7dff7a, pulse);
                pixels.Line(Chest(s), Chest(patient), 0.05f, heal);
                var c = Feet(patient) + Vector3.up * 1.7f;
                pixels.Line(c - camRight * 0.12f, c + camRight * 0.12f, 0.075f, GameAssets.Hex(0x7dff7a, 0.9f));
                pixels.Line(c - Vector3.up * 0.12f, c + Vector3.up * 0.12f, 0.075f, GameAssets.Hex(0x7dff7a, 0.9f));
            }
            DrawFlag(s);
            UnitSounds(s);
        }

        // A selected unit's queued orders (Shift): a dotted trail on the ground through each spot, with a
        // small flag-like marker on each
        void DrawQueuedOrders(EntityView s)
        {
            var color = new Color(1f, 0.92f, 0.6f, 0.75f);
            var from = new Vector2(s.gx, s.gy);
            foreach (var to in s.s.orders)
            {
                float len = Vector2.Distance(from, to);
                for (float d = 10; d < len; d += 14)
                {
                    var p = Vector2.Lerp(from, to, d / len);
                    overlay.GroundRect(p.x - 1.5f * RingZoom, p.y - 1.5f * RingZoom, 3 * RingZoom, 3 * RingZoom, color, 0.05f);
                }
                overlay.GroundRing(to.x, to.y, 7, 7, 2 * RingZoom, color);
                from = to;
            }
        }

        Vector3 Feet(EntityView s) => s.root.transform.position;
        Vector3 Chest(EntityView s) => s.root.transform.position + Vector3.up * (0.4f + s.alt * C.PxToUnit);

        // Flyer altitude and animation. Moving = takeoff (crouch, aura, launch) then flight at FlyAlt;
        // attacking = rise to DiveAlt over the cooldown and dive so it lands exactly on each impact;
        // otherwise it glides back down.
        void UpdateFlyer(EntityView s)
        {
            float now = Time.time;
            bool flying = s.s.action == "moving";
            if (flying && !s.wasFlying && s.alt < 4)
            {
                s.takeoffAt = now;
                s.launched = false;
            }
            s.wasFlying = flying;
            float sinceTakeoff = now - s.takeoffAt;
            s.stepFrame = null;
            if (s.s.action == "attacking")
            {
                float cooldown = Defs.UnitStats("horseman", players.TryGetValue(s.s.owner ?? "", out var p) ? p.civ : null).attack.cooldown;
                float q0 = s.lastBlast > 0 ? Mathf.Min(1, (now - s.lastBlast) / cooldown) : 0.9f;
                s.flyAnim = "attack";
                if (q0 < 0.15f) { s.alt = 0; s.stepFrame = 0; }
                else if (q0 < 0.8f)
                {
                    float q = (q0 - 0.15f) / 0.65f;
                    s.alt = DiveAlt * (1 - (1 - q) * (1 - q));
                    s.stepFrame = q < 0.45f ? 1 : q < 0.75f ? 2 : 3;
                }
                else
                {
                    float q = (q0 - 0.8f) / 0.2f;
                    s.alt = DiveAlt * (1 - q * q);
                    s.stepFrame = 4;
                }
            }
            else if (sinceTakeoff < TakeoffTime)
            {
                s.flyAnim = "takeoff";
                if (sinceTakeoff < TakeoffCrouch) s.stepFrame = sinceTakeoff < TakeoffCrouch / 2 ? 0 : 1;
                else
                {
                    if (!s.launched) { s.launched = true; TakeoffBurst(Feet(s), IsFire(s.s.owner)); }
                    s.stepFrame = 2;
                    s.alt += (FlyAlt - s.alt) * 0.25f;
                }
            }
            else if (flying)
            {
                s.flyAnim = "run";
                s.alt += (FlyAlt + Mathf.Sin(now * 1000 / 220 + s.s.id) * 4 - s.alt) * 0.12f;
            }
            else
            {
                s.alt += (0 - s.alt) * 0.12f;
                if (s.alt < 1) s.alt = 0;
                s.flyAnim = s.alt > 3 ? "run" : s.s.action == "cheering" ? "cheer" : "idle";
            }
        }

        const float SlabHeight = 7; // px the surfers ride above the ground

        // Earth and water surfers ride a slab of rock or ice: it rises under them as they set off and
        // carries them just above the ground, leaving a trail of dust or frost; attacks are a
        // jump-and-slam played at the attack's pace
        void UpdateRider(EntityView s)
        {
            var e = s.s;
            bool water = CivOf(e.owner) == "water";
            s.stepFrame = null;
            s.flyAnim = e.action == "attacking" ? "attack" : e.action == "moving" ? "run" : e.action == "cheering" ? "cheer" : "idle";
            if (s.slab == null)
            {
                s.slab = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(s.slab.GetComponent<Collider>());
                s.slab.name = "Slab";
                s.slab.transform.SetParent(s.root.transform, false);
                s.slab.transform.localScale = new Vector3(0.55f, 0.16f, 1.05f);
                s.slab.GetComponent<MeshRenderer>().sharedMaterial = Materials.Lit(GameAssets.Hex(water ? 0xc8ecff : 0x8f8270));
            }
            bool riding = e.action == "moving" || e.action == "attacking";
            s.alt += ((riding ? SlabHeight : 0) - s.alt) * 0.2f;
            if (s.alt < 0.3f) s.alt = 0;
            s.slab.SetActive(s.alt > 0.5f);
            if (!s.slab.activeSelf) return;
            // The slab points along the movement
            var move = new Vector3(e.x - s.gx, 0, -(e.y - s.gy));
            if (move.sqrMagnitude > 0.5f) s.rideDir = Vector3.Slerp(s.rideDir, move.normalized, 0.2f);
            s.slab.transform.position = Feet(s) + Vector3.up * (s.alt * C.PxToUnit - 0.08f);
            s.slab.transform.rotation = Quaternion.LookRotation(s.rideDir) * Quaternion.Euler(-4, 0, 0);
            if (e.action != "moving" || Random.value > 0.6f) return;
            // Trail: dust puffs (earth) or frost crystals (water) kicked up behind, marks on the ground
            var back = Feet(s) - s.rideDir * 0.5f;
            var colors = water ? IceColors : Dust;
            AddBit(back + Vector3.up * 0.05f + Random.insideUnitSphere * 0.1f,
                (-s.rideDir * (20 + Random.value * 30) + Vector3.up * (water ? 15 : 30 + Random.value * 30)) * C.PxToUnit,
                water ? 0.6f : 0.5f, null, colors[Random.Range(0, colors.Length)], water ? 60 : -20);
            var sp = global::RTS.World.Ground.ToServer(back);
            trails.Add(new Trail { x = sp.x + (Random.value - 0.5f) * 8, y = sp.y + (Random.value - 0.5f) * 8, life = water ? 3 : 1.2f, max = water ? 3 : 1.2f, color = colors[Random.Range(0, colors.Length)] });
        }

        // Chopping, mining, hammering and healing, repeated while the unit keeps at it
        void UnitSounds(EntityView s)
        {
            string sound = null;
            float every = WorkSoundEvery;
            var e = s.s;
            if (e.action == "gathering") sound = e.carryType == "wood" ? "chop" : e.carryType == "gold" || e.carryType == "stone" ? "mine" : null;
            else if (e.action == "building") sound = "hammer";
            else if (e.action == "healing") { sound = "heal"; every = HealSoundEvery; }
            if (sound == null || Time.time - s.lastSound < every) return;
            s.lastSound = Time.time + Random.value * 0.2f; // desynchronise neighbours
            SfxAt(sound, s.gx, s.gy);
        }

        // ---------- Flags ----------

        // The flag pole rises behind the bearer (or from the roof of a finished building); the cloth
        // is the player's drawing in their colour, waving
        void DrawFlag(EntityView s)
        {
            var e = s.s;
            bool carrying = s.isBuilding ? e.owner != null && e.built && e.hp > 0 && !s.stats.wall && !s.stats.gate : bearers.Contains(e.id);
            if (!carrying)
            {
                if (s.flag != null) s.flag.SetActive(false);
                return;
            }
            // A captured building changes hands: rebuild the flag in the new owner's colours
            if (s.flag != null && s.flagOwner != e.owner) { Destroy(s.flag); s.flag = null; }
            if (s.flag == null)
            {
                s.flagOwner = e.owner;
                s.flag = new GameObject("Flag");
                s.flag.transform.SetParent(s.root.transform, false);
                var pole = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(pole.GetComponent<Collider>());
                pole.transform.SetParent(s.flag.transform, false);
                pole.transform.localScale = new Vector3(0.06f, (FlagPole + 9) * C.PxToUnit, 0.06f);
                pole.transform.localPosition = new Vector3(0, (FlagPole + 9) * C.PxToUnit / 2, 0);
                pole.GetComponent<MeshRenderer>().sharedMaterial = Materials.Lit(GameAssets.Hex(0x5d3a1e));
                var finial = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                Destroy(finial.GetComponent<Collider>());
                finial.transform.SetParent(s.flag.transform, false);
                finial.transform.localScale = Vector3.one * 0.13f;
                finial.transform.localPosition = new Vector3(0, (FlagPole + 10) * C.PxToUnit, 0);
                finial.GetComponent<MeshRenderer>().sharedMaterial = Materials.Lit(GameAssets.Hex(0xd4a017));
                var clothGo = new GameObject("Cloth");
                clothGo.transform.SetParent(s.flag.transform, false);
                var sr = clothGo.AddComponent<SpriteRenderer>();
                sr.sprite = FlagSprite(e.owner);
                sr.sharedMaterial = Materials.SpriteLit;
                sr.shadowCastingMode = ShadowCastingMode.On;
                s.flagCloth = clothGo.transform;
                s.flagCloth.localPosition = new Vector3(0, FlagPole * C.PxToUnit, 0);
            }
            s.flag.SetActive(true);
            // Waved hard, raised and swung side to side during the battle cry
            bool cheering = !s.isBuilding && e.action == "cheering";
            float wave = cheering ? Mathf.Sin(Time.time * 1000 / 70 + e.id) * 35 : Mathf.Sin(Time.time * 1000 / 260 + e.id) * 12;
            s.flag.transform.localRotation = cheering ? Quaternion.AngleAxis(Mathf.Sin(Time.time * 9 + e.id) * 20, camFwdFlat) : Quaternion.identity;
            if (s.isBuilding)
            {
                // Pole planted on the roof toward its right side; on a model, on the tip of its tallest spire
                float half = Defs.BuildingSize(e.type) / 2;
                s.flag.transform.position = s.model != null ? ModelTop(s) - Vector3.up * 0.05f
                    : s.root.transform.position + billboardRot * new Vector3(half * 0.45f * C.PxToUnit, ArtHeight(s) * 0.62f, -0.05f);
                s.flagCloth.rotation = Quaternion.Euler(0, rts.Yaw + wave, 0);
                Mirror(s.flagCloth, false);
                return;
            }
            // Behind the bearer, the cloth streaming out behind them
            s.flag.transform.position = Feet(s) - camRight * s.facing * 9 * C.PxToUnit + camFwdFlat * 0.08f + Vector3.up * (s.alt * C.PxToUnit + (cheering ? 0.25f : 0));
            s.flagCloth.rotation = Quaternion.Euler(0, rts.Yaw + wave, 0);
            Mirror(s.flagCloth, s.facing > 0);
        }

        Vector3 ModelTop(EntityView s) => s.model.transform.TransformPoint(s.modelTop);

        readonly Dictionary<string, Sprite> flagSprites = new Dictionary<string, Sprite>();

        // White cloth with the player's drawing on it in their colour; a plain flag in their colour otherwise
        Sprite FlagSprite(string owner)
        {
            if (flagSprites.TryGetValue(owner, out var sp)) return sp;
            const int W = 68, H = 46, B = 3; // 2x the 2D flag (34x23), 1.5 px border
            var color = GameAssets.Hex(ColorOf(owner));
            flagTextures.TryGetValue(owner, out var drawing);
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
            var border = GameAssets.Hex(0x3a2a1a);
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    Color c;
                    if (x < B || y < B || x >= W - B || y >= H - B) c = border;
                    else if (drawing == null) c = color;
                    else
                    {
                        // Pure white is the player's colour; any other colour is kept; empty is white cloth
                        var d = drawing.GetPixel(x * drawing.width / W, y * drawing.height / H);
                        var ink = d.r > 0.99f && d.g > 0.99f && d.b > 0.99f ? color : new Color(d.r, d.g, d.b);
                        c = Color.Lerp(Color.white, ink, d.a);
                    }
                    tex.SetPixel(x, y, c);
                }
            tex.Apply();
            // Pivot at the pole edge, top of the cloth on the pole top
            sp = Sprite.Create(tex, new Rect(0, 0, W, H), new Vector2(0, 1), GameAssets.PPU * 2);
            flagSprites[owner] = sp;
            return sp;
        }

        // ---------- Resources ----------

        // Sheep walk toward their owner's drop-off; owned sheep get a ring in the owner's colour.
        // Bushes and sheep play their animations.
        void DrawResources(float dt)
        {
            float k = 1 - Mathf.Pow(0.7f, dt * 60);
            foreach (var r in resources.Values)
            {
                if (r.IsSheep)
                {
                    r.gx += (r.x - r.gx) * k;
                    r.gy += (r.y - r.gy) * k;
                }
                if (r.frames == null || !r.active) continue;
                var pos = r.IsSheep ? ground.ToWorld(r.gx, r.gy) : r.root.transform.position;
                if (!NearView(pos + Vector3.up * 0.5f, Vector3.one)) continue;
                if (r.IsSheep)
                {
                    // Dead (legs up) as soon as a villager starts butchering it; walking while it moves;
                    // otherwise standing and grazing by turns
                    bool dead = r.r.amount < r.r.max;
                    bool walking = !dead && Mathf.Abs(r.x - r.gx) + Mathf.Abs(r.y - r.gy) > 0.6f;
                    string anim = dead ? "dead" : walking ? "walk" : ((int)((Time.time + r.r.id * 1.7f) / 4) % 2 == 0 ? "graze" : "idle");
                    var frames = GameAssets.Sheep(anim);
                    if (frames != r.frames) { r.frames = frames; r.fps = anim == "walk" ? 9 : anim == "graze" ? 4 : 3; }
                }
                r.animTime += dt;
                r.sprite.sprite = r.frames[(int)(r.animTime * r.fps) % r.frames.Length];
                if (!r.IsSheep) continue;
                float dx = r.x - r.gx;
                var (sx, _) = ScreenDir(dx, 0);
                if (Mathf.Abs(sx) > 0.3f) Mirror(r.billboard, sx < 0);
                r.root.transform.position = pos;
                if (r.owner != null) overlay.GroundRing(r.gx, r.gy, 13, 13, 2 * RingZoom, GameAssets.Hex(ColorOf(r.owner), 0.8f));
            }
        }

        // ---------- Overlay ----------

        void DrawOverlay()
        {
            if (placing == "wall")
            {
                // The wall's line from where the drag started (just the tile under the pointer before)
                (int x, int y) end = GhostTile();
                var start = wallStart ?? end;
                var ok = new HashSet<(int, int)>(WallTiles(start, end));
                var line = Defs.WallLine(start.x, start.y, end.x, end.y);
                int affordable = Defs.Entity["wall"].cost.TryGetValue("stone", out var per) && per > 0 ? (stock.TryGetValue("stone", out var have) ? have : 0) / per : 999;
                int n = 0;
                foreach (var c in line)
                {
                    bool good = ok.Contains(c) && n < affordable;
                    if (ok.Contains(c)) n++;
                    foreach (var (fx, fy) in Defs.Footprint("wall", c.x, c.y))
                        overlay.GroundTile(fx, fy, good ? new Color(0.3f, 0.69f, 0.31f, 0.45f) : new Color(0.9f, 0.22f, 0.21f, 0.45f));
                }
                ghost.gameObject.SetActive(false);
                foreach (var gm in ghostModels.Values) gm.SetActive(false);
                return;
            }
            if (placing != null)
            {
                var (tx, ty) = GhostTile();
                bool valid = CanPlaceHere(placing, tx, ty) && Defs.CanAfford(stock, Defs.Entity[placing].cost) && FootprintExplored(placing, tx, ty);
                var tint = valid ? GameAssets.Hex(0x4caf50) : GameAssets.Hex(0xe53935);
                foreach (var (x, y) in Defs.Footprint(placing, tx, ty))
                {
                    bool blocked = x < 0 || y < 0 || x >= mapTiles || y >= mapTiles || (IsTileBlocked(x, y) && !(placing == "gate" && OwnWallAt(x, y))) || !fog.ExploredTile(x, y);
                    var c = blocked ? GameAssets.Hex(0xe53935) : tint;
                    c.a = 0.4f;
                    overlay.GroundTile(x, y, c);
                }
                // Building preview in the player's own faction
                var art = BuildingArt[placing];
                ghost.sprite = GameAssets.Building(FactionOf(myId), art.texture);
                float size = Defs.BuildingSize(placing);
                ghost.transform.localScale = Vector3.one * (size * art.widthFactor / ghost.sprite.texture.width);
                ghost.transform.position = ground.ToWorld(tx * C.TileSize + size / 2, ty * C.TileSize + size / 2);
                ghost.transform.rotation = billboardRot;
                ghost.color = valid ? new Color(1, 1, 1, 0.6f) : new Color(1, 0.5f, 0.5f, 0.6f);
                ghost.gameObject.SetActive(true);
                // Model buildings preview their model instead of the sprite
                bool hasModel = BuildingModels.TryGetValue(placing, out var modelInfo);
                if (hasModel)
                {
                    ghost.gameObject.SetActive(false);
                    var gm = GhostModel(placing, modelInfo.path, modelInfo.widthFactor);
                    if (gm != null)
                    {
                        gm.SetActive(true);
                        gm.transform.position = ghost.transform.position;
                        ghostModelProps.SetColor("_Color", valid ? new Color(1, 1, 1, 0.55f) : new Color(1, 0.5f, 0.5f, 0.55f));
                        foreach (var r in gm.GetComponentsInChildren<Renderer>()) r.SetPropertyBlock(ghostModelProps);
                    }
                }
                foreach (var kv in ghostModels) if (!hasModel || kv.Key != placing) kv.Value.SetActive(false);
                return;
            }
            ghost.gameObject.SetActive(false);
            foreach (var gm in ghostModels.Values) gm.SetActive(false);
            if (hovered == null) return;
            if (hovered.kind == PickKind.Resource)
            {
                if (resources.TryGetValue(hovered.id, out var r)) overlay.GroundRing(r.gx, r.gy, r.model != null ? 22 : 16, r.model != null ? 22 : 16, 2.4f * RingZoom, HoverColor);
                return;
            }
            if (!sprites.TryGetValue(hovered.id, out var s)) return;
            if (s.isBuilding) overlay.GroundRing(s.s.x, s.s.y, RingRadius(s), RingRadius(s), 3 * RingZoom, HoverColor);
            else overlay.GroundRing(s.gx, s.gy, s.stats.radius + 6, s.stats.radius + 6, 2.4f * RingZoom, HoverColor);
        }

        readonly Dictionary<string, GameObject> ghostModels = new Dictionary<string, GameObject>();
        MaterialPropertyBlock ghostModelPropsBlock;
        // Created lazily: Unity forbids creating it in a MonoBehaviour field initializer
        MaterialPropertyBlock ghostModelProps => ghostModelPropsBlock ??= new MaterialPropertyBlock();

        GameObject GhostModel(string type, string path, float widthFactor)
        {
            path = ModelPath(path, myId);
            if (ghostModels.TryGetValue(type, out var go))
            {
                if (go.name == "Ghost " + path) return go;
                Destroy(go); // made for another age
                ghostModels.Remove(type);
            }
            var model = GlbLoader.Load(path);
            if (model == null) return null;
            var holder = new GameObject("Ghost " + path);
            holder.transform.SetParent(worldRoot, false);
            int team = ColorOf(myId);
            var m = GlbLoader.Instantiate(model, holder.transform, Defs.BuildingSize(type) * widthFactor * C.PxToUnit,
                (tex, normal, ds) => Materials.ModelGhost(GameAssets.TeamRecolor(tex, team), ds));
            m.transform.localRotation = Quaternion.Euler(0, 180, 0);
            foreach (var r in m.GetComponentsInChildren<Renderer>()) r.shadowCastingMode = ShadowCastingMode.Off;
            ghostModels[type] = holder;
            return holder;
        }

        // Tiles taken by resources or buildings, as known by the client
        bool IsTileBlocked(int x, int y)
        {
            if (resourceAt.ContainsKey(TileKey(x, y))) return true;
            int t = ground.TileAt(x, y);
            if (t == Terrain.Water || t == Terrain.Bridge) return true;
            foreach (var s in sprites.Values)
            {
                if (!s.isBuilding) continue;
                int n = s.stats.tiles;
                if (x >= s.s.tx && x < s.s.tx + n && y >= s.s.ty && y < s.s.ty + n) return true;
            }
            return false;
        }

        // Plays a world sound: full volume at the centre of the screen, fading toward the edges,
        // silent off screen or in the fog, quieter when zoomed out
        void SfxAt(string name, float x, float y)
        {
            if (!InSight(x, y)) return;
            var p = rts.cam.WorldToViewportPoint(ground.ToWorld(x, y));
            if (p.z < 0 || p.x < -0.08f || p.y < -0.08f || p.x > 1.08f || p.y > 1.08f) return;
            float d = Mathf.Sqrt((p.x - 0.5f) * (p.x - 0.5f) + (p.y - 0.5f) * (p.y - 0.5f)) / 0.7071f;
            float zoom = Mathf.Clamp01(Mathf.InverseLerp(RtsCamera.MaxDistance + 10, RtsCamera.MinDistance, Vector3.Distance(rts.cam.transform.position, ground.ToWorld(x, y))) + 0.3f);
            Sfx.Play(name, (1 - d * 0.7f) * zoom * (Demo ? 0.3f : 1));
        }
    }
}
