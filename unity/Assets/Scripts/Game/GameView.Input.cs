using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using RTS.World;

namespace RTS.Game
{
    public enum PickKind { Entity, Resource }

    public class Pick
    {
        public PickKind kind;
        public int id;
    }

    public partial class GameView
    {
        const float ClickThreshold = 5;
        const float DoubleClick = 0.35f;

        string placing; // building type being placed
        Pick hovered;
        Vector2? dragStart;
        Vector2 lastMouse;
        bool middleDragging;
        (int id, float time)? lastClick;
        (int digit, float time)? lastGroupKey;
        int lastIdleId = -1;
        readonly Dictionary<int, List<int>> groups = new Dictionary<int, List<int>>();
        SpriteRenderer ghostRenderer;

        SpriteRenderer ghost
        {
            get
            {
                if (ghostRenderer != null) return ghostRenderer;
                var go = new GameObject("Ghost");
                go.transform.SetParent(worldRoot, false);
                ghostRenderer = go.AddComponent<SpriteRenderer>();
                ghostRenderer.sharedMaterial = Materials.Ghost;
                ghostRenderer.shadowCastingMode = ShadowCastingMode.Off;
                return ghostRenderer;
            }
        }

        // ---------- Hit testing ----------

        // Distance from a ray to a vertical segment (a unit's body), and how far along the ray
        static float RayToSegment(Ray ray, Vector3 a, Vector3 b, out float along)
        {
            var u = ray.direction;
            var v = b - a;
            var w = ray.origin - a;
            float A = Vector3.Dot(u, u), B = Vector3.Dot(u, v), Cc = Vector3.Dot(v, v), D = Vector3.Dot(u, w), E = Vector3.Dot(v, w);
            float den = A * Cc - B * B;
            float sc = den < 1e-6f ? 0 : (B * E - Cc * D) / den;
            float tc = den < 1e-6f ? E / Cc : (A * E - B * D) / den;
            tc = Mathf.Clamp01(tc);
            sc = Mathf.Max(0, (B * tc - D) / A);
            along = sc;
            return Vector3.Distance(ray.origin + u * sc, a + v * tc);
        }

        // Clicking: units first (the whole character sprite counts, generously), then the small things
        // of the map (sheep, trees, mines), then buildings, which only count where the pointer touches
        // their model; a building wins over a small thing only when it is clearly in front of it

        int? UnitAt(Ray ray, bool enemiesOnly = false)
        {
            int? best = null;
            float bestScore = float.MaxValue;
            foreach (var kv in sprites)
            {
                var s = kv.Value;
                if (s.isBuilding || !s.active || enemiesOnly && Allied(s.s.owner)) continue;
                // A generous target that grows as the camera pulls away, so small units stay easy to click
                float r = (s.stats.radius + 14) * C.PxToUnit * Mathf.Clamp(rts.Distance / 20f, 1, 2.2f);
                float height = s.s.type == "guard" ? 1.8f : 1.6f;
                var feet = Feet(s) + Vector3.up * s.alt * C.PxToUnit;
                float d = RayToSegment(ray, feet + Vector3.up * 0.1f, feet + Vector3.up * height, out float along);
                if (d > r) continue;
                float score = along + d * 4;
                if (score < bestScore) { best = kv.Key; bestScore = score; }
            }
            return best;
        }

        // The building whose model the ray touches (its collider), and how far along the ray
        (int? id, float dist) BuildingAt(Ray ray)
        {
            int? best = null;
            float bestDist = float.MaxValue;
            foreach (var hit in Physics.RaycastAll(ray, 1000, 1 << PickLayer))
            {
                var tag = hit.collider.GetComponentInParent<PickTag>();
                if (tag == null || hit.distance >= bestDist || !sprites.TryGetValue(tag.id, out var s) || !s.active) continue;
                best = tag.id;
                bestDist = hit.distance;
            }
            // Buildings still drawn as sprites: their picture's box
            foreach (var kv in sprites)
            {
                var s = kv.Value;
                if (!s.isBuilding || !s.active || s.model != null) continue;
                if (s.sprite.bounds.IntersectRay(ray, out float d) && d < bestDist) { best = kv.Key; bestDist = d; }
            }
            return (best, bestDist);
        }

        int? EntityAt(Vector2 screen)
        {
            var ray = rts.cam.ScreenPointToRay(screen);
            return UnitAt(ray) ?? BuildingAt(ray).id ?? BuildingOnGround(screen);
        }

