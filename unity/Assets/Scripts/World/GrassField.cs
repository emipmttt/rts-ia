using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// Grass tufts scattered over the meadows: each tuft is the 16 px tuft art on two quads crossed at
// right angles (like the bushes), thousands of them merged into one mesh per 16x16-tile chunk so
// the GPU draws a few meshes and skips the chunks off screen. The Grass shader sways them in the
// wind and bends them around the units listed with SetPushers.
// No grass on sand, near water, on steep rock, under resources or under buildings (cleared as
// they are placed). It also grows on the gentler slopes of the mountains around the map.
namespace RTS.World
{
    public class GrassField : MonoBehaviour
    {
        const int ChunkTiles = 16;
        const int TuftsPerTile = 3;        // tries per tile
        const float Chance = 0.45f;        // of each try growing a tuft
        const float Size = 0.6f;           // world units, tip height and width
        public const int MaxPushers = 32;  // Grass.shader MAX_PUSHERS

        struct Tuft { public float u, v, yaw, phase, scale; public int tx, ty; }
        class Chunk { public List<Tuft> tufts = new List<Tuft>(); public Mesh mesh; public bool dirty; }

        Ground ground;
        int n, chunksPerSide, margin;
        Chunk[] chunks;
        readonly HashSet<long> cleared = new HashSet<long>();
        Vector4[] pushers;
        Material material;

        static long Key(int x, int y) => ((long)x << 32) | (uint)y;

        public static GrassField Build(Transform parent, Ground ground, System.Func<int, int, bool> occupied)
        {
            var go = new GameObject("Grass");
            go.transform.SetParent(parent, false);
            var g = go.AddComponent<GrassField>();
            g.Init(ground, occupied);
            return g;
        }

        static float Hash(int a, int b, int c)
        {
            uint h = (uint)(a * 73856093) ^ (uint)(b * 19349663) ^ (uint)(c * 83492791);
            h ^= h >> 13; h *= 0x5bd1e995; h ^= h >> 15;
            return (h & 0xffffff) / (float)0x1000000;
        }

        void Init(Ground ground, System.Func<int, int, bool> occupied)
        {
            this.ground = ground;
            n = ground.N;
            margin = Ground.Margin;
            material = new Material(Shader.Find("RTS/Grass")) { name = "Grass" };
            material.SetTexture("_MainTex", GameAssets.GrassTuft);
            chunksPerSide = (n + 2 * margin + ChunkTiles - 1) / ChunkTiles;
            chunks = new Chunk[chunksPerSide * chunksPerSide];
            for (int i = 0; i < chunks.Length; i++) chunks[i] = new Chunk();

            for (int ty = -margin; ty < n + margin; ty++)
                for (int tx = -margin; tx < n + margin; tx++)
                {
                    bool inMap = tx >= 0 && ty >= 0 && tx < n && ty < n;
                    if (!Meadow(tx, ty) || inMap && occupied(tx, ty)) continue;
                    var chunk = chunks[ChunkOf(tx, ty)];
                    for (int k = 0; k < TuftsPerTile; k++)
                    {
                        if (Hash(tx, ty, k * 5) > Chance) continue;
                        float u = tx + 0.1f + Hash(tx, ty, k * 5 + 1) * 0.8f, v = ty + 0.1f + Hash(tx, ty, k * 5 + 2) * 0.8f;
                        // Rock shows on slopes steeper than this: keep the grass off it
                        if (ground.Normal(u * C.TileSize, v * C.TileSize).y < 0.85f) continue;
                        chunk.tufts.Add(new Tuft
                        {
                            u = u, v = v, tx = tx, ty = ty,
                            yaw = Hash(tx, ty, k * 5 + 3) * 180, phase = Hash(tx, ty, k * 5 + 4),
                            scale = 0.75f + Hash(ty, tx, k) * 0.5f,
                        });
                    }
                }
            for (int i = 0; i < chunks.Length; i++)
            {
                var c = chunks[i];
                if (c.tufts.Count == 0) continue;
                c.mesh = new Mesh { name = "Grass " + i };
                c.mesh.MarkDynamic();
                var go = new GameObject(c.mesh.name);
                go.transform.SetParent(transform, false);
                go.AddComponent<MeshFilter>().sharedMesh = c.mesh;
                var mr = go.AddComponent<MeshRenderer>();
                mr.sharedMaterial = material;
                mr.shadowCastingMode = ShadowCastingMode.Off;
                mr.receiveShadows = true;
                BuildMesh(c);
            }
            SetPushers(new List<Vector4>());
        }

