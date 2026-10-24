using System.Collections.Generic;
using UnityEngine;

// The spirit dimension's crystal outcrops: every patch of Crystal tiles (4-connected) gets one of the
// crystal models built by unity/Tools/build-crystals.mjs — a crystal mountain (crystal_big_1..5) on
// patches of 80 tiles or more, a crag (crystal_mid_1..5) on those of 9 or more, a cluster
// (crystal_small_1..5) on the others — picked and turned by the
// patch's position so every client shows the same, scaled to cover the patch and sunk into its mound.
// The crystals glow a little (the terrain shader's _Emission) so they read as light-filled. More
// crystals jut from the void's walls (BuildWalls).
namespace RTS.World
{
    public static class Crystals
    {
        // Tiles: the crystal mountains (models built to be drawn ~17 tiles wide), the crags (~7) and the
        // clusters (~3), so the art's pixels come out the same size on all of them
        const int BigFrom = 80, MidFrom = 9;
        const float Glow = 0.25f;

        static readonly Dictionary<(Texture2D, float), Material> materials = new Dictionary<(Texture2D, float), Material>();

        public static void Build(Transform parent, Ground ground)
        {
            int n = ground.N;
            var seen = new bool[n * n];
            var root = new GameObject("Crystals").transform;
            root.SetParent(parent, false);
            var cells = new List<Vector2Int>();
            for (int ty = 0; ty < n; ty++)
                for (int tx = 0; tx < n; tx++)
                {
                    if (seen[ty * n + tx] || ground.TileAt(tx, ty) != Terrain.Crystal) continue;
                    // Flood the patch
                    cells.Clear();
                    var stack = new Stack<Vector2Int>();
                    stack.Push(new Vector2Int(tx, ty));
                    seen[ty * n + tx] = true;
                    while (stack.Count > 0)
                    {
                        var c = stack.Pop();
                        cells.Add(c);
                        foreach (var d in new[] { Vector2Int.right, Vector2Int.left, Vector2Int.up, Vector2Int.down })
                        {
                            var q = c + d;
                            if (q.x < 0 || q.y < 0 || q.x >= n || q.y >= n || seen[q.y * n + q.x] || ground.TileAt(q.x, q.y) != Terrain.Crystal) continue;
                            seen[q.y * n + q.x] = true;
                            stack.Push(q);
                        }
                    }
                    Place(root, ground, cells);
                }
        }

        static void Place(Transform root, Ground ground, List<Vector2Int> cells)
        {
            int x0 = int.MaxValue, y0 = int.MaxValue, x1 = int.MinValue, y1 = int.MinValue;
            float cx = 0, cy = 0, low = float.MaxValue;
            foreach (var c in cells)
            {
                x0 = Mathf.Min(x0, c.x); y0 = Mathf.Min(y0, c.y); x1 = Mathf.Max(x1, c.x); y1 = Mathf.Max(y1, c.y);
                cx += c.x + 0.5f; cy += c.y + 0.5f;
                low = Mathf.Min(low, ground.HeightAtTile(c.x + 0.5f, c.y + 0.5f));
            }
            cx /= cells.Count; cy /= cells.Count;
            bool big = cells.Count >= BigFrom, mid = !big && cells.Count >= MidFrom;
            float h = Hash(cx * 1.7f + cy * 3.1f);
            int variant = 1 + Mathf.Min(4, (int)(h * 5));
            var model = GlbLoader.Load($"models/crystal_{(big ? "big" : mid ? "mid" : "small")}_{variant}");
            if (model == null) return;
            var holder = new GameObject($"Crystal {cells.Count}");
            holder.transform.SetParent(root, false);
            // Sunk a little into its mound so no side floats over a slope
            holder.transform.localPosition = new Vector3(cx, low - 0.12f, -cy);
            holder.transform.localRotation = Quaternion.Euler(0, Hash(cx * 5.3f - cy * 2.9f) * 360, 0);
            float width = Mathf.Max(x1 - x0 + 1, y1 - y0 + 1) * (big || mid ? 1.15f : 1.2f);
            GlbLoader.Instantiate(model, holder.transform, width, (tex, normal, doubleSided) => Material(tex, 0));
        }

        // Crystals jutting from the void's walls (spirit cliffs): at a share of the spots along the edge,
        // one every few tiles at most, out and up from the rock at some depth, fading into the haze
        // like the wall around them. Purely visual: the void can't be walked anyway.
        public static void BuildWalls(Transform parent, Ground ground)
        {
            if (ground.CliffSpots.Count == 0) return;
            var root = new GameObject("Cliff crystals").transform;
            root.SetParent(parent, false);
            var taken = new HashSet<Vector2Int>();
            foreach (var (p, outward) in ground.CliffSpots)
            {
                var cell = new Vector2Int(Mathf.FloorToInt(p.x / 3), Mathf.FloorToInt(p.y / 3));
                if (taken.Contains(cell) || Hash(p.x * 3.7f + p.y * 1.3f) > 0.45f) continue;
                taken.Add(cell);
                float h1 = Hash(p.x * 7.1f - p.y * 4.3f), h2 = Hash(p.x * 2.3f + p.y * 9.7f), h3 = Hash(p.x * 5.9f + p.y * 6.1f);
                var model = GlbLoader.Load($"models/crystal_small_{1 + Mathf.Min(4, (int)(h1 * 5))}");
                if (model == null) continue;
                float y = -1.2f - h2 * h2 * 9;
                float width = 2.2f + h3 * 1.6f; // near the small models' 3 tiles: the same pixel size
                var at = p + outward * (Ground.CliffLean(y) - 0.15f);
                var holder = new GameObject("Wall crystal").transform;
                holder.SetParent(root, false);
                holder.localPosition = new Vector3(at.x, y, -at.y);
                // Grown out of the rock: tilted from upright toward the void
                var dir = new Vector3(outward.x, 0.55f + h3 * 0.7f, -outward.y).normalized;
                holder.localRotation = Quaternion.FromToRotation(Vector3.up, dir) * Quaternion.Euler(0, h1 * 360, 0);
                float haze = Mathf.Round(Ground.CliffHaze(y) * 10) / 10;
                GlbLoader.Instantiate(model, holder, width, (tex, normal, doubleSided) => Material(tex, haze));
            }
        }

        static Material Material(Texture2D tex, float haze)
        {
            if (materials.TryGetValue((tex, haze), out var m) && m != null) return m;
            m = new Material(Materials.Model(tex, null, true)) { name = "Crystal" };
            m.SetFloat("_Emission", Glow);
            m.SetFloat("_HazeFixed", haze);
            m.SetColor("_HazeColor", Ground.Haze);
            materials[(tex, haze)] = m;
            return m;
        }

        static float Hash(float v) { float f = Mathf.Sin(v) * 9631.17f; return f - Mathf.Floor(f); }
    }
}