        // The building whose footprint is under the pointer on the ground: a farm's crop fields, the
        // ground around a thin model, the base of a wall
        int? BuildingOnGround(Vector2 screen)
        {
            if (!rts.GroundPoint(screen, out var p)) return null;
            var sp = Ground.ToServer(p);
            foreach (var kv in sprites)
            {
                var s = kv.Value;
                if (!s.isBuilding || !s.active) continue;
                float size = Defs.BuildingSize(s.s.type);
                float x0 = s.s.tx * C.TileSize, y0 = s.s.ty * C.TileSize;
                if (sp.x >= x0 && sp.y >= y0 && sp.x < x0 + size && sp.y < y0 + size) return kv.Key;
            }
            return null;
        }

        // The resource under the pointer (sheep by their body, trees by their canopy, mines by their
        // model) and how far along the ray
        (int? id, float dist) ResourceAt(Ray ray)
        {
            int? best = null;
            float bestDist = float.MaxValue;
            foreach (var r in resources.Values)
            {
                if (!r.active) continue;
                if (r.IsSheep)
                {
                    var feet = r.root.transform.position;
                    float d = RayToSegment(ray, feet, feet + Vector3.up * 0.6f, out float along);
                    if (d <= (Defs.SheepRadius + 10) * C.PxToUnit && along < bestDist) { best = r.r.id; bestDist = along; }
                    continue;
                }
                if (r.modelRenderers != null)
                {
                    var mb = r.modelRenderers[0].bounds;
                    foreach (var mr in r.modelRenderers) mb.Encapsulate(mr.bounds);
                    if (mb.IntersectRay(ray, out float md) && md < bestDist) { best = r.r.id; bestDist = md; }
                    continue;
                }
                // Trees are tall: the canopy counts, not only the tile
                var b = r.sprite.bounds;
                b.Expand(new Vector3(0, 0, 0.3f));
                if (b.IntersectRay(ray, out float dist) && dist < bestDist)
                {
                    // Pixel-precise enough: ignore the transparent corners of wide sprites
                    var hit = ray.GetPoint(dist);
                    var local = r.sprite.transform.InverseTransformPoint(hit);
                    var sb = r.sprite.sprite.bounds;
                    if (Mathf.Abs(local.x) <= sb.extents.x * 0.8f) { best = r.r.id; bestDist = dist; }
                }
            }
            return (best, bestDist);
        }

        int? ResourceAtPoint(Vector2 screen)
        {
            var (id, _) = ResourceAt(rts.cam.ScreenPointToRay(screen));
            if (id != null) return id;
            if (!rts.GroundPoint(screen, out var p)) return null;
            // The ground at the foot of a tree or a mine counts too: the closest one within most of a
            // tile of the pointer
            var sp = Ground.ToServer(p);
            int cx = Mathf.FloorToInt(sp.x / C.TileSize), cy = Mathf.FloorToInt(sp.y / C.TileSize);
            int? best = null;
            float bestD = C.TileSize * 0.85f;
            for (int ty = cy - 1; ty <= cy + 1; ty++)
                for (int tx = cx - 1; tx <= cx + 1; tx++)
                {
                    if (!resourceAt.TryGetValue(TileKey(tx, ty), out var tid) || !resources[tid].active) continue;
                    float d = Vector2.Distance(sp, new Vector2((tx + 0.5f) * C.TileSize, (ty + 0.5f) * C.TileSize));
                    if (d < bestD) { best = tid; bestD = d; }
                }
            return best;
        }

        // `forOrder`: what a right click acts on. Our own and allied units are skipped there (an order
        // on them is just a move), so villagers crowding a farm, a tree or a mine don't get in the way
        Pick PickAt(Vector2 screen, bool forOrder = false)
        {
            var ray = rts.cam.ScreenPointToRay(screen);
            var unit = UnitAt(ray, forOrder);
            if (unit != null) return new Pick { kind = PickKind.Entity, id = unit.Value };
            var (res, resDist) = ResourceAt(ray);
            var (building, buildingDist) = BuildingAt(ray);
            if (res != null && (building == null || resDist <= buildingDist + 1.5f)) return new Pick { kind = PickKind.Resource, id = res.Value };
            if (building != null) return new Pick { kind = PickKind.Entity, id = building.Value };
            var tile = ResourceAtPoint(screen);
            if (tile != null) return new Pick { kind = PickKind.Resource, id = tile.Value };
            var under = BuildingOnGround(screen);
            return under != null ? new Pick { kind = PickKind.Entity, id = under.Value } : null;
        }

