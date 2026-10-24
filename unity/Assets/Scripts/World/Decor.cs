using System;
using System.Collections.Generic;
using UnityEngine;

// Small low-poly decorations (unity/Tools/build-decor.mjs) scattered over open grass, purely cosmetic:
// rocks, stumps, logs, mushrooms and flowers in the classic valley; crystal shards, glowing mushrooms,
// stone lanterns, cairns, pale dead stumps and lilac flowers in the spirit dimension. They gather in
// loose clusters (a noise mask), keep clear of water, sand, crystal, resources and steep slopes, and
// vanish under buildings placed on them. Picked per tile by a hash, so every client shows the same.
namespace RTS.World
{
    public class Decor
    {
        static readonly (string model, int weight)[] Classic =
            { ("decor_rocks", 3), ("decor_stump", 2), ("decor_log", 1), ("decor_mushrooms", 2), ("decor_flowers", 4) };
        static readonly (string model, int weight)[] SpiritSet =
            { ("spirit_shards", 2), ("spirit_mushrooms", 3), ("spirit_lantern", 1), ("spirit_cairn", 2), ("spirit_stump", 2), ("spirit_flowers", 3) };
        const float SpiritGlow = 0.22f; // the spirit props shine a little, like the crystals

        class Item { public Transform t; public float u, v; }

        readonly Ground ground;
        readonly Dictionary<long, Item> byTile = new Dictionary<long, Item>();
        static readonly Dictionary<Texture2D, Material> glowing = new Dictionary<Texture2D, Material>();

        static long Key(int tx, int ty) => ((long)tx << 32) | (uint)ty;

        Decor(Ground ground) { this.ground = ground; }

        // `taken(tx, ty)`: a resource stands on the tile
        public static Decor Build(Transform parent, Ground ground, Func<int, int, bool> taken)
        {
            var d = new Decor(ground);
            var root = new GameObject("Decor").transform;
            root.SetParent(parent, false);
            var set = ground.Spirit ? SpiritSet : Classic;
            int total = 0;
            foreach (var (_, w) in set) total += w;
            int n = ground.N;
            for (int ty = 1; ty < n - 1; ty++)
                for (int tx = 1; tx < n - 1; tx++)
                {
                    // Clusters: a low base chance, much higher where the noise peaks
                    float noise = Mathf.PerlinNoise(tx * 0.11f + 71.3f, ty * 0.11f + 19.7f);
                    float chance = 0.012f + Mathf.Max(0, noise - 0.46f) * 0.3f;
                    if (Hash(tx, ty, 1) > chance || !Open(ground, tx, ty, taken)) continue;
                    float u = tx + 0.2f + Hash(tx, ty, 2) * 0.6f, v = ty + 0.2f + Hash(tx, ty, 3) * 0.6f;
                    if (ground.Normal(u * C.TileSize, v * C.TileSize).y < 0.82f) continue;
                    int pick = (int)(Hash(tx, ty, 4) * total);
                    string name = set[0].model;
                    foreach (var (model, w) in set) { if (pick < w) { name = model; break; } pick -= w; }
                    var m = GlbLoader.Load("models/" + name);
                    if (m == null) continue;
                    var holder = new GameObject(name).transform;
                    holder.SetParent(root, false);
                    holder.localPosition = new Vector3(u, ground.HeightAtTile(u, v) - 0.01f, -v);
                    holder.localRotation = Quaternion.Euler(0, Hash(tx, ty, 5) * 360, 0);
                    float width = Mathf.Max(m.bounds.size.x, m.bounds.size.z) * (1.8f + Hash(tx, ty, 6) * 0.6f); // drawn about twice the model's size: near a tile wide
                    bool spirit = ground.Spirit;
                    GlbLoader.Instantiate(m, holder, width, (tex, normal, ds) => spirit ? Glowing(tex, ds) : Materials.Model(tex, normal, ds));
                    d.byTile[Key(tx, ty)] = new Item { t = holder, u = u, v = v };
                }
            return d;
        }

        // Plain grass away from water, sand (the spirit shallows), crystal and resources
        static bool Open(Ground ground, int tx, int ty, Func<int, int, bool> taken)
        {
            if (ground.TileAt(tx, ty) != Terrain.Grass || taken(tx, ty)) return false;
            for (int dy = -2; dy <= 2; dy++)
                for (int dx = -2; dx <= 2; dx++)
                {
                    int t = ground.TileAt(tx + dx, ty + dy);
                    if (t == Terrain.Water || t == Terrain.Bridge || t == Terrain.Crystal) return false;
                    if (Mathf.Abs(dx) <= 1 && Mathf.Abs(dy) <= 1 && (t == Terrain.Sand || taken(tx + dx, ty + dy))) return false;
                }
            return true;
        }

        // A building now stands on these tiles: the decorations under it go, the ones around its levelled
        // terrace settle onto the new ground
        public void Clear(int tx, int ty, int size)
        {
            for (int y = ty - 3; y < ty + size + 3; y++)
                for (int x = tx - 3; x < tx + size + 3; x++)
                {
                    if (!byTile.TryGetValue(Key(x, y), out var it)) continue;
                    if (x >= tx && y >= ty && x < tx + size && y < ty + size) { it.t.gameObject.SetActive(false); continue; }
                    var p = it.t.localPosition;
                    it.t.localPosition = new Vector3(p.x, ground.HeightAtTile(it.u, it.v) - 0.01f, p.z);
                }
        }

        static Material Glowing(Texture2D tex, bool doubleSided)
        {
            if (glowing.TryGetValue(tex, out var m) && m != null) return m;
            m = new Material(Materials.Model(tex, null, doubleSided)) { name = "Spirit decor" };
            m.SetFloat("_Emission", SpiritGlow);
            glowing[tex] = m;
            return m;
        }

        static float Hash(int x, int y, int k)
        {
            float f = Mathf.Sin(x * 127.1f + y * 311.7f + k * 74.7f) * 43758.5453f;
            return f - Mathf.Floor(f);
        }
    }
}
