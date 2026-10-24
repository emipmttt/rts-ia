using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// 3D terrain built from the server's tile map (grass / sand / water / bridge). Heights are purely
// visual: Perlin fBm hills that flatten into low banks along the rivers, riverbeds carved under the
// water plane, and mountains framing the map. The ground texture is the original pixel-art grass
// with sand, riverbed and rock on steep slopes blended in by soft blob masks (like the 2D client's
// drawGround).
// The spirit dimension (Spirit) reads the same tile map another way: red grass and taller grey
// mountains; the rivers and the sea are a bottomless void walled by sheer pixel-art cliffs (rust rock
// over grey stone columns) that sink into a white haze; the sand roads and stretches of the shore are
// shallow water that pours over the edge in waterfalls, and mist drifts far below. Crystal tiles
// stand on low rocky mounds (the crystals themselves are World/Crystals.cs).
// Coordinates: server px (x, y) -> Unity (x / 40, height, -y / 40).
namespace RTS.World
{
    public class Ground : MonoBehaviour
    {
        public const float WaterLevel = 0f;
        public const float DeckHeight = 0.3f;
        const int Res = 2; // vertices per tile
        public const int Margin = 12; // decorative tiles around the map
        const int TexPx = 16; // ground texture pixels per tile (the art's own resolution)
        const float HillHeight = 11f;
        const float SpiritHillHeight = 17f;
        public const float VoidDepth = 30f;       // spirit: how far the cliffs drop into the void
        public static readonly Color Haze = new Color(0.95f, 0.95f, 0.98f); // spirit: the void's white mist
        public const float ShallowLevel = 0.28f;  // spirit: surface of the shallow water
        const int ChunkQuads = 32; // render chunk side in quads (16 tiles), culled one by one off screen

        public int N { get; private set; } // map side in tiles
        int[] tiles;
        int side; // vertices per side
        float[] heights;
        Vector3[] vertices;
        Vector3[] normals;
        Mesh mesh;                 // the whole terrain, for the collider (picking)
        MeshCollider meshCollider;
        readonly List<Chunk> chunks = new List<Chunk>();
        float seedX, seedY;
        float[] sdField;            // signed distance to the water per tile (see SignedDistance), margin included
        Vector2[] offsets;          // spirit: void vertices pulled back onto the land's edge (tile units)
        bool[] voidVert;            // spirit: vertices down in the void
        bool dirty;
        RectInt dirtyRect;         // vertex range changed since the last upload

        class Chunk { public int i0, j0, i1, j1; public Mesh mesh; public Vector3[] vertices, normals; }
        readonly HashSet<int> flattened = new HashSet<int>();
        Material waterMaterial;
        Texture2D[] waterFrames;
        public bool Spirit { get; private set; }
        Material fallMaterial;
        Texture2D[] fallFrames;
        readonly List<Transform> mists = new List<Transform>();

        public static Ground Build(Transform parent, int[] tiles, bool spirit = false)
        {
            var go = new GameObject("Ground");
            go.transform.SetParent(parent, false);
            var g = go.AddComponent<Ground>();
            g.Spirit = spirit;
            g.Init(tiles);
            return g;
        }

        float Hills => Spirit ? SpiritHillHeight : HillHeight;

        public int TileAt(int tx, int ty) => tx < 0 || ty < 0 || tx >= N || ty >= N ? Terrain.Grass : tiles[ty * N + tx];
        bool IsWet(int tx, int ty) { int t = TileAt(tx, ty); return t == Terrain.Water || t == Terrain.Bridge; }

        void Init(int[] tileData)
        {
            tiles = tileData;
            N = Mathf.RoundToInt(Mathf.Sqrt(tiles.Length));
            // Same seed for every Unity client: hash of the tile map
            uint hash = 2166136261;
            foreach (var t in tiles) hash = (hash ^ (uint)t) * 16777619;
            seedX = (hash % 10000) * 0.731f;
            seedY = (hash / 10000 % 10000) * 0.417f;

            BuildHeights();
            BuildMesh();
            if (Spirit)
            {
                BuildShallows();
                BuildCliffs();
                BuildWaterfalls();
                BuildMist();
            }
            else BuildWater();
            BuildBridges();
        }

        // ---------- Heights ----------

        float Fbm(float x, float y)
        {
            float sum = 0, amp = 0.5f, freq = 1, norm = 0;
            for (int o = 0; o < 4; o++)
            {
                sum += Mathf.PerlinNoise(seedX + x * freq, seedY + y * freq) * amp;
                norm += amp;
                amp *= 0.5f;
                freq *= 2.03f;
            }
            return sum / norm;
        }

        // Signed distance in tiles: positive on land (to the nearest water tile), negative in water
        float[] SignedDistance()
        {
            int w = N + 2 * Margin;
            var land = new float[w * w];
            var water = new float[w * w];
            const float Inf = 1e6f;
            for (int j = 0; j < w; j++)
                for (int i = 0; i < w; i++)
                {
                    bool wet = IsWet(i - Margin, j - Margin);
                    land[j * w + i] = wet ? 0 : Inf;
                    water[j * w + i] = wet ? Inf : 0;
                }
            Chamfer(land, w);
            Chamfer(water, w);
            var sd = new float[w * w];
            for (int k = 0; k < sd.Length; k++) sd[k] = land[k] > 0 ? Mathf.Min(land[k], 40) : -Mathf.Min(water[k], 40);
            return sd;
        }

        static void Chamfer(float[] d, int w)
        {
            const float a = 1f, b = 1.4142f;
            for (int j = 0; j < w; j++)
                for (int i = 0; i < w; i++)
                {
                    float v = d[j * w + i];
                    if (i > 0) v = Mathf.Min(v, d[j * w + i - 1] + a);
                    if (j > 0) v = Mathf.Min(v, d[(j - 1) * w + i] + a);
                    if (i > 0 && j > 0) v = Mathf.Min(v, d[(j - 1) * w + i - 1] + b);
                    if (i < w - 1 && j > 0) v = Mathf.Min(v, d[(j - 1) * w + i + 1] + b);
                    d[j * w + i] = v;
                }
            for (int j = w - 1; j >= 0; j--)
                for (int i = w - 1; i >= 0; i--)
                {
                    float v = d[j * w + i];
                    if (i < w - 1) v = Mathf.Min(v, d[j * w + i + 1] + a);
                    if (j < w - 1) v = Mathf.Min(v, d[(j + 1) * w + i] + a);
                    if (i < w - 1 && j < w - 1) v = Mathf.Min(v, d[(j + 1) * w + i + 1] + b);
                    if (i > 0 && j < w - 1) v = Mathf.Min(v, d[(j + 1) * w + i - 1] + b);
                    d[j * w + i] = v;
                }
        }