        (int, int) GhostTile()
        {
            if (!rts.GroundPoint(Input.mousePosition, out var p)) return (-100, -100);
            var sp = Ground.ToServer(p);
            // Walls and gates snap to the wall grid: the cell under the pointer (a gate there takes the
            // place of our wall piece)
            if (placing == "wall" || placing == "gate")
                return (Defs.SnapWall(Mathf.FloorToInt(sp.x / C.TileSize)), Defs.SnapWall(Mathf.FloorToInt(sp.y / C.TileSize)));
            return Defs.TileForCenter(placing, sp.x, sp.y);
        }

        // ---------- Input ----------

        bool Ctrl => Input.GetKey(KeyCode.LeftControl) || Input.GetKey(KeyCode.RightControl) || Input.GetKey(KeyCode.LeftCommand) || Input.GetKey(KeyCode.RightCommand);
        bool Shift => Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);

        void HandleInput(float dt)
        {
            Vector2 mouse = Input.mousePosition;
            bool overUI = PointerOverUI;

            // Esc cancels a placement first, otherwise opens/closes the menu; the world ignores input under it
            if (Input.GetKeyDown(KeyCode.Escape))
            {
                wallStart = null;
                if (placing != null) placing = null;
                else ToggleMenu();
            }
            if (menuOpen) return;
            for (int d = 1; d <= 9; d++) if (Input.GetKeyDown(KeyCode.Alpha0 + d)) HandleGroupKey(d);
            if (Input.GetKeyDown(KeyCode.Period) || Input.GetKeyDown(KeyCode.KeypadPeriod)) SelectIdleVillager();
            if (Input.GetKeyDown(KeyCode.H)) SelectTownCenter();
            HandleBarKeys();

            // Camera: WASD / arrows pan, Q/E turn, wheel zooms, middle drag pans (Alt + middle turns)
            var pan = Vector2.zero;
            if (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)) pan.x -= 1;
            if (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow)) pan.x += 1;
            if (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)) pan.y += 1;
            if (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)) pan.y -= 1;
            // Edge scrolling (an option): the pointer against a screen edge pans that way
            if (Settings.EdgeScroll && Application.isFocused && pan == Vector2.zero)
            {
                const float Edge = 6;
                if (mouse.x <= Edge) pan.x -= 1;
                else if (mouse.x >= Screen.width - Edge) pan.x += 1;
                if (mouse.y <= Edge) pan.y -= 1;
                else if (mouse.y >= Screen.height - Edge) pan.y += 1;
            }
            if (pan != Vector2.zero && !Ctrl) rts.Pan(pan, dt * Settings.CameraSpeed);
            if (Input.GetKey(KeyCode.Q)) rts.Rotate(-90 * dt);
            if (Input.GetKey(KeyCode.E)) rts.Rotate(90 * dt);
            float wheel = Input.mouseScrollDelta.y;
            if (wheel != 0 && !overUI) rts.Zoom(wheel > 0 ? 1.12f : 1 / 1.12f);
            if (Input.GetMouseButtonDown(2) && !overUI) middleDragging = true;
            if (Input.GetMouseButtonUp(2)) middleDragging = false;
            if (middleDragging)
            {
                var delta = mouse - lastMouse;
                if (Input.GetKey(KeyCode.LeftAlt) || Input.GetKey(KeyCode.RightAlt)) rts.Rotate(delta.x * 0.3f);
                else rts.DragPan(delta);
            }
            lastMouse = mouse;

            if (Input.GetMouseButtonDown(1) && !overUI)
            {
                if (placing != null) placing = null;
                else Command(mouse);
            }
            if (Input.GetMouseButtonDown(0) && !overUI)
            {
                if (placing == "wall") wallStart = GhostTile();
                else if (placing != null) PlaceBuilding();
                else dragStart = mouse;
            }
            // Walls are dragged: from where the button went down to where it comes up
            if (Input.GetMouseButtonUp(0) && wallStart != null)
            {
                PlaceWall(wallStart.Value, GhostTile());
                wallStart = null;
            }
            if (Input.GetMouseButtonUp(0) && dragStart != null)
            {
                var start = dragStart.Value;
                dragStart = null;
                if (Vector2.Distance(start, mouse) < ClickThreshold) Click(mouse);
                else BoxSelect(start, mouse);
            }
        }

        List<int> SelectedUnitIds() => selected.Where(id => sprites.TryGetValue(id, out var s) && !s.isBuilding).ToList();

        (int x, int y)? wallStart; // first tile of a wall being dragged

        // Tiles of the wall being dragged that can take a piece
        List<(int x, int y)> WallTiles((int x, int y) a, (int x, int y) b) =>
            Defs.WallLine(a.x, a.y, b.x, b.y).Where(c => WallPieceFits(c.x, c.y) && FootprintInSight("wall", c.x, c.y)).ToList();

        bool WallPieceFits(int tx, int ty) => Defs.WallCells(tx, ty, IsWallBlocked, mapTiles).Count > 0;

        // Wall pieces of the line that would go up in the fog (the server builds the whole line)
        bool WallInFog((int x, int y) a, (int x, int y) b) =>
            Defs.WallLine(a.x, a.y, b.x, b.y).Any(c => WallPieceFits(c.x, c.y) && !FootprintInSight("wall", c.x, c.y));

        void PlaceWall((int x, int y) a, (int x, int y) b)
        {
            var cost = Defs.Entity["wall"].cost;
            if (!Defs.CanAfford(stock, cost)) { ShowMessage("Recursos insuficientes"); return; }
            if (WallInFog(a, b)) { ShowMessage("No puedes construir en la niebla"); return; }
            if (WallTiles(a, b).Count == 0) { ShowMessage("No se puede construir ahí"); return; }
            var unitIds = SelectedUnitIds().Where(id => sprites[id].s.type == "villager").ToList();
            socket.Emit("game:wall", new { tx0 = a.x, ty0 = a.y, tx1 = b.x, ty1 = b.y, unitIds, queue = Shift });
            Sfx.Play("place");
            if (!Shift) placing = null;
        }

        // Our own wall piece whose cell holds tile (x, y)
        EntityView OwnWallCovering(int x, int y)
        {
            for (int j = 0; j < Defs.WallStep; j++)
                for (int i = 0; i < Defs.WallStep; i++)
                    if (wallAt.TryGetValue(TileKey(x - i, y - j), out var w) && w.s.owner == myId && w.stats.wall) return w;
            return null;
        }

        // A tile of one of our own wall pieces (a gate can go there in its place)
        bool OwnWallTile(int x, int y)
        {
            var w = OwnWallCovering(x, y);
            return w != null && Occupies(w, x, y);
        }

        // A gate needs its whole cell: free tiles or our own wall piece's (not one built against a tree)
        bool CanPlaceHere(string type, int tx, int ty) =>
            Defs.CanPlace(type, tx, ty, type == "gate" ? (x, y) => IsTileBlocked(x, y) && !OwnWallTile(x, y) : IsTileBlocked, mapTiles);

        void PlaceBuilding()
        {
            var (tx, ty) = GhostTile();
            var stats = Defs.Entity[placing];
            if (!Defs.CanAfford(stock, stats.cost)) { ShowMessage("Recursos insuficientes"); return; }
            if (!CanPlaceHere(placing, tx, ty)) { ShowMessage("No se puede construir ahí"); return; }
            if (!FootprintInSight(placing, tx, ty)) { ShowMessage("No puedes construir en la niebla"); return; }
            // Selected villagers go build it; the server picks the closest villager when none are selected
            var unitIds = SelectedUnitIds().Where(id => sprites[id].s.type == "villager").ToList();
            // With Shift the villagers queue it after what they are doing and placing goes on
            socket.Emit("game:build", new { type = placing, tx, ty, unitIds, queue = Shift });
            Sfx.Play("place");
            if (!Shift) placing = null;
        }

        // Single left click: train from own building, select own unit, or clear the selection
        void Click(Vector2 screen)
        {
            var id = EntityAt(screen);
            EntityView s = null;
            if (id != null) sprites.TryGetValue(id.Value, out s);
            if (s == null || s.s.owner != myId) { selected.Clear(); return; }
            // Double click: select every unit, or every finished building, of that type on screen
            float now = Time.unscaledTime;
            bool isDouble = lastClick?.id == id && now - lastClick.Value.time < DoubleClick;
            lastClick = isDouble ? null : ((int, float)?)(id.Value, now);
            if (isDouble)
            {
                selected = new HashSet<int>(VisibleUnitsOfType(s.s.type).Where(i => !s.isBuilding || sprites[i].s.built));
                selected.Add(id.Value);
                return;
            }
            // Buildings are only selected: what they can do is in the command bar
            selected = new HashSet<int> { id.Value };
        }

        bool OnScreen(EntityView s, out Vector3 screen)
        {
            screen = rts.cam.WorldToScreenPoint(Feet(s) + Vector3.up * 0.5f);
            return s.active && screen.z > 0 && screen.x >= 0 && screen.y >= 0 && screen.x <= Screen.width && screen.y <= Screen.height;
        }

        List<int> VisibleUnitsOfType(string type) =>
            sprites.Where(kv => kv.Value.s.owner == myId && kv.Value.s.type == type && OnScreen(kv.Value, out _)).Select(kv => kv.Key).ToList();

        void BoxSelect(Vector2 a, Vector2 b)
        {
            var rect = Rect.MinMaxRect(Mathf.Min(a.x, b.x), Mathf.Min(a.y, b.y), Mathf.Max(a.x, b.x), Mathf.Max(a.y, b.y));
            selected = new HashSet<int>(sprites.Where(kv =>
            {
                var s = kv.Value;
                if (s.s.owner != myId || s.isBuilding || !s.active) return false;
                var p = rts.cam.WorldToScreenPoint(Feet(s) + Vector3.up * 0.5f);
                return p.z > 0 && rect.Contains(p);
            }).Select(kv => kv.Key));
        }

        // Right click: gather, help build, farm, attack/capture or move; a burst marks the spot
        void Command(Vector2 screen)
        {
            var unitIds = SelectedUnitIds();
            if (!rts.GroundPoint(screen, out var p)) return;
            var world = Ground.ToServer(p);
            if (unitIds.Count == 0)
            {
                SetRally(world, PickAt(screen, true));
                return;
            }
            var order = SendOrder(unitIds, screen, world);
            markers.Add(new Marker { x = world.x, y = world.y, color = MarkerColors[order] });
            Sfx.Play(order == "attack" ? "orderAttack" : "order");
        }

        // Right click order; with Shift held it is queued after what the units are doing (AoE waypoints)
        string SendOrder(List<int> unitIds, Vector2 screen, Vector2 world)
        {
            var target = PickAt(screen, true);
            if (target?.kind == PickKind.Resource)
            {
                socket.Emit("game:gather", new { unitIds, resourceId = target.id, queue = Shift });
                return "gather";
            }
            EntityView s = null;
            if (target?.kind == PickKind.Entity) sprites.TryGetValue(target.id, out s);
            if (s != null && s.isBuilding && !s.s.built && s.s.owner == myId)
            {
                socket.Emit("game:construct", new { unitIds, buildingId = target.id, queue = Shift });
                return "build";
            }
            if (s != null && s.stats.IsFarm && s.s.built && s.s.owner == myId)
            {
                socket.Emit("game:farm", new { unitIds, buildingId = target.id, queue = Shift });
                return "gather";
            }
            // Enemies, the neutral central town center, or a fallen one (villagers capture it)
            if (s != null && (!Allied(s.s.owner) || (s.s.central && s.s.hp <= 0)))
            {
                socket.Emit("game:attack", new { unitIds, targetId = target.id, queue = Shift });
                return "attack";
            }
            socket.Emit("game:move", new { unitIds, x = world.x, y = world.y, queue = Shift });
            return "move";
        }

        // Our selected buildings that train units
        List<int> RallyBuildings() => selected.Where(id => sprites.TryGetValue(id, out var s) && s.isBuilding && s.s.owner == myId && s.s.built && s.stats.trains != null).ToList();

        // Right click with buildings selected: their rally point. On a resource or one of our farms new
        // villagers go straight to work there; on the building itself the flag is taken down
        void SetRally(Vector2 world, Pick target)
        {
            var buildingIds = RallyBuildings();
            if (buildingIds.Count == 0) return;
            int? resourceId = target?.kind == PickKind.Resource ? target.id : (int?)null;
            int? buildingId = target?.kind == PickKind.Entity && sprites.TryGetValue(target.id, out var b) && b.isBuilding ? target.id : (int?)null;
            if (resourceId != null && resources.TryGetValue(resourceId.Value, out var res)) world = new Vector2(res.gx, res.gy);
            socket.Emit("game:rally", new { buildingIds, x = world.x, y = world.y, resourceId, buildingId });
            if (buildingId != null && buildingIds.Contains(buildingId.Value))
            {
                ShowMessage("Punto de reunión quitado", true);
                return;
            }
            markers.Add(new Marker { x = world.x, y = world.y, color = MarkerColors[resourceId != null ? "gather" : "move"] });
            Sfx.Play("order");
        }

        // My villagers with no job (a plain move order that has finished counts as idle)
        List<int> IdleVillagers() =>
            sprites.Where(kv => kv.Value.s.owner == myId && kv.Value.s.type == "villager" && kv.Value.s.task == null && kv.Value.s.action != "moving")
                .Select(kv => kv.Key).ToList();

        // Selects the next idle villager (cycling on repeated use) and centres the camera on it
        // H: select our town center (the next one each press) and centre the camera on it
        int lastTownCenter = -1;
        void SelectTownCenter()
        {
            var tcs = sprites.Values.Where(s => s.s.owner == myId && s.s.type == "townCenter").OrderBy(s => s.s.id).ToList();
            if (tcs.Count == 0) return;
            var next = tcs.FirstOrDefault(s => s.s.id > lastTownCenter) ?? tcs[0];
            lastTownCenter = next.s.id;
            selected = new HashSet<int> { next.s.id };
            rts.FocusOn(next.s.x, next.s.y);
        }

        void SelectIdleVillager()
        {
            var ids = IdleVillagers().OrderBy(i => i).ToList();
            if (ids.Count == 0) return;
            int id = ids.FirstOrDefault(i => i > lastIdleId);
            if (!ids.Contains(id)) id = ids[0];
            lastIdleId = id;
            selected = new HashSet<int> { id };
            var s = sprites[id];
            rts.FocusOn(s.gx, s.gy);
        }

        // Ctrl/Cmd + digit saves the selected units as a group; the digit alone selects it again,
        // and pressing it twice quickly centres the camera on the group
        void HandleGroupKey(int digit)
        {
            if (Ctrl)
            {
                var ids = SelectedUnitIds();
                if (ids.Count > 0)
                {
                    groups[digit] = ids;
                    ShowMessage($"Grupo {digit}: {ids.Count} unidades", true);
                }
                return;
            }
            if (!groups.TryGetValue(digit, out var list)) return;
            list = list.Where(sprites.ContainsKey).ToList();
            groups[digit] = list;
            if (list.Count == 0) return;
            selected = new HashSet<int>(list);
            float now = Time.unscaledTime;
            if (lastGroupKey?.digit == digit && now - lastGroupKey.Value.time < DoubleClick)
                rts.FocusOn(list.Average(id => sprites[id].gx), list.Average(id => sprites[id].gy));
            lastGroupKey = (digit, now);
        }
    }
}