        int ChunkOf(int tx, int ty) => ((ty + margin) / ChunkTiles) * chunksPerSide + (tx + margin) / ChunkTiles;

        // Grass tiles away from sand and water
        bool Meadow(int tx, int ty)
        {
            for (int dy = -2; dy <= 2; dy++)
                for (int dx = -2; dx <= 2; dx++)
                {
                    int t = ground.TileAt(tx + dx, ty + dy);
                    if (t == Terrain.Water || t == Terrain.Bridge) return false;
                    if (t == Terrain.Sand && dx * dx + dy * dy <= 2) return false;
                }
            return true;
        }

        void BuildMesh(Chunk c)
        {
            var verts = new List<Vector3>(c.tufts.Count * 8);
            var uv = new List<Vector2>(c.tufts.Count * 8);
            var roots = new List<Vector4>(c.tufts.Count * 8);
            var normals = new List<Vector3>(c.tufts.Count * 8);
            var tris = new List<int>(c.tufts.Count * 12);
            foreach (var t in c.tufts)
            {
                if (cleared.Contains(Key(t.tx, t.ty))) continue;
                var root = new Vector3(t.u, ground.HeightAtTile(t.u, t.v) - 0.02f, -t.v);
                float s = Size * t.scale;
                for (int q = 0; q < 2; q++)
                {
                    float a = (t.yaw + q * 90) * Mathf.Deg2Rad;
                    var side = new Vector3(Mathf.Cos(a), 0, Mathf.Sin(a)) * (s / 2);
                    int i = verts.Count;
                    verts.Add(root - side); verts.Add(root + side);
                    verts.Add(root + side + Vector3.up * s); verts.Add(root - side + Vector3.up * s);
                    uv.Add(new Vector2(0, 0)); uv.Add(new Vector2(1, 0)); uv.Add(new Vector2(1, 1)); uv.Add(new Vector2(0, 1));
                    var r = new Vector4(root.x, root.z, t.phase, 0);
                    for (int k = 0; k < 4; k++) { roots.Add(r); normals.Add(Vector3.up); }
                    tris.Add(i); tris.Add(i + 1); tris.Add(i + 2);
                    tris.Add(i); tris.Add(i + 2); tris.Add(i + 3);
                }
            }
            c.mesh.Clear();
            c.mesh.indexFormat = verts.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            c.mesh.SetVertices(verts);
            c.mesh.SetNormals(normals);
            c.mesh.SetUVs(0, uv);
            c.mesh.SetUVs(1, roots);
            c.mesh.SetTriangles(tris, 0);
            c.mesh.RecalculateBounds();
            // Room for the tips bending in the wind and around units
            var b = c.mesh.bounds;
            b.Expand(0.6f);
            c.mesh.bounds = b;
        }

        // A building now stands on these tiles: no grass under it, and the tufts around its levelled
        // terrace follow the new ground
        public void Clear(int tx, int ty, int size)
        {
            for (int y = ty; y < ty + size; y++)
                for (int x = tx; x < tx + size; x++) cleared.Add(Key(x, y));
            for (int cy = Mathf.Max(0, (ty - 3 + margin) / ChunkTiles); cy <= Mathf.Min(chunksPerSide - 1, (ty + size + 3 + margin) / ChunkTiles); cy++)
                for (int cx = Mathf.Max(0, (tx - 3 + margin) / ChunkTiles); cx <= Mathf.Min(chunksPerSide - 1, (tx + size + 3 + margin) / ChunkTiles); cx++)
                    chunks[cy * chunksPerSide + cx].dirty = true;
        }

        void LateUpdate()
        {
            foreach (var c in chunks)
            {
                if (!c.dirty) continue;
                c.dirty = false;
                if (c.mesh != null) BuildMesh(c);
            }
        }

        // Units brushing through the grass: world (x, z), radius, strength 0..1
        public void SetPushers(List<Vector4> list)
        {
            pushers ??= new Vector4[MaxPushers];
            int count = list == null ? 0 : Mathf.Min(list.Count, MaxPushers);
            for (int i = 0; i < MaxPushers; i++) pushers[i] = i < count ? list[i] : Vector4.zero;
            Shader.SetGlobalVectorArray("_GrassPushers", pushers);
            Shader.SetGlobalFloat("_GrassPusherCount", count);
        }
    }
}