        void BuildHeights()
        {
            int w = N + 2 * Margin;
            side = w * Res + 1;
            heights = new float[side * side];
            offsets = new Vector2[side * side];
            voidVert = new bool[side * side];
            sdField = SignedDistance();

            for (int j = 0; j < side; j++)
                for (int i = 0; i < side; i++)
                {
                    float u = (float)i / Res - Margin, v = (float)j / Res - Margin;
                    float d = Sd(u, v);
                    float h;
                    if (d < 0 && Spirit)
                    {
                        // The void: the ground drops to the bottom at once, and the vertices next to the
                        // land are pulled back onto its edge so the drop is a vertical wall right there,
                        // behind the cliff face (BuildCliffs)
                        h = -VoidDepth - 2;
                        voidVert[j * side + i] = true;
                        if (d > -1.2f) offsets[j * side + i] = SdGradient(u, v) * (-d + 0.03f);
                    }
                    else if (d < 0)
                    {
                        h = WaterLevel - 0.12f + d * 0.55f; // riverbed deepens toward the middle
                        h = Mathf.Max(h, WaterLevel - 1.1f);
                    }
                    else
                    {
                        // Rolling hills where the low-frequency noise is high, gentle bumps elsewhere
                        float n = Fbm(u * 0.05f, v * 0.05f);
                        float hills = Mathf.Pow(Mathf.Max(0, n - 0.4f), 1.3f) * Hills
                                      + (Fbm(u * 0.2f + 40, v * 0.2f + 40) - 0.5f) * 0.6f;
                        // Spirit: the cliff's lip stands above the shallow water. Classic: the bank runs on
                        // from the riverbed and comes out of the water a third of a tile in, so units by
                        // the river wade along its edge
                        float bank = Spirit ? ShallowLevel + 0.1f + Mathf.Min(d, 1.5f) * 0.18f
                            : Mathf.Lerp(WaterLevel - 0.1f + Mathf.Min(d, 1.5f) * 0.3f, WaterLevel + 0.1f + Mathf.Min(d, 1.5f) * 0.18f, BridgeNear(u, v));
                        h = Mathf.Lerp(bank, bank + Mathf.Max(0, hills), Mathf.SmoothStep(0, 1, Mathf.Clamp01((d - 0.3f) / 3.5f)));
                        if (Spirit)
                        {
                            // The sand roads and the shores where waterfalls spill sink under the shallow
                            // water; crystal outcrops stand on low mounds
                            h = Mathf.Lerp(h, ShallowLevel - 0.2f, Mathf.Max(SandNear(u, v), FallsNear(u, v, d)));
                            h += CrystalNear(u, v) * 0.45f;
                        }
                    }
                    // Mountains outside the playable map
                    float outside = Mathf.Max(Mathf.Max(-u, u - N), Mathf.Max(-v, v - N));
                    if (outside > 0 && !voidVert[j * side + i])
                    {
                        float k = Mathf.Clamp01(outside / Margin);
                        h = Mathf.Max(h, 0.2f) + Mathf.Pow(k, 1.4f) * (5 + Fbm(u * 0.12f, v * 0.12f) * 9);
                    }
                    heights[j * side + i] = h;
                }
        }

        // Bilinear sample of the tile-centre distance field at tile coords (u, v): positive on land,
        // negative over water, zero on the tiles' shared edges
        float Sd(float u, float v)
        {
            int w = N + 2 * Margin;
            float fx = u + Margin - 0.5f, fy = v + Margin - 0.5f;
            int x0 = Mathf.Clamp(Mathf.FloorToInt(fx), 0, w - 1), y0 = Mathf.Clamp(Mathf.FloorToInt(fy), 0, w - 1);
            int x1 = Mathf.Min(x0 + 1, w - 1), y1 = Mathf.Min(y0 + 1, w - 1);
            float tx = Mathf.Clamp01(fx - x0), ty = Mathf.Clamp01(fy - y0);
            // Tile centres hold +-distance; shift by 0.5 so the bank sits on the tile edge
            float S(int x, int y) { float d = sdField[y * w + x]; return d > 0 ? d - 0.5f : d + 0.5f; }
            return Mathf.Lerp(Mathf.Lerp(S(x0, y0), S(x1, y0), tx), Mathf.Lerp(S(x0, y1), S(x1, y1), tx), ty);
        }

        // Direction (tile coords) in which the distance grows fastest: from the water toward the land
        Vector2 SdGradient(float u, float v)
        {
            const float e = 0.25f;
            var g = new Vector2(Sd(u + e, v) - Sd(u - e, v), Sd(u, v + e) - Sd(u, v - e));
            return g.sqrMagnitude > 1e-6f ? g.normalized : Vector2.zero;
        }