namespace RTS.Game
{
    public partial class GameView
    {
        // ---- AutoTest hooks ----

        // Villagers: one to the nearest tree, one builds a house, the rest move out
        public void DebugOrders()
        {
            var mine = sprites.Values.Where(s => s.s.owner == myId && s.s.type == "villager").ToList();
            var tc = sprites.Values.FirstOrDefault(s => s.s.owner == myId && s.s.type == "townCenter");
            if (tc == null || mine.Count == 0) return;
            var tree = resources.Values.Where(r => r.r.type == "wood" && r.r.variant != "bush")
                .OrderBy(r => (r.x - tc.s.x) * (r.x - tc.s.x) + (r.y - tc.s.y) * (r.y - tc.s.y)).FirstOrDefault();
            if (tree != null) socket.Emit("game:gather", new { unitIds = new[] { mine[0].s.id }, resourceId = tree.r.id });
            for (int dy = 3; dy < 8; dy++)
            {
                int tx = tc.s.tx + 4, ty = tc.s.ty + dy;
                if (Defs.CanPlace("house", tx, ty, IsTileBlocked, mapTiles))
                {
                    if (mine.Count > 1) socket.Emit("game:build", new { type = "house", tx, ty, unitIds = new[] { mine[1].s.id } });
                    break;
                }
            }
            selected = new HashSet<int>(mine.Skip(2).Select(s => s.s.id));
            if (mine.Count > 2) socket.Emit("game:move", new { unitIds = mine.Skip(2).Select(s => s.s.id).ToArray(), x = tc.s.x - 120, y = tc.s.y + 120 });
            markers.Add(new Marker { x = tc.s.x - 120, y = tc.s.y + 120, color = MarkerColors["move"] });
        }

        public void DebugCamera(float distanceFactor, float yaw)
        {
            rts.Zoom(20 / distanceFactor);
            rts.Rotate(yaw);
        }

        public void DebugTrain()
        {
            var tc = sprites.Values.FirstOrDefault(s => s.s.owner == myId && s.s.type == "townCenter");
            if (tc != null) socket.Emit("game:train", new { buildingId = tc.s.id, type = "villager" });
        }
    }
}
