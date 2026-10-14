using System.Collections.Generic;
using UnityEngine;

// Port of client/src/territory.js: the whole map split into irregular regions (Voronoi cells around
// jittered grid seeds). A region belongs to the last faction that held it alone: units count,
// buildings count triple; regions with several factions are contested and keep their owner.
// Purely visual - the server knows nothing about regions.
namespace RTS.Game
{
    public class TerritoryMap
    {
        public struct Thing { public string owner; public float x, y; public bool building; }

        const int RegionStep = 11;
        const float RefreshSeconds = 0.4f;
        const int Px = 4; // texture pixels per tile
        readonly int n;
        readonly int[] tiles;
        readonly short[] region;
        readonly Dictionary<int, string> owner = new Dictionary<int, string>();
        readonly Color32[] basePx;
        readonly Color32[] px;
        public readonly Texture2D Texture;
        float lastDraw = -1;

        public TerritoryMap(int[] tiles, int mapTiles)
        {
            n = mapTiles;
            this.tiles = tiles;
            region = BuildRegions();
            Texture = new Texture2D(n * Px, n * Px, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            basePx = new Color32[n * Px * n * Px];
            px = new Color32[basePx.Length];
            var colors = new Dictionary<int, Color32>
            {
                [Terrain.Grass] = new Color32(62, 110, 58, 255), [Terrain.Sand] = new Color32(196, 176, 120, 255),
                [Terrain.Water] = new Color32(52, 120, 170, 255), [Terrain.Bridge] = new Color32(120, 84, 48, 255),
            };
            for (int ty = 0; ty < n; ty++)
                for (int tx = 0; tx < n; tx++)
                {
                    var c = colors.TryGetValue(tiles[ty * n + tx], out var cc) ? cc : colors[Terrain.Grass];
                    Fill(basePx, tx, ty, c);
                }
        }

        static float Hash(float i, float j) { float v = Mathf.Sin(i * 127.1f + j * 311.7f) * 43758.5453f; return ((v % 1) + 1) % 1; }

        short[] BuildRegions()
        {
            var seeds = new List<Vector2>();
            for (int j = 0; j * RegionStep < n + RegionStep; j++)
                for (int i = 0; i * RegionStep < n + RegionStep; i++)
                    seeds.Add(new Vector2((i + 0.15f + Hash(i, j) * 0.7f) * RegionStep, (j + 0.15f + Hash(j + 7, i + 3) * 0.7f) * RegionStep));
            var r = new short[n * n];
            for (int ty = 0; ty < n; ty++)
                for (int tx = 0; tx < n; tx++)
                {
                    int best = 0;
                    float bestD = float.MaxValue;
                    for (int i = 0; i < seeds.Count; i++)
                    {
                        float d = (seeds[i].x - tx - 0.5f) * (seeds[i].x - tx - 0.5f) + (seeds[i].y - ty - 0.5f) * (seeds[i].y - ty - 0.5f);
                        if (d < bestD) { bestD = d; best = i; }
                    }
                    r[ty * n + tx] = (short)best;
                }
            return r;
        }

        // Texture row 0 is the bottom: tile row ty is drawn at the top for ty = 0
        void Fill(Color32[] buf, int tx, int ty, Color32 c)
        {
            int w = n * Px;
            for (int y = 0; y < Px; y++)
                for (int x = 0; x < Px; x++)
                    buf[((n - 1 - ty) * Px + y) * w + tx * Px + x] = c;
        }

        void Dot(int cx, int cy, int size, Color32 c)
        {
            int w = n * Px;
            for (int y = cy - size / 2; y <= cy + size / 2; y++)
                for (int x = cx - size / 2; x <= cx + size / 2; x++)
                    if (x >= 0 && y >= 0 && x < w && y < w) px[y * w + x] = c;
        }

        int RegionAt(float x, float y)
        {
            int tx = Mathf.Clamp(Mathf.FloorToInt(x / C.TileSize), 0, n - 1), ty = Mathf.Clamp(Mathf.FloorToInt(y / C.TileSize), 0, n - 1);
            return region[ty * n + tx];
        }

        public bool Due => Time.unscaledTime - lastDraw >= RefreshSeconds;

        // `things` are what the player knows about; the fog blacks out unexplored land and dims the
        // rest outside their sight
        public void Update(List<Thing> things, System.Func<string, int> colorOf, FogOfWar fog)
        {
            if (!Due) return;
            lastDraw = Time.unscaledTime;

            var presence = new Dictionary<int, Dictionary<string, int>>();
            foreach (var t in things)
            {
                if (t.owner == null) continue;
                int r = RegionAt(t.x, t.y);
                if (!presence.TryGetValue(r, out var m)) presence[r] = m = new Dictionary<string, int>();
                m.TryGetValue(t.owner, out var v);
                m[t.owner] = v + (t.building ? 3 : 1);
            }
            var contested = new HashSet<int>();
            foreach (var kv in presence)
            {
                if (kv.Value.Count == 1) foreach (var o in kv.Value.Keys) owner[kv.Key] = o;
                else contested.Add(kv.Key);
            }

            System.Array.Copy(basePx, px, px.Length);
            bool blink = (int)(Time.unscaledTime / 0.5f) % 2 == 0;
            for (int ty = 0; ty < n; ty++)
                for (int tx = 0; tx < n; tx++)
                {
                    int r = region[ty * n + tx];
                    owner.TryGetValue(r, out var o);
                    int right = tx + 1 < n ? region[ty * n + tx + 1] : r;
                    int down = ty + 1 < n ? region[(ty + 1) * n + tx] : r;
                    Color32 b = px[((n - 1 - ty) * Px) * n * Px + tx * Px];
                    Color c = b;
                    if (o != null)
                    {
                        float a = contested.Contains(r) && blink ? 0.2f : 0.45f;
                        c = Color.Lerp(c, GameAssets.Hex(colorOf(o)), a);
                    }
                    if (right != r || down != r)
                    {
                        owner.TryGetValue(right, out var or);
                        owner.TryGetValue(down, out var od);
                        bool frontier = o != or || o != od;
                        c = Color.Lerp(c, frontier ? new Color(0.1f, 0.07f, 0.03f) : Color.black, frontier ? 0.9f : 0.3f);
                    }
                    float light = fog.Brightness(tx, ty);
                    c = new Color(c.r * light, c.g * light, c.b * light, 1);
                    Fill(px, tx, ty, c);
                }
            float k = Px / (float)C.TileSize;
            foreach (var t in things)
            {
                if (t.owner == null) continue;
                int x = Mathf.RoundToInt(t.x * k), y = n * Px - 1 - Mathf.RoundToInt(t.y * k);
                int size = t.building ? 7 : 3;
                Dot(x, y, size + 2, new Color32(0, 0, 0, 255));
                Dot(x, y, size, GameAssets.Hex(colorOf(t.owner)));
            }
            Texture.SetPixels32(px);
            Texture.Apply();
        }
    }
}