        // Spirit: stretches of the void's edge where the shallows spill over in waterfalls (a noise mask
        // along the map), 0..1
        float Falls(float u, float v) =>
            Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.6f, 0.66f, Mathf.PerlinNoise(seedX * 0.37f + 300 + u * 0.16f, seedY * 0.37f + 300 + v * 0.16f)));

        // ... and how much the ground at (u, v), `d` tiles from the edge, sinks under the shallows there
        float FallsNear(float u, float v, float d) => Falls(u, v) * Mathf.SmoothStep(0, 1, Mathf.InverseLerp(1.5f, 0.5f, d));

        // 1 within a tile of a bridge, fading out by two: the banks stay dry where the bridges land
        float BridgeNear(float u, float v)
        {
            float best = 9;
            int cx = Mathf.FloorToInt(u), cy = Mathf.FloorToInt(v);
            for (int y = cy - 2; y <= cy + 2; y++)
                for (int x = cx - 2; x <= cx + 2; x++)
                    if (TileAt(x, y) == Terrain.Bridge) best = Mathf.Min(best, Mathf.Max(Mathf.Abs(x + 0.5f - u), Mathf.Abs(y + 0.5f - v)) - 0.5f);
            return Mathf.InverseLerp(2, 1, best);
        }

        // How much of the ground around tile coords (u, v) is crystal (0..1), for the spirit outcrops' mounds
        float CrystalNear(float u, float v)
        {
            float k = 0;
            for (int dy = -1; dy <= 1; dy += 2)
                for (int dx = -1; dx <= 1; dx += 2)
                    if (TileAt(Mathf.FloorToInt(u + dx * 0.7f), Mathf.FloorToInt(v + dy * 0.7f)) == Terrain.Crystal) k += 0.25f;
            return k;
        }

        // How much of the ground around tile coords (u, v) is sand (0..1), for sinking the spirit roads
        float SandNear(float u, float v)
        {
            float k = 0;
            for (int dy = -1; dy <= 1; dy += 2)
                for (int dx = -1; dx <= 1; dx += 2)
                    if (TileAt(Mathf.FloorToInt(u + dx * 0.45f), Mathf.FloorToInt(v + dy * 0.45f)) == Terrain.Sand) k += 0.25f;
            return k;
        }

        // Height at server tile coords (u, v) (continuous), bilinear over the vertex grid
        public float HeightAtTile(float u, float v)
        {
            float fx = (u + Margin) * Res, fy = (v + Margin) * Res;
            int x0 = Mathf.Clamp(Mathf.FloorToInt(fx), 0, side - 2), y0 = Mathf.Clamp(Mathf.FloorToInt(fy), 0, side - 2);
            float tx = Mathf.Clamp01(fx - x0), ty = Mathf.Clamp01(fy - y0);
            float a = heights[y0 * side + x0], b = heights[y0 * side + x0 + 1];
            float c = heights[(y0 + 1) * side + x0], d = heights[(y0 + 1) * side + x0 + 1];
            return Mathf.Lerp(Mathf.Lerp(a, b, tx), Mathf.Lerp(c, d, tx), ty);
        }

        // Where something standing at server px (x, y) touches the ground (bridge decks included)
        public float GroundY(float x, float y)
        {
            float u = x / C.TileSize, v = y / C.TileSize;
            float h = HeightAtTile(u, v);
            if (TileAt(Mathf.FloorToInt(u), Mathf.FloorToInt(v)) == Terrain.Bridge) h = Mathf.Max(h, DeckHeight + 0.06f);
            return h;
        }

        // Level of the water's surface (classic rivers, spirit shallows)
        public float WaterSurface => Spirit ? ShallowLevel : WaterLevel;

        // How deep in water something standing at server px (x, y) is (0 on dry ground and bridges)
        public float WaterDepth(float x, float y) => Mathf.Max(0, WaterSurface - GroundY(x, y));

        public Vector3 ToWorld(float x, float y, float lift = 0) => new Vector3(x * C.PxToUnit, GroundY(x, y) + lift, -y * C.PxToUnit);
        public static Vector2 ToServer(Vector3 p) => new Vector2(p.x * C.TileSize, -p.z * C.TileSize);

        public Vector3 Normal(float x, float y)
        {
            float u = x / C.TileSize, v = y / C.TileSize, e = 0.5f;
            float dx = HeightAtTile(u + e, v) - HeightAtTile(u - e, v);
            float dz = HeightAtTile(u, v - e) - HeightAtTile(u, v + e);
            return new Vector3(-dx, 2 * e, -dz).normalized;
        }

        // Levels the ground under a building (once per building) so it stands on a flat terrace
        public void Flatten(int id, int tx, int ty, int size)
        {
            if (!flattened.Add(id)) return;
            float sum = 0;
            int count = 0;
            int i0 = (tx + Margin) * Res, j0 = (ty + Margin) * Res, i1 = (tx + size + Margin) * Res, j1 = (ty + size + Margin) * Res;
            for (int j = j0; j <= j1; j++)
                for (int i = i0; i <= i1; i++)
                    if (!voidVert[j * side + i]) { sum += heights[j * side + i]; count++; }
            if (count == 0) return;
            float target = Mathf.Max(WaterLevel + 0.12f, sum / count);
            const int Blend = Res * 2;
            for (int j = j0 - Blend; j <= j1 + Blend; j++)
                for (int i = i0 - Blend; i <= i1 + Blend; i++)
                {
                    if (i < 0 || j < 0 || i >= side || j >= side) continue;
                    int dx = Mathf.Max(0, Mathf.Max(i0 - i, i - i1)), dy = Mathf.Max(0, Mathf.Max(j0 - j, j - j1));
                    float k = Mathf.Clamp01(Mathf.Max(dx, dy) / (float)Blend);
                    k = k * k * (3 - 2 * k);
                    int idx = j * side + i;
                    if (voidVert[idx]) continue; // the void stays bottomless
                    heights[idx] = Mathf.Lerp(target, heights[idx], k);
                }
            var rect = new RectInt(i0 - Blend - 1, j0 - Blend - 1, i1 - i0 + 2 * Blend + 3, j1 - j0 + 2 * Blend + 3);
            if (!dirty) dirtyRect = rect;
            else
            {
                int xMin = Mathf.Min(dirtyRect.xMin, rect.xMin), yMin = Mathf.Min(dirtyRect.yMin, rect.yMin);
                dirtyRect = new RectInt(xMin, yMin, Mathf.Max(dirtyRect.xMax, rect.xMax) - xMin, Mathf.Max(dirtyRect.yMax, rect.yMax) - yMin);
            }
            dirty = true;
        }

        void LateUpdate()
        {
            if (waterFrames != null) waterMaterial.SetTexture("_MainTex", waterFrames[(int)(Time.time / 0.5f) % 2]);
            if (fallFrames != null) fallMaterial.SetTexture("_MainTex", fallFrames[(int)(Time.time / 0.07f) % fallFrames.Length]);
            for (int i = 0; i < mists.Count; i++)
            {
                // Each layer drifts its own way, wrapping every 4 tiles (the texture repeats)
                float t = Time.time * (0.12f + i * 0.05f);
                mists[i].localPosition = new Vector3(Mathf.Repeat(t, 4) - 2, mists[i].localPosition.y, Mathf.Repeat(t * (i % 2 == 0 ? 0.6f : -0.8f), 4) - 2);
            }
            if (!dirty) return;
            dirty = false;
            UpdateVertices();
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.RecalculateBounds();
            meshCollider.sharedMesh = null;
            meshCollider.sharedMesh = mesh;
            RepaintGround(dirtyRect);
            foreach (var c in chunks)
                if (c.i1 >= dirtyRect.xMin && c.i0 <= dirtyRect.xMax && c.j1 >= dirtyRect.yMin && c.j0 <= dirtyRect.yMax) UploadChunk(c);
        }

        // ---------- Mesh ----------

        void UpdateVertices()
        {
            for (int j = 0; j < side; j++)
                for (int i = 0; i < side; i++)
                {
                    float u = (float)i / Res - Margin, v = (float)j / Res - Margin;
                    var o = offsets[j * side + i];
                    vertices[j * side + i] = new Vector3(u + o.x, heights[j * side + i], -(v + o.y));
                }
            for (int j = 0; j < side; j++)
                for (int i = 0; i < side; i++)
                {
                    float l = heights[j * side + Mathf.Max(0, i - 1)], r = heights[j * side + Mathf.Min(side - 1, i + 1)];
                    float n = heights[Mathf.Max(0, j - 1) * side + i], s = heights[Mathf.Min(side - 1, j + 1) * side + i];
                    // x grows with i; z shrinks with j (z = -v)
                    normals[j * side + i] = new Vector3(l - r, 2f / Res, s - n).normalized;
                }
        }

        void BuildMesh()
        {
            vertices = new Vector3[side * side];
            normals = new Vector3[side * side];
            var uv = new Vector2[side * side];
            var colors = new Color32[side * side];
            int w = N + 2 * Margin;
            for (int j = 0; j < side; j++)
                for (int i = 0; i < side; i++)
                {
                    uv[j * side + i] = new Vector2((float)i / (side - 1), 1 - (float)j / (side - 1));
                    float u = (float)i / Res - Margin, v = (float)j / Res - Margin;
                    float outside = Mathf.Max(Mathf.Max(-u, u - N), Mathf.Max(-v, v - N));
                    float h = heights[j * side + i];
                    // Hilltops a touch lighter (cool, never yellow), the mountains around the map grey-blue
                    float lift = Mathf.Clamp01(h / Hills);
                    var c = Color.Lerp(new Color(0.95f, 0.97f, 0.97f), new Color(1.04f, 1.06f, 1.05f), lift);
                    if (outside > 0) c = Color.Lerp(c, new Color(0.78f, 0.82f, 0.84f), Mathf.Clamp01(outside / 6f));
                    // Spirit: the void fades into its white haze (alpha drives the shader's _Haze)
                    if (Spirit) c.a = h < -1 ? Mathf.Clamp01(1 - (-h - 1) / (VoidDepth * 0.5f)) : 1;
                    else if (h < 0) c = Color.Lerp(c, Color.white, Mathf.Clamp01(-h / (VoidDepth * 0.6f)));
                    colors[j * side + i] = c;
                }
            UpdateVertices();
            var tris = new int[(side - 1) * (side - 1) * 6];
            int t = 0;
            for (int j = 0; j < side - 1; j++)
                for (int i = 0; i < side - 1; i++)
                {
                    int a = j * side + i, b = a + 1, c = a + side, d = c + 1;
                    tris[t++] = a; tris[t++] = b; tris[t++] = d;
                    tris[t++] = a; tris[t++] = d; tris[t++] = c;
                }
            mesh = new Mesh { indexFormat = IndexFormat.UInt32, name = "Terrain" };
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.uv = uv;
            mesh.colors32 = colors;
            mesh.triangles = tris;
            mesh.RecalculateBounds();
            meshCollider = gameObject.AddComponent<MeshCollider>();
            meshCollider.sharedMesh = mesh;

            // Drawn in chunks so the ones off screen (and their shadows) are skipped
            var mat = new Material(Shader.Find("RTS/Terrain"));
            mat.SetTexture("_MainTex", BuildGroundTexture());
            if (Spirit)
            {
                mat.SetFloat("_Haze", 1);
                mat.SetColor("_HazeColor", Haze);
            }
            for (int cj = 0; cj < side - 1; cj += ChunkQuads)
                for (int ci = 0; ci < side - 1; ci += ChunkQuads)
                    BuildChunk(ci, cj, Mathf.Min(ci + ChunkQuads, side - 1), Mathf.Min(cj + ChunkQuads, side - 1), uv, colors, mat);
        }

        void BuildChunk(int i0, int j0, int i1, int j1, Vector2[] uv, Color32[] colors, Material mat)
        {
            int cw = i1 - i0 + 1, ch = j1 - j0 + 1;
            var c = new Chunk { i0 = i0, j0 = j0, i1 = i1, j1 = j1, vertices = new Vector3[cw * ch], normals = new Vector3[cw * ch] };
            var cuv = new Vector2[cw * ch];
            var ccol = new Color32[cw * ch];
            for (int j = 0; j < ch; j++)
                for (int i = 0; i < cw; i++)
                {
                    int g = (j0 + j) * side + i0 + i;
                    cuv[j * cw + i] = uv[g];
                    ccol[j * cw + i] = colors[g];
                }
            var tris = new int[(cw - 1) * (ch - 1) * 6];
            int t = 0;
            for (int j = 0; j < ch - 1; j++)
                for (int i = 0; i < cw - 1; i++)
                {
                    int a = j * cw + i, b = a + 1, cc = a + cw, d = cc + 1;
                    tris[t++] = a; tris[t++] = b; tris[t++] = d;
                    tris[t++] = a; tris[t++] = d; tris[t++] = cc;
                }
            c.mesh = new Mesh { name = $"Terrain {i0},{j0}" };
            CopyChunk(c);
            c.mesh.vertices = c.vertices;
            c.mesh.normals = c.normals;
            c.mesh.uv = cuv;
            c.mesh.colors32 = ccol;
            c.mesh.triangles = tris;
            c.mesh.RecalculateBounds();
            var go = new GameObject(c.mesh.name);
            go.transform.SetParent(transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = c.mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = mat;
            mr.shadowCastingMode = ShadowCastingMode.On;
            mr.receiveShadows = true;
            chunks.Add(c);
        }

        void CopyChunk(Chunk c)
        {
            int cw = c.i1 - c.i0 + 1;
            for (int j = c.j0; j <= c.j1; j++)
            {
                System.Array.Copy(vertices, j * side + c.i0, c.vertices, (j - c.j0) * cw, cw);
                System.Array.Copy(normals, j * side + c.i0, c.normals, (j - c.j0) * cw, cw);
            }
        }

        void UploadChunk(Chunk c)
        {
            CopyChunk(c);
            c.mesh.vertices = c.vertices;
            c.mesh.normals = c.normals;
            c.mesh.RecalculateBounds();
        }

        // ---------- Ground texture ----------

        const int MaskRes = 4;      // mask samples per tile
        const float RockSlope = 0.2f; // 1 - normal.y from which the ground is bare rock (about 37°)
        int maskW;
        float[] sandMask, bedMask, rockRaw, rockMask, highMask;
        Color32[] grassPx, sandPx, rockPx, groundPx;
        Texture2D groundTex;

        // Pixel-art grass everywhere; sand on sand tiles and a wider sandy shore + riverbed around
        // the water, rock on steep slopes; each cut out by soft blob masks so they fade into the grass
        Texture2D BuildGroundTexture()
        {
            int w = N + 2 * Margin;
            maskW = w * MaskRes;
            int mw = maskW;
            sandMask = new float[mw * mw];
            bedMask = new float[mw * mw];
            for (int j = 0; j < mw; j++)
                for (int i = 0; i < mw; i++)
                {
                    float u = (i + 0.5f) / MaskRes - Margin, v = (j + 0.5f) / MaskRes - Margin;
                    int cx = Mathf.FloorToInt(u), cy = Mathf.FloorToInt(v);
                    float s = 0, b = 0;
                    for (int dy = -2; dy <= 2; dy++)
                        for (int dx = -2; dx <= 2; dx++)
                        {
                            int tx = cx + dx, ty = cy + dy;
                            float dist = Mathf.Sqrt((tx + 0.5f - u) * (tx + 0.5f - u) + (ty + 0.5f - v) * (ty + 0.5f - v));
                            int tile = TileAt(tx, ty);
                            if (tile == Terrain.Sand && dist < 0.85f) s = 1;
                            if ((tile == Terrain.Water || tile == Terrain.Bridge) && dist < 1.6f) s = 1;
                            if ((tile == Terrain.Water || tile == Terrain.Bridge) && dist < 0.95f && !Spirit) b = 1;
                        }
                    sandMask[j * mw + i] = s;
                    bedMask[j * mw + i] = b;
                }
            BoxBlur(sandMask, mw, 2);
            BoxBlur(bedMask, mw, 2);
            rockRaw = new float[mw * mw];
            rockMask = new float[mw * mw];
            UpdateRock(0, 0, mw - 1, mw - 1);
            if (Spirit)
            {
                // Grey stone over the high ground: the mountains are bare rock from about half way up
                highMask = new float[mw * mw];
                for (int j = 0; j < mw; j++)
                    for (int i = 0; i < mw; i++)
                    {
                        float u = (i + 0.5f) / MaskRes - Margin, v = (j + 0.5f) / MaskRes - Margin;
                        highMask[j * mw + i] = Mathf.SmoothStep(0, 1, Mathf.Clamp01((HeightAtTile(u, v) - 3.5f) / 3f));
                    }
            }

            int size = w * TexPx;
            grassPx = (Spirit ? GameAssets.SpiritGrass : GameAssets.Grass).GetPixels32();
            sandPx = (Spirit ? GameAssets.SpiritShallowBed : GameAssets.Sand).GetPixels32();
            rockPx = (Spirit ? GameAssets.SpiritRock : GameAssets.Cliff).GetPixels32();
            groundPx = new Color32[size * size];
            groundTex = new Texture2D(size, size, TextureFormat.RGBA32, true) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, anisoLevel = 4 };
            PaintGround(0, 0, size - 1, size - 1);
            groundTex.SetPixels32(groundPx);
            groundTex.Apply(true);
            return groundTex;
        }

        // Steep cells of the rock mask in a range of mask cells, then the blurred mask (like sand's)
        void UpdateRock(int i0, int j0, int i1, int j1)
        {
            int mw = maskW;
            const float e = 0.25f;
            for (int j = Mathf.Max(0, j0); j <= Mathf.Min(mw - 1, j1); j++)
                for (int i = Mathf.Max(0, i0); i <= Mathf.Min(mw - 1, i1); i++)
                {
                    float u = (i + 0.5f) / MaskRes - Margin, v = (j + 0.5f) / MaskRes - Margin;
                    float dx = (HeightAtTile(u + e, v) - HeightAtTile(u - e, v)) / (2 * e);
                    float dz = (HeightAtTile(u, v + e) - HeightAtTile(u, v - e)) / (2 * e);
                    float ny = 1 / Mathf.Sqrt(1 + dx * dx + dz * dz);
                    rockRaw[j * mw + i] = 1 - ny > RockSlope || TileAt(Mathf.FloorToInt(u), Mathf.FloorToInt(v)) == Terrain.Crystal ? 1 : 0;
                }
            System.Array.Copy(rockRaw, rockMask, rockRaw.Length);
            BoxBlur(rockMask, mw, 2);
        }

        // Paints texture pixels [x0..x1] x [y0..y1] (row 0 = the map's south edge) from the masks
        void PaintGround(int x0, int y0, int x1, int y1)
        {
            int size = maskW / MaskRes * TexPx, mw = maskW;
            x0 = Mathf.Max(0, x0); y0 = Mathf.Max(0, y0); x1 = Mathf.Min(size - 1, x1); y1 = Mathf.Min(size - 1, y1);
            var wet = new Color32(120, 104, 74, 255);
            for (int y = y0; y <= y1; y++)
            {
                float v = (size - 1 - y + 0.5f) / TexPx;
                for (int x = x0; x <= x1; x++)
                {
                    float u = (x + 0.5f) / TexPx;
                    int tp = (y % 16) * 16 + (x % 16);
                    float ms = SampleMask(sandMask, mw, u * MaskRes, v * MaskRes);
                    float mb = SampleMask(bedMask, mw, u * MaskRes, v * MaskRes);
                    float mr = SampleMask(rockMask, mw, u * MaskRes, v * MaskRes);
                    // Hard-ish edges with a 2-pixel dither keep the pixel-art look
                    float dither = (((x >> 1) + (y >> 1)) & 1) * 0.08f - 0.04f;
                    float ks = Mathf.SmoothStep(0, 1, Mathf.Clamp01((ms + dither - 0.35f) / 0.3f));
                    // Sand (river banks, beaches) always wins over rock
                    float kr = Mathf.SmoothStep(0, 1, Mathf.Clamp01((mr + dither - 0.35f) / 0.3f)) * (1 - ks);
                    if (highMask != null) kr = Mathf.Max(kr, Mathf.SmoothStep(0, 1, Mathf.Clamp01((SampleMask(highMask, mw, u * MaskRes, v * MaskRes) + dither - 0.35f) / 0.3f)));
                    float kb = Mathf.SmoothStep(0, 1, Mathf.Clamp01((mb + dither - 0.4f) / 0.3f));
                    var c = Color32.Lerp(grassPx[tp], sandPx[tp], ks);
                    c = Color32.Lerp(c, rockPx[tp], kr);
                    c = Color32.Lerp(c, new Color32((byte)(sandPx[tp].r * wet.r / 255), (byte)(sandPx[tp].g * wet.g / 255), (byte)(sandPx[tp].b * wet.b / 255), 255), kb);
                    groundPx[y * size + x] = c;
                }
            }
        }

        // After a terrace is levelled: recompute rock around it and repaint that part of the texture
        void RepaintGround(RectInt verts)
        {
            const int Pad = 3; // tiles: blur reach and smoothing around the change
            int tx0 = verts.xMin / Res - Pad, ty0 = verts.yMin / Res - Pad, tx1 = verts.xMax / Res + Pad, ty1 = verts.yMax / Res + Pad;
            UpdateRock(tx0 * MaskRes, ty0 * MaskRes, tx1 * MaskRes, ty1 * MaskRes);
            int size = maskW / MaskRes * TexPx;
            PaintGround(tx0 * TexPx, size - (ty1 + 1) * TexPx, (tx1 + 1) * TexPx - 1, size - ty0 * TexPx - 1);
            groundTex.SetPixels32(groundPx);
            groundTex.Apply(true);
        }

        static float SampleMask(float[] m, int w, float fx, float fy)
        {
            fx -= 0.5f; fy -= 0.5f;
            int x0 = Mathf.Clamp((int)Mathf.Floor(fx), 0, w - 1), y0 = Mathf.Clamp((int)Mathf.Floor(fy), 0, w - 1);
            int x1 = Mathf.Min(x0 + 1, w - 1), y1 = Mathf.Min(y0 + 1, w - 1);
            float tx = Mathf.Clamp01(fx - x0), ty = Mathf.Clamp01(fy - y0);
            return Mathf.Lerp(Mathf.Lerp(m[y0 * w + x0], m[y0 * w + x1], tx), Mathf.Lerp(m[y1 * w + x0], m[y1 * w + x1], tx), ty);
        }

        static void BoxBlur(float[] m, int w, int passes)
        {
            var tmp = new float[m.Length];
            for (int p = 0; p < passes; p++)
            {
                for (int y = 0; y < w; y++)
                    for (int x = 0; x < w; x++)
                    {
                        float s = 0;
                        for (int k = -1; k <= 1; k++) s += m[y * w + Mathf.Clamp(x + k, 0, w - 1)];
                        tmp[y * w + x] = s / 3;
                    }
                for (int y = 0; y < w; y++)
                    for (int x = 0; x < w; x++)
                    {
                        float s = 0;
                        for (int k = -1; k <= 1; k++) s += tmp[Mathf.Clamp(y + k, 0, w - 1) * w + x];
                        m[y * w + x] = s / 3;
                    }
            }
        }

        // ---------- Water ----------

        void BuildWater()
        {
            // Over the river tiles and their banks (the shore dips under the surface)
            bool Near(int tx, int ty)
            {
                for (int dy = -1; dy <= 1; dy++)
                    for (int dx = -1; dx <= 1; dx++) if (IsWet(tx + dx, ty + dy)) return true;
                return false;
            }
            BuildWaterSurface("Water", WaterLevel, Near, GameAssets.Water, 0.86f, 1f, 0.04f);
        }

        // The water surface at `level`: one quad per tile where `has`, so the shader's swell can move
        // it; the shader reads the water's depth from a texture baked from the terrain heights
        void BuildWaterSurface(string name, float level, System.Func<int, int, bool> has, Texture2D[] frames, float alpha, float deepAt, float swell)
        {
            var verts = new List<Vector3>();
            var tris = new List<int>();
            for (int ty = -Margin; ty < N + Margin; ty++)
                for (int tx = -Margin; tx < N + Margin; tx++)
                {
                    if (!has(tx, ty)) continue;
                    int i = verts.Count;
                    verts.Add(new Vector3(tx, level, -ty)); verts.Add(new Vector3(tx + 1, level, -ty));
                    verts.Add(new Vector3(tx, level, -(ty + 1))); verts.Add(new Vector3(tx + 1, level, -(ty + 1)));
                    tris.AddRange(new[] { i, i + 1, i + 3, i, i + 3, i + 2 });
                }
            var m = new Mesh { indexFormat = IndexFormat.UInt32, name = name };
            m.SetVertices(verts);
            m.SetTriangles(tris, 0);
            var normals = new Vector3[verts.Count];
            for (int k = 0; k < normals.Length; k++) normals[k] = Vector3.up;
            m.normals = normals;
            m.RecalculateBounds();
            m.bounds = new Bounds(m.bounds.center, m.bounds.size + Vector3.up); // room for the swell
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = go.AddComponent<MeshRenderer>();

            // Depth below the surface at every terrain vertex
            const float Range = 1.2f;
            var px = new byte[side * side];
            for (int k = 0; k < px.Length; k++) px[k] = (byte)Mathf.RoundToInt(Mathf.Clamp01((level - heights[k]) / Range) * 255);
            var depth = new Texture2D(side, side, TextureFormat.R8, false, true) { name = name + " depth", wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            depth.SetPixelData(px, 0);
            depth.Apply(false, true);

            waterMaterial = new Material(Shader.Find("RTS/Water"));
            waterFrames = frames;
            waterMaterial.SetTexture("_MainTex", waterFrames[0]);
            waterMaterial.SetFloat("_Tiles", 1f);
            waterMaterial.SetColor("_Color", new Color(1, 1, 1, alpha));
            waterMaterial.SetTexture("_DepthTex", depth);
            // World (x, -z) in tiles -> the texel of that terrain vertex
            float sc = (float)Res / side, off = (Margin * Res + 0.5f) / side;
            waterMaterial.SetVector("_DepthST", new Vector4(sc, sc, off, off));
            waterMaterial.SetFloat("_DepthRange", Range);
            waterMaterial.SetFloat("_DeepAt", deepAt);
            waterMaterial.SetFloat("_WaveAmp", swell);
            mr.sharedMaterial = waterMaterial;
            mr.shadowCastingMode = ShadowCastingMode.Off;
        }

        // ---------- Spirit dimension: shallows, waterfalls, mist ----------

        bool IsVoid(int tx, int ty) => TileAt(tx, ty) == Terrain.Water;

        // Shallow water over every land tile: it only shows where the ground dips under it (the shores
        // around the void and the sunken sand roads); the rest of the land stands above it
        void BuildShallows()
        {
            BuildWaterSurface("Shallows", ShallowLevel, (tx, ty) => !IsWet(tx, ty), GameAssets.SpiritWater, 0.78f, 0.45f, 0.02f);
        }

        // The void's walls: a sheer face of pixel-art rock (GameAssets.SpiritCliff) standing on the land's
        // edge, from its lip down into the haze. The edge is the zero line of the signed distance, traced
        // by marching squares at 4 samples per tile, so it runs smooth around bends instead of in tile
        // steps; the terrain's own drop sits just behind it
        static readonly float[] CliffRows = { 0, -1.2f, -3.5f, -7f, -11.5f, -17f, -VoidDepth - 1 };
        static readonly float[] CliffLeans = { 0, 0.12f, 0.22f, 0.3f, 0.36f, 0.4f, 0.42f };
        static readonly byte[] CliffAlpha = { 255, 255, 205, 125, 55, 12, 0 };

        // Points along the void's edge (tile coords) and the way out over the void, one per face piece
        public readonly List<(Vector2 p, Vector2 outward)> CliffSpots = new List<(Vector2, Vector2)>();

        // How far the cliff face stands out from the edge at height y below the lip, and how much it has
        // faded into the haze there (0..1)
        public static float CliffLean(float y) => CliffAt(y, k => CliffLeans[k]);
        public static float CliffHaze(float y) => CliffAt(y, k => 1 - CliffAlpha[k] / 255f);
        static float CliffAt(float y, System.Func<int, float> value)
        {
            for (int k = 1; k < CliffRows.Length; k++)
                if (y >= CliffRows[k]) return Mathf.Lerp(value(k - 1), value(k), Mathf.InverseLerp(CliffRows[k - 1], CliffRows[k], y));
            return value(CliffRows.Length - 1);
        }

        void BuildCliffs()
        {
            const int S = 4;
            int w = (N + 2 * Margin) * S, stride = w + 1;
            var f = new float[stride * stride];
            for (int j = 0; j <= w; j++)
                for (int i = 0; i <= w; i++) f[j * stride + i] = Sd((float)i / S - Margin, (float)j / S - Margin);
            Vector2 At(int i, int j) => new Vector2((float)i / S - Margin, (float)j / S - Margin);
            // Where the edge crosses the grid line between two samples of opposite sign
            Vector2 Cut(int i0, int j0, int i1, int j1)
            {
                float a = f[j0 * stride + i0], b = f[j1 * stride + i1];
                return Vector2.Lerp(At(i0, j0), At(i1, j1), a / (a - b));
            }

            var verts = new List<Vector3>();
            var normals = new List<Vector3>();
            var uvs = new List<Vector2>();
            var cols = new List<Color32>();
            var tris = new List<int>();
            // Rows down the face: the lip, then fixed depths, thinning into the haze (vertex alpha). Below
            // the lip the face leans out a little, like a scree slope: it stays in front of the terrain's
            // own drop where the edge turns a corner
            var rows = CliffRows; var lean = CliffLeans; var alpha = CliffAlpha;
            CliffSpots.Clear();
            float Lip(Vector2 p, Vector2 outward) => Mathf.Max(ShallowLevel + 0.02f, HeightAtTile(p.x - outward.x * 0.75f, p.y - outward.y * 0.75f));
            void Face(Vector2 a, Vector2 b)
            {
                var mid = (a + b) * 0.5f;
                var outward = -SdGradient(mid.x, mid.y);
                if (outward == Vector2.zero) return;
                CliffSpots.Add((mid, outward));
                // Texture columns run along the map axis the face is closest to parallel with
                bool alongV = Mathf.Abs(outward.x) >= Mathf.Abs(outward.y);
                float ua = (alongV ? a.y : a.x) / 4, ub = (alongV ? b.y : b.x) / 4; // 64 px = 4 tiles
                Vector2 outA = -SdGradient(a.x, a.y), outB = -SdGradient(b.x, b.y);
                float topA = Lip(a, outA), topB = Lip(b, outB);
                var n = new Vector3(outward.x, 0, -outward.y);
                int start = verts.Count;
                for (int k = 0; k < rows.Length; k++)
                {
                    float ya = k == 0 ? topA : rows[k], yb = k == 0 ? topB : rows[k];
                    Vector2 pa = a + outA * lean[k], pb = b + outB * lean[k];
                    verts.Add(new Vector3(pa.x, ya, -pa.y));
                    verts.Add(new Vector3(pb.x, yb, -pb.y));
                    normals.Add(n); normals.Add(n);
                    // 256 px = 16 tiles of depth, the lip on the art's top row
                    uvs.Add(new Vector2(ua, 1 - (topA - ya) / 16));
                    uvs.Add(new Vector2(ub, 1 - (topB - yb) / 16));
                    var c = new Color32(255, 255, 255, alpha[k]);
                    cols.Add(c); cols.Add(c);
                }
                for (int k = 0; k < rows.Length - 1; k++)
                {
                    int i0 = start + k * 2;
                    tris.AddRange(new[] { i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2 });
                }
            }

            for (int j = 0; j < w; j++)
                for (int i = 0; i < w; i++)
                {
                    // Corners counter-clockwise from (i, j); edges e0 (c0-c1), e1 (c1-c2), e2 (c2-c3), e3 (c3-c0)
                    bool l0 = f[j * stride + i] >= 0, l1 = f[j * stride + i + 1] >= 0;
                    bool l2 = f[(j + 1) * stride + i + 1] >= 0, l3 = f[(j + 1) * stride + i] >= 0;
                    if (l0 == l1 && l1 == l2 && l2 == l3) continue;
                    var e = new Vector2?[4];
                    if (l0 != l1) e[0] = Cut(i, j, i + 1, j);
                    if (l1 != l2) e[1] = Cut(i + 1, j, i + 1, j + 1);
                    if (l2 != l3) e[2] = Cut(i + 1, j + 1, i, j + 1);
                    if (l3 != l0) e[3] = Cut(i, j + 1, i, j);
                    if (e[0] != null && e[1] != null && e[2] != null && e[3] != null)
                    {
                        // Saddle: the middle decides which corners join up
                        bool centre = (f[j * stride + i] + f[j * stride + i + 1] + f[(j + 1) * stride + i + 1] + f[(j + 1) * stride + i]) >= 0;
                        if (centre == l0) { Face(e[0].Value, e[1].Value); Face(e[2].Value, e[3].Value); }
                        else { Face(e[3].Value, e[0].Value); Face(e[1].Value, e[2].Value); }
                        continue;
                    }
                    Vector2? first = null;
                    for (int k = 0; k < 4; k++)
                    {
                        if (e[k] == null) continue;
                        if (first == null) first = e[k];
                        else Face(first.Value, e[k].Value);
                    }
                }
            if (verts.Count == 0) return;
            var m = new Mesh { indexFormat = IndexFormat.UInt32, name = "Cliffs" };
            m.SetVertices(verts);
            m.SetNormals(normals);
            m.SetUVs(0, uvs);
            m.SetColors(cols);
            m.SetTriangles(tris, 0);
            m.RecalculateBounds();
            var go = new GameObject("Cliffs");
            go.transform.SetParent(transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = go.AddComponent<MeshRenderer>();
            var mat = new Material(Shader.Find("RTS/Terrain")) { name = "Cliffs" };
            mat.SetTexture("_MainTex", GameAssets.SpiritCliff);
            mat.SetFloat("_SlopeDark", 0);
            mat.SetFloat("_Cull", 0);
            mat.SetFloat("_Haze", 1);
            mat.SetColor("_HazeColor", Haze);
            mr.sharedMaterial = mat;
            mr.shadowCastingMode = ShadowCastingMode.On;
            mr.receiveShadows = true;
        }

        // Where the shallows reach the void's edge (the sand roads, the stretches of shore sunk by
        // FallsNear) their water spills over the lip and falls straight down, fading out far below
        void BuildWaterfalls()
        {
            var verts = new List<Vector3>();
            var uvs = new List<Vector2>();
            var cols = new List<Color32>();
            var tris = new List<int>();
            const float Lip = 0.62f;                 // how far out it clears the cliff's top
            float[] rows = { ShallowLevel, -0.9f, -5f, -12f, -VoidDepth + 6 };
            byte[] alpha = { 230, 235, 200, 110, 0 };
            // Only where the ground just inside the edge lies under the shallow water
            bool Spills(Vector3 a, Vector3 b, Vector3 outward)
            {
                var m = (a + b) * 0.5f - outward * 0.75f;
                return HeightAtTile(m.x, -m.z) < ShallowLevel - 0.05f;
            }
            void Edge(Vector3 a, Vector3 b, Vector3 outward)
            {
                if (!Spills(a, b, outward)) return;
                int start = verts.Count;
                for (int k = 0; k < rows.Length; k++)
                {
                    float o = k == 0 ? 0 : Lip + (k - 1) * 0.08f;   // over the lip, then straight down
                    float y = rows[k];
                    verts.Add(a + outward * o + Vector3.up * y);
                    verts.Add(b + outward * o + Vector3.up * y);
                    float vv = k == 0 ? 0 : (ShallowLevel - y) + 0.6f;
                    uvs.Add(new Vector2(0, vv)); uvs.Add(new Vector2(1, vv));
                    var c = new Color32(255, 255, 255, alpha[k]);
                    cols.Add(c); cols.Add(c);
                }
                for (int k = 0; k < rows.Length - 1; k++)
                {
                    int i = start + k * 2;
                    tris.AddRange(new[] { i, i + 1, i + 3, i, i + 3, i + 2 });
                }
            }
            for (int ty = -Margin; ty < N + Margin; ty++)
                for (int tx = -Margin; tx < N + Margin; tx++)
                {
                    if (IsWet(tx, ty)) continue;
                    // Each side of this land tile that faces a void tile
                    if (IsVoid(tx + 1, ty)) Edge(new Vector3(tx + 1, 0, -ty), new Vector3(tx + 1, 0, -(ty + 1)), Vector3.right);
                    if (IsVoid(tx - 1, ty)) Edge(new Vector3(tx, 0, -(ty + 1)), new Vector3(tx, 0, -ty), Vector3.left);
                    if (IsVoid(tx, ty + 1)) Edge(new Vector3(tx + 1, 0, -(ty + 1)), new Vector3(tx, 0, -(ty + 1)), Vector3.back);
                    if (IsVoid(tx, ty - 1)) Edge(new Vector3(tx, 0, -ty), new Vector3(tx + 1, 0, -ty), Vector3.forward);
                }
            if (verts.Count == 0) return;
            var m = new Mesh { indexFormat = IndexFormat.UInt32, name = "Waterfalls" };
            m.SetVertices(verts);
            m.SetUVs(0, uvs);
            m.SetColors(cols);
            m.SetTriangles(tris, 0);
            m.RecalculateBounds();
            var go = new GameObject("Waterfalls");
            go.transform.SetParent(transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = go.AddComponent<MeshRenderer>();
            fallFrames = GameAssets.Waterfall;
            fallMaterial = new Material(Shader.Find("RTS/Unlit")) { name = "Waterfall" };
            fallMaterial.SetTexture("_MainTex", fallFrames[0]);
            fallMaterial.renderQueue = 2990;
            mr.sharedMaterial = fallMaterial;
            mr.shadowCastingMode = ShadowCastingMode.Off;
        }

        // Layers of white mist down in the void, drifting slowly, thicker further down so the void
        // reads as a bright, bottomless white; the land above hides them
        void BuildMist()
        {
            float[] depths = { -3f, -7f, -12f, -18f, -24f, -VoidDepth + 1.5f };
            for (int i = 0; i < depths.Length; i++)
            {
                // The lowest layer is a solid white floor of haze; the others are loose clouds
                bool floor = i == depths.Length - 1;
                var tex = floor ? GameAssets.White : GameAssets.SpiritMist;
                float a = -Margin - 4, b = N + Margin + 4;
                var m = new Mesh { name = "Mist" };
                m.vertices = new[] { new Vector3(a, 0, -a), new Vector3(b, 0, -a), new Vector3(a, 0, -b), new Vector3(b, 0, -b) };
                float k = 0.25f; // texture repeats every 4 tiles
                m.uv = new[] { new Vector2(a * k, a * k), new Vector2(b * k, a * k), new Vector2(a * k, b * k), new Vector2(b * k, b * k) };
                byte al = floor ? (byte)250 : (byte)(110 + i * 26); // denser further down: the bottom is white
                var c = floor ? new Color32(242, 242, 250, al) : new Color32(255, 255, 255, al);
                m.colors32 = new[] { c, c, c, c };
                m.triangles = new[] { 0, 1, 3, 0, 3, 2 };
                m.RecalculateBounds();
                var go = new GameObject("Mist");
                go.transform.SetParent(transform, false);
                go.transform.localPosition = new Vector3(0, depths[i], 0);
                go.AddComponent<MeshFilter>().sharedMesh = m;
                var mr = go.AddComponent<MeshRenderer>();
                var mat = new Material(Shader.Find("RTS/Unlit")) { name = "Mist" };
                mat.SetTexture("_MainTex", tex);
                mat.SetFloat("_FogOfWar", 0); // the void is white even where nobody has looked yet
                mat.renderQueue = 2980 - i;
                mr.sharedMaterial = mat;
                mr.shadowCastingMode = ShadowCastingMode.Off;
                mists.Add(go.transform);
            }
        }

        // ---------- Bridges ----------

        // Wooden bridges: planks across the river (three tones of pixel-art wood, 24 px per tile like the
        // models) on a dark grained frame, with rails on the sides facing open water on posts braced
        // crosswise under the deck. Dressed up: stone abutments where the bridge meets each bank, a
        // lantern on a tall post at each corner of both ends (warm light; cyan in the spirit dimension)
        // and creepers hanging from the deck's edges here and there.
        void BuildBridges()
        {
            var planks = new List<CombineInstance>();
            var dark = new List<CombineInstance>();
            var stone = new List<CombineInstance>();
            var glow = new List<CombineInstance>();
            var vines = new List<CombineInstance>();
            var cube = Resources.GetBuiltinResource<Mesh>("Cube.fbx");
            // The cube with its UVs squeezed into one plank of the three in the plank texture
            var plankMeshes = new Mesh[3];
            for (int v = 0; v < 3; v++)
            {
                var m = Instantiate(cube);
                var uv = m.uv;
                for (int i = 0; i < uv.Length; i++) uv[i] = new Vector2(uv[i].x, (v + uv[i].y) / 3f);
                m.uv = uv;
                plankMeshes[v] = m;
            }
            void Box(List<CombineInstance> list, Vector3 center, Vector3 size, float yaw = 0, Mesh mesh = null, float roll = 0) =>
                list.Add(new CombineInstance { mesh = mesh ?? cube, transform = Matrix4x4.TRS(center, Quaternion.Euler(0, yaw, roll), size) });
            float H(int x, int y, int k) { float f = Mathf.Sin(x * 127.1f + y * 311.7f + k * 74.7f) * 43758.5453f; return f - Mathf.Floor(f); }
            bool IsBridge(int x, int y) => TileAt(x, y) == Terrain.Bridge;
            for (int ty = 0; ty < N; ty++)
                for (int tx = 0; tx < N; tx++)
                {
                    if (!IsBridge(tx, ty)) continue;
                    // A bridge tile with water left/right is walked up/down
                    bool vertical = (IsWet(tx - 1, ty) && !IsBridge(tx - 1, ty)) || (IsWet(tx + 1, ty) && !IsBridge(tx + 1, ty));
                    var c = new Vector3(tx + 0.5f, DeckHeight, -(ty + 0.5f));
                    var walk = vertical ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);   // along the walk (world)
                    var across = vertical ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
                    for (int k = 0; k < 5; k++)
                    {
                        var pos = c + walk * (-0.4f + k * 0.2f) + Vector3.up * (H(tx, ty, k) - 0.5f) * 0.012f;
                        // Planks are always long along their own x, turned across the walk
                        Box(planks, pos, new Vector3(1.02f, 0.08f, 0.17f), (vertical ? 0 : 90) + (H(tx, ty, k + 9) - 0.5f) * 3, plankMeshes[(int)(H(tx, ty, k + 20) * 3)]);
                    }
                    Box(dark, c - new Vector3(0, 0.07f, 0), new Vector3(1, 0.06f, 1));
                    float bottom = HeightAtTile(tx + 0.5f, ty + 0.5f);
                    float depth = Mathf.Min(DeckHeight - bottom, Spirit ? 2.5f : 99);
                    // Stringers under the deck along both edges
                    foreach (float side in new[] { -0.44f, 0.44f })
                        Box(dark, c + across * side - new Vector3(0, 0.13f, 0), vertical ? new Vector3(0.08f, 0.08f, 1) : new Vector3(1, 0.08f, 0.08f));

                    // The ends: where the next tile along the walk is land
                    int sx = vertical ? 0 : 1, sy = vertical ? 1 : 0;
                    foreach (int dir in new[] { -1, 1 })
                    {
                        if (IsBridge(tx + sx * dir, ty + sy * dir) || IsWet(tx + sx * dir, ty + sy * dir)) continue;
                        // World direction of this end: +x for tiles to the right, -z for tiles below
                        var outward = vertical ? new Vector3(0, 0, -dir) : new Vector3(dir, 0, 0);
                        var edge = c + outward * 0.5f;
                        float land = HeightAtTile(tx + 0.5f + sx * dir * 0.9f, ty + 0.5f + sy * dir * 0.9f);
                        float abH = DeckHeight - 0.08f - land + 0.25f;
                        Box(stone, new Vector3(edge.x, land - 0.25f + abH / 2, edge.z) + outward * 0.12f,
                            vertical ? new Vector3(1.3f, abH, 0.42f) : new Vector3(0.42f, abH, 1.3f));
                        foreach (float side in new[] { -0.56f, 0.56f })
                        {
                            var post = edge - outward * 0.06f + across * side;
                            Box(dark, post + new Vector3(0, 0.3f, 0), new Vector3(0.1f, 0.66f, 0.1f));
                            Box(dark, post + new Vector3(0, 0.66f, 0), new Vector3(0.2f, 0.04f, 0.2f));      // lantern roof
                            Box(glow, post + new Vector3(0, 0.57f, 0), new Vector3(0.13f, 0.14f, 0.13f));   // lantern
                            Box(dark, post + new Vector3(0, 0.495f, 0), new Vector3(0.17f, 0.025f, 0.17f)); // lantern base
                        }
                    }

                    var sides = vertical
                        ? new[] { (-1, 0, new Vector3(-0.47f, 0, 0)), (1, 0, new Vector3(0.47f, 0, 0)) }
                        : new[] { (0, -1, new Vector3(0, 0, 0.47f)), (0, 1, new Vector3(0, 0, -0.47f)) };
                    foreach (var (dx, dy, off) in sides)
                    {
                        if (!IsWet(tx + dx, ty + dy) || IsBridge(tx + dx, ty + dy)) continue;
                        var railSize = vertical ? new Vector3(0.07f, 0.07f, 1.0f) : new Vector3(1.0f, 0.07f, 0.07f);
                        Box(dark, c + off + new Vector3(0, 0.28f, 0), railSize);
                        Box(dark, c + off + new Vector3(0, 0.15f, 0), railSize * 0.8f); // a lower rail
                        foreach (float s2 in new[] { -0.42f, 0.42f })
                        {
                            var along = walk * s2;
                            Box(dark, c + off + along + new Vector3(0, 0.12f, 0), new Vector3(0.07f, 0.34f, 0.07f));
                            if (depth > 0.05f) Box(dark, c + off + along + new Vector3(0, -depth / 2, 0), new Vector3(0.09f, depth, 0.09f));
                        }
                        // A cross brace between this side's two posts, under the deck
                        if (depth > 0.35f)
                        {
                            float span = 0.84f, drop = Mathf.Min(depth, 0.9f) - 0.15f;
                            float len = Mathf.Sqrt(span * span + drop * drop), ang = Mathf.Atan2(drop, span) * Mathf.Rad2Deg;
                            var mid = c + off * 1.02f + new Vector3(0, -0.12f - drop / 2, 0);
                            foreach (float sgn in new[] { -1f, 1f })
                                Box(dark, mid, new Vector3(len, 0.05f, 0.05f), vertical ? 90 : 0, null, sgn * ang);
                        }
                        // Creepers hanging from the deck's edge
                        for (int k = 0; k < 3; k++)
                        {
                            if (H(tx * 3 + dx, ty * 5 + dy, k) > 0.4f) continue;
                            float len = 0.15f + H(tx, ty + dx, k + 4) * 0.45f;
                            var at = c + off * 1.06f + walk * (-0.35f + k * 0.35f + (H(tx, ty, k + 7) - 0.5f) * 0.15f);
                            Box(vines, at + new Vector3(0, -0.1f - len / 2, 0), new Vector3(0.05f, len, 0.05f));
                            Box(vines, at + new Vector3(0, -0.08f, 0), vertical ? new Vector3(0.06f, 0.06f, 0.16f) : new Vector3(0.16f, 0.06f, 0.06f));
                        }
                    }
                }
            MakeCombined("Bridge planks", planks, Materials.Model(PlankTexture(), null, false));
            MakeCombined("Bridge frame", dark, Materials.Model(FrameTexture(), null, false));
            MakeCombined("Bridge abutments", stone, Materials.Model(StoneTexture(), null, false));
            MakeCombined("Bridge creepers", vines, Materials.Model(Solid(Spirit ? new Color32(0x9a, 0x84, 0xb4, 255) : new Color32(0x6f, 0x8f, 0x55, 255)), null, false));
            var lamp = new Material(Materials.Model(Solid(Spirit ? new Color32(0x9f, 0xf3, 0xff, 255) : new Color32(0xff, 0xd2, 0x7a, 255)), null, false)) { name = "Bridge lantern" };
            lamp.SetFloat("_Emission", 1.6f);
            MakeCombined("Bridge lanterns", glow, lamp);
        }

        // Three planks stacked (one per row of 8 px), 24 x 8 px each: 24 px per tile like the models.
        // Wood in three close tones (soft contrast) with grain running along the plank, a knot or two, a lit top edge, a
        // shaded bottom edge and a nail near each end
        static Texture2D PlankTexture()
        {
            const int W = 24, P = 8;
            Color32 C(int hex) => new Color32((byte)(hex >> 16), (byte)(hex >> 8), (byte)hex, 255);
            int[][] tones =
            {
                new[] { 0x8f735a, 0x9a7d63, 0xa38569, 0xad9073 },
                new[] { 0x8a6e56, 0x947860, 0x9d8066, 0xa68a70 },
                new[] { 0x967c63, 0xa0866c, 0xa98e73, 0xb3997e },
            };
            var nail = C(0xa3a39c); var nailDark = C(0x8c877c);
            float Hh(int x, int y) { float f = Mathf.Sin(x * 12.9898f + y * 78.233f) * 43758.5453f; return f - Mathf.Floor(f); }
            var px = new Color32[W * P * 3];
            for (int v = 0; v < 3; v++)
            {
                var t = tones[v];
                int knot = 5 + (int)(Hh(v, 1) * 14);
                for (int y = 0; y < P; y++)
                    for (int x = 0; x < W; x++)
                    {
                        int k = 2;
                        // Grain: long streaks along the plank, broken here and there
                        if ((y == 2 || y == 5) && Hh(x >> 2, y + v * 9) > 0.35f) k = 1;
                        else if (y == 4 && Hh(x >> 3, v) > 0.6f) k = 3;
                        if (Mathf.Abs(x - knot) <= 1 && (y == 3 || y == 4)) k = (x == knot) ? 0 : 1;
                        if (y == P - 1) k = 3;  // lit top edge
                        if (y == 0) k = 0;      // shaded bottom edge
                        if (x == 0 || x == W - 1) k = Mathf.Min(k, 1); // sawn ends
                        var c = C(t[k]);
                        if ((x == 2 || x == W - 3) && (y == 3 || y == 4)) c = y == 4 ? nail : nailDark;
                        px[(v * P + y) * W + x] = c;
                    }
            }
            var tex = new Texture2D(W, P * 3, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "Plank" };
            tex.SetPixels32(px);
            tex.Apply();
            return tex;
        }

        // Dark wood for the posts, rails, braces and the deck underneath: grain running along each piece
        static Texture2D FrameTexture()
        {
            const int S = 16;
            var px = new Color32[S * S];
            Color32[] ramp = { new Color32(0x63, 0x50, 0x41, 255), new Color32(0x69, 0x55, 0x45, 255), new Color32(0x6e, 0x59, 0x48, 255), new Color32(0x74, 0x5e, 0x4c, 255) };
            for (int y = 0; y < S; y++)
                for (int x = 0; x < S; x++)
                {
                    float n = Mathf.Sin(x * 91.7f + (y >> 2) * 17.3f) * 43758.5453f; n -= Mathf.Floor(n);
                    int k = x % 5 == 0 ? 0 : n > 0.75f ? 3 : n < 0.3f ? 1 : 2;
                    px[y * S + x] = ramp[k];
                }
            var tex = new Texture2D(S, S, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "BridgeFrame" };
            tex.SetPixels32(px);
            tex.Apply();
            return tex;
        }

        // Abutment masonry: soft grey stones of uneven widths in courses, thin mortar
        static Texture2D StoneTexture()
        {
            const int S = 24;
            var px = new Color32[S * S];
            Color32[] ramp = { new Color32(0x8a, 0x86, 0x7e, 255), new Color32(0x91, 0x8c, 0x84, 255), new Color32(0x98, 0x93, 0x8a, 255), new Color32(0x9f, 0x9a, 0x91, 255) };
            var mortar = new Color32(0x80, 0x7b, 0x73, 255);
            for (int y = 0; y < S; y++)
                for (int x = 0; x < S; x++)
                {
                    int row = y / 6, ry = y % 6;
                    int off = row % 2 == 0 ? 0 : 5, bx = (x + off) % 10;
                    float n = Mathf.Sin(((x + off) / 10) * 37.1f + row * 11.7f) * 43758.5453f; n -= Mathf.Floor(n);
                    int k = n > 0.6f ? 2 : 1;
                    if (ry == 5) k = 3; else if (ry == 1) k = Mathf.Max(0, k - 1);
                    px[y * S + x] = ry == 0 || bx == 0 ? mortar : ramp[k];
                }
            var tex = new Texture2D(S, S, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat, name = "BridgeStone" };
            tex.SetPixels32(px);
            tex.Apply();
            return tex;
        }

        static Texture2D Solid(Color32 c)
        {
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "Solid" };
            tex.SetPixels32(new[] { c, c, c, c });
            tex.Apply();
            return tex;
        }

        void MakeCombined(string name, List<CombineInstance> parts, Material material)
        {
            if (parts.Count == 0) return;
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            var m = new Mesh { indexFormat = IndexFormat.UInt32 };
            m.CombineMeshes(parts.ToArray(), true, true);
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = material;
        }
    }
}
