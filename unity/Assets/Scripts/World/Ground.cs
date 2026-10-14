using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// 3D terrain built from the server's tile map (grass / sand / water / bridge). Heights are purely
// visual: Perlin fBm hills that flatten into low banks along the rivers, riverbeds carved under the
// water plane, and mountains framing the map. The ground texture is the original pixel-art grass
// with sand, riverbed and rock on steep slopes blended in by soft blob masks (like the 2D client's
// drawGround).
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
        bool dirty;
        RectInt dirtyRect;         // vertex range changed since the last upload

        class Chunk { public int i0, j0, i1, j1; public Mesh mesh; public Vector3[] vertices, normals; }
        readonly HashSet<int> flattened = new HashSet<int>();
        Material waterMaterial;
        Texture2D[] waterFrames;

        public static Ground Build(Transform parent, int[] tiles)
        {
            var go = new GameObject("Ground");
            go.transform.SetParent(parent, false);
            var g = go.AddComponent<Ground>();
            g.Init(tiles);
            return g;
        }

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
            BuildWater();
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
            var sd = SignedDistance();
            // Bilinear sample of the tile-centre distance field at tile coords (u, v)
            float Sd(float u, float v)
            {
                float fx = u + Margin - 0.5f, fy = v + Margin - 0.5f;
                int x0 = Mathf.Clamp(Mathf.FloorToInt(fx), 0, w - 1), y0 = Mathf.Clamp(Mathf.FloorToInt(fy), 0, w - 1);
                int x1 = Mathf.Min(x0 + 1, w - 1), y1 = Mathf.Min(y0 + 1, w - 1);
                float tx = Mathf.Clamp01(fx - x0), ty = Mathf.Clamp01(fy - y0);
                // Tile centres hold +-distance; shift by 0.5 so the bank sits on the tile edge
                float S(int x, int y) { float d = sd[y * w + x]; return d > 0 ? d - 0.5f : d + 0.5f; }
                return Mathf.Lerp(Mathf.Lerp(S(x0, y0), S(x1, y0), tx), Mathf.Lerp(S(x0, y1), S(x1, y1), tx), ty);
            }

            for (int j = 0; j < side; j++)
                for (int i = 0; i < side; i++)
                {
                    float u = (float)i / Res - Margin, v = (float)j / Res - Margin;
                    float d = Sd(u, v);
                    float h;
                    if (d < 0)
                    {
                        h = WaterLevel - 0.12f + d * 0.55f; // riverbed deepens toward the middle
                        h = Mathf.Max(h, WaterLevel - 1.1f);
                    }
                    else
                    {
                        // Rolling hills where the low-frequency noise is high, gentle bumps elsewhere
                        float n = Fbm(u * 0.05f, v * 0.05f);
                        float hills = Mathf.Pow(Mathf.Max(0, n - 0.4f), 1.3f) * HillHeight
                                      + (Fbm(u * 0.2f + 40, v * 0.2f + 40) - 0.5f) * 0.6f;
                        float bank = WaterLevel + 0.1f + Mathf.Min(d, 1.5f) * 0.18f;
                        h = Mathf.Lerp(bank, bank + Mathf.Max(0, hills), Mathf.SmoothStep(0, 1, Mathf.Clamp01((d - 0.3f) / 3.5f)));
                    }
                    // Mountains outside the playable map
                    float outside = Mathf.Max(Mathf.Max(-u, u - N), Mathf.Max(-v, v - N));
                    if (outside > 0)
                    {
                        float k = Mathf.Clamp01(outside / Margin);
                        h = Mathf.Max(h, 0.2f) + Mathf.Pow(k, 1.4f) * (5 + Fbm(u * 0.12f, v * 0.12f) * 9);
                    }
                    heights[j * side + i] = h;
                }
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
            for (int j = j0; j <= j1; j++) for (int i = i0; i <= i1; i++) { sum += heights[j * side + i]; count++; }
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
                    vertices[j * side + i] = new Vector3(u, heights[j * side + i], -v);
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
                    float lift = Mathf.Clamp01(h / HillHeight);
                    var c = Color.Lerp(new Color(0.95f, 0.97f, 0.97f), new Color(1.04f, 1.06f, 1.05f), lift);
                    if (outside > 0) c = Color.Lerp(c, new Color(0.78f, 0.82f, 0.84f), Mathf.Clamp01(outside / 6f));
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
        float[] sandMask, bedMask, rockRaw, rockMask;
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
                            if ((tile == Terrain.Water || tile == Terrain.Bridge) && dist < 0.95f) b = 1;
                        }
                    sandMask[j * mw + i] = s;
                    bedMask[j * mw + i] = b;
                }
            BoxBlur(sandMask, mw, 2);
            BoxBlur(bedMask, mw, 2);
            rockRaw = new float[mw * mw];
            rockMask = new float[mw * mw];
            UpdateRock(0, 0, mw - 1, mw - 1);

            int size = w * TexPx;
            grassPx = GameAssets.Grass.GetPixels32();
            sandPx = GameAssets.Sand.GetPixels32();
            rockPx = GameAssets.Cliff.GetPixels32();
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
                    rockRaw[j * mw + i] = 1 - ny > RockSlope ? 1 : 0;
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
            var go = new GameObject("Water");
            go.transform.SetParent(transform, false);
            var m = new Mesh { name = "Water" };
            float a = -Margin, b = N + Margin;
            m.vertices = new[] { new Vector3(a, WaterLevel, -a), new Vector3(b, WaterLevel, -a), new Vector3(a, WaterLevel, -b), new Vector3(b, WaterLevel, -b) };
            m.triangles = new[] { 0, 1, 3, 0, 3, 2 };
            m.normals = new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up };
            m.RecalculateBounds();
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var mr = go.AddComponent<MeshRenderer>();
            waterMaterial = new Material(Shader.Find("RTS/Water"));
            waterFrames = GameAssets.Water;
            waterMaterial.SetTexture("_MainTex", waterFrames[0]);
            waterMaterial.SetFloat("_Tiles", 1f);
            waterMaterial.SetColor("_Color", new Color(1, 1, 1, 0.84f));
            mr.sharedMaterial = waterMaterial;
            mr.shadowCastingMode = ShadowCastingMode.Off;
        }

        // ---------- Bridges ----------

        // Wooden planks across the river with rails on the sides facing open water, on posts; pixel-art
        // planks (grain along their length, nails at the ends) on a dark wooden frame
        void BuildBridges()
        {
            var planks = new List<CombineInstance>();
            var dark = new List<CombineInstance>();
            var cube = Resources.GetBuiltinResource<Mesh>("Cube.fbx");
            void Box(List<CombineInstance> list, Vector3 center, Vector3 size, float yaw = 0) =>
                list.Add(new CombineInstance { mesh = cube, transform = Matrix4x4.TRS(center, Quaternion.Euler(0, yaw, 0), size) });
            bool IsBridge(int x, int y) => TileAt(x, y) == Terrain.Bridge;
            for (int ty = 0; ty < N; ty++)
                for (int tx = 0; tx < N; tx++)
                {
                    if (!IsBridge(tx, ty)) continue;
                    // A bridge tile with water left/right is walked up/down
                    bool vertical = (IsWet(tx - 1, ty) && !IsBridge(tx - 1, ty)) || (IsWet(tx + 1, ty) && !IsBridge(tx + 1, ty));
                    var c = new Vector3(tx + 0.5f, DeckHeight, -(ty + 0.5f));
                    for (int k = 0; k < 5; k++)
                    {
                        float o = -0.4f + k * 0.2f;
                        var pos = c + (vertical ? new Vector3(0, 0, o) : new Vector3(o, 0, 0));
                        // Planks are always long along their own x, turned across the walk
                        Box(planks, pos, new Vector3(1.02f, 0.08f, 0.17f), vertical ? 0 : 90);
                    }
                    Box(dark, c - new Vector3(0, 0.07f, 0), new Vector3(1, 0.06f, 1));
                    var sides = vertical
                        ? new[] { (-1, 0, new Vector3(-0.47f, 0, 0)), (1, 0, new Vector3(0.47f, 0, 0)) }
                        : new[] { (0, -1, new Vector3(0, 0, 0.47f)), (0, 1, new Vector3(0, 0, -0.47f)) };
                    foreach (var (dx, dy, off) in sides)
                    {
                        if (!IsWet(tx + dx, ty + dy) || IsBridge(tx + dx, ty + dy)) continue;
                        var railSize = vertical ? new Vector3(0.07f, 0.07f, 1.0f) : new Vector3(1.0f, 0.07f, 0.07f);
                        Box(dark, c + off + new Vector3(0, 0.28f, 0), railSize);
                        foreach (float s in new[] { -0.42f, 0.42f })
                        {
                            var along = vertical ? new Vector3(0, 0, s) : new Vector3(s, 0, 0);
                            Box(dark, c + off + along + new Vector3(0, 0.12f, 0), new Vector3(0.07f, 0.34f, 0.07f));
                            float bottom = HeightAtTile(tx + 0.5f, ty + 0.5f);
                            float postH = DeckHeight - bottom;
                            if (postH > 0.05f) Box(dark, c + off + along + new Vector3(0, -postH / 2, 0), new Vector3(0.09f, postH, 0.09f));
                        }
                    }
                }
            MakeCombined("Bridge planks", planks, Materials.Model(PlankTexture(), null, false));
            MakeCombined("Bridge frame", dark, Materials.Model(FrameTexture(), null, false));
        }

        // One plank, 16 x 4 px: flat wood, a darker edge along each side and a nail at each end
        static Texture2D PlankTexture()
        {
            const int W = 16, H = 4;
            var wood = new Color32(0xa6, 0x88, 0x68, 255);
            var edge = new Color32(0x7c, 0x63, 0x4c, 255);
            var nail = new Color32(0x8e, 0x95, 0x9a, 255);
            var px = new Color32[W * H];
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++) px[y * W + x] = y == 0 || y == H - 1 ? edge : wood;
            px[2 * W + 1] = nail; px[2 * W + W - 2] = nail;
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "Plank" };
            tex.SetPixels32(px);
            tex.Apply();
            return tex;
        }

        // Flat dark wood for the posts, rails and the deck underneath
        static Texture2D FrameTexture()
        {
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "BridgeFrame" };
            var c = new Color32(0x66, 0x51, 0x41, 255);
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
