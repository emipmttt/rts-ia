using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Port of client/src/assets.js: loads every texture from Resources/assets and cuts it into sprites.
// Sprites use 40 pixels per unit, so a Pixi sprite of scale s becomes a Unity sprite of localScale s
// (1 Unity unit = 1 tile = 40 game px).
namespace RTS
{
    public static class GameAssets
    {
        public const float PPU = C.TileSize;
        const string Base = "assets/";

        static readonly Dictionary<string, Texture2D> textures = new Dictionary<string, Texture2D>();
        static readonly Dictionary<string, Sprite[]> strips = new Dictionary<string, Sprite[]>();
        static readonly Dictionary<string, Sprite> singles = new Dictionary<string, Sprite>();
        static JObject rigIndex;

        // Building sprites painted by unity/Tools/gen-art.py (placement preview, fallback while a model loads)
        public static readonly string[] Buildings = { "castle", "barracks", "monastery", "tower", "house1", "house2", "house3" };

        // Foliage variants (TREE_TINTS); the last AutumnTints are autumn orange
        static readonly (float h, float s, float l)[] TreeTints =
        {
            (0, 1, 1), (-12, 1.05f, 1.08f), (14, 0.9f, 0.92f), (6, 1.15f, 1.02f), (-118, 1.5f, 1.25f), (-128, 1.6f, 1.15f),
        };
        public const int AutumnTints = 2;
        public static int TreeTintCount => TreeTints.Length;

        public static Texture2D Tex(string path)
        {
            if (textures.TryGetValue(path, out var t)) return t;
            t = Resources.Load<Texture2D>(path);
            if (t == null) Debug.LogWarning($"Missing texture {path}");
            else t.filterMode = FilterMode.Point;
            textures[path] = t;
            return t;
        }

        public static Texture2D Asset(string name) => Tex(Base + name);

        static Sprite Make(Texture2D tex, Rect rect, Vector2 pivot) =>
            Sprite.Create(tex, rect, pivot, PPU, 0, SpriteMeshType.FullRect);

        // Horizontal strip of square-ish frames of frameWidth x full height
        public static Sprite[] Strip(string name, int frameWidth, Vector2 pivot)
        {
            var key = $"{name}|{frameWidth}|{pivot}";
            if (strips.TryGetValue(key, out var s)) return s;
            var tex = Asset(name);
            int count = tex.width / frameWidth;
            s = new Sprite[count];
            for (int i = 0; i < count; i++) s[i] = Make(tex, new Rect(i * frameWidth, 0, frameWidth, tex.height), pivot);
            strips[key] = s;
            return s;
        }

        public static Sprite Single(string name, Vector2 pivot)
        {
            var key = $"{name}|{pivot}";
            if (singles.TryGetValue(key, out var s)) return s;
            var tex = Asset(name);
            s = Make(tex, new Rect(0, 0, tex.width, tex.height), pivot);
            singles[key] = s;
            return s;
        }

        public static Sprite FromTexture(Texture2D tex, Vector2 pivot) => Make(tex, new Rect(0, 0, tex.width, tex.height), pivot);

        // ---- Units ----

        // Procedural rig frames baked by Tools/bake-rigs.mjs: `${rig}_${style}_${view}_${anim}`
        public static readonly Vector2 RigPivot = new Vector2(0.5f, 4f / 28f); // at the feet
        public static Sprite[] RigFrames(string faction, string rig, string style, string view, string anim)
        {
            var key = $"rig|{faction}|{rig}|{style}_{view}_{anim}";
            if (strips.TryGetValue(key, out var s)) return s;
            if (rigIndex == null) rigIndex = JObject.Parse(Resources.Load<TextAsset>("rigs/index").text);
            var rows = (JArray)rigIndex["rigs"][rig];
            int fw = (int)rigIndex["frameW"], fh = (int)rigIndex["frameH"];
            var tex = Tex($"rigs/{faction}_{rig}");
            var name = $"{style}_{view}_{anim}";
            for (int r = 0; r < rows.Count; r++)
            {
                if ((string)rows[r]["name"] != name) continue;
                int n = (int)rows[r]["frames"];
                s = new Sprite[n];
                for (int i = 0; i < n; i++) s[i] = Make(tex, new Rect(i * fw, tex.height - (r + 1) * fh, fw, fh), RigPivot);
                break;
            }
            if (s == null)
            {
                Debug.LogWarning($"Missing rig animation {rig} {name}");
                s = RigFrames(faction, rig, style, view, "idle");
            }
            strips[key] = s;
            return s;
        }

        public static bool HasRig(string rig)
        {
            if (rigIndex == null) rigIndex = JObject.Parse(Resources.Load<TextAsset>("rigs/index").text);
            return rigIndex["rigs"][rig] != null;
        }

        public static bool RigHasAnim(string rig, string anim)
        {
            if (!HasRig(rig)) return false;
            foreach (var row in (JArray)rigIndex["rigs"][rig]) if (((string)row["name"]).EndsWith("_front_" + anim)) return true;
            return false;
        }

        public static Sprite Building(string faction, string name) => Single($"{faction}/{name}", new Vector2(0.5f, 0.04f));

        // ---- Resources ----

        public static Sprite Tree(int kind, int tint)
        {
            var key = $"tree|{kind}|{tint}";
            if (singles.TryGetValue(key, out var s)) return s;
            var src = Asset(kind == 0 ? "terrain/pine" : "terrain/oak");
            var tex = RecolorFoliage(src, TreeTints[tint]);
            s = Make(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0));
            singles[key] = s;
            return s;
        }

        // 16 px bush drawn twice in a cross (see AddResource)
        public static Sprite BushCross => Single("terrain/bush_cross", new Vector2(0.5f, 0));
        public static Sprite Gold(int i) => Single($"terrain/gold{i + 1}", new Vector2(0.5f, 0.25f));
        public static Sprite Stone(int i) => Single($"terrain/stone{i + 1}", new Vector2(0.5f, 0.2f));

        // Sheep sheet baked by unity/Tools/bake-sheep.py: rows idle, graze, walk, dead of 20x16 frames
        static readonly string[] SheepRows = { "idle", "graze", "walk", "dead" };
        public static Sprite[] Sheep(string anim)
        {
            var key = "sheep|" + anim;
            if (strips.TryGetValue(key, out var s)) return s;
            var tex = Asset("terrain/sheep_rig");
            int row = System.Array.IndexOf(SheepRows, anim), frames = anim == "dead" ? 1 : 4;
            s = new Sprite[frames];
            for (int i = 0; i < frames; i++) s[i] = Make(tex, new Rect(i * 20, tex.height - (row + 1) * 16, 20, 16), new Vector2(0.5f, 2.5f / 16));
            strips[key] = s;
            return s;
        }
        public static Sprite Arrow => Single("terrain/arrow", new Vector2(0.5f, 0.5f));

        // ---- FX ----
        static readonly Dictionary<string, int> FxSizes = new Dictionary<string, int>
        {
            ["dust1"] = 64, ["dust2"] = 64, ["fire1"] = 64, ["fire2"] = 64, ["fire3"] = 64, ["explosion1"] = 192, ["explosion2"] = 192,
        };

        public static Sprite[] Fx(string name)
        {
            if (name == "airBlast")
            {
                if (strips.TryGetValue("airBlast", out var a)) return a;
                // 6 frames of 32 px in a 2x3 grid, read row by row from the top
                var tex = Asset("fx/air_blast");
                a = new Sprite[6];
                for (int i = 0; i < 6; i++)
                    a[i] = Make(tex, new Rect((i % 2) * 32, tex.height - (i / 2 + 1) * 32, 32, 32), new Vector2(0.5f, 0.3f));
                strips["airBlast"] = a;
                return a;
            }
            var pivot = name.StartsWith("fire") ? new Vector2(0.5f, 0.05f) : new Vector2(0.5f, 0.3f);
            return Strip($"fx/{name}", FxSizes[name], pivot);
        }

        // ---- Ground ----
        public static Texture2D Grass => Pastel("terrain/meadow_tile");
        // Rock face blended over steep slopes by the terrain shader
        public static Texture2D Cliff => Asset("terrain/cliff_tile");
        public static Texture2D GrassTuft => Pastel("terrain/grass_tuft");

        // Grass softened toward a light, slightly grey pastel (less saturated, a little brighter)
        static readonly Dictionary<string, Texture2D> pastels = new Dictionary<string, Texture2D>();
        static Texture2D Pastel(string name)
        {
            if (pastels.TryGetValue(name, out var t)) return t;
            var src = Asset(name);
            var px = src.GetPixels32();
            for (int i = 0; i < px.Length; i++)
            {
                var c = px[i];
                if (c.a == 0) continue;
                float l = (c.r * 0.3f + c.g * 0.59f + c.b * 0.11f);
                byte P(byte v) => (byte)Mathf.Clamp(Mathf.RoundToInt((l + (v - l) * 0.68f) * 0.86f + 46), 0, 255);
                px[i] = new Color32(P(c.r), P(c.g), P(c.b), c.a);
            }
            t = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = src.wrapMode, name = src.name + " pastel" };
            t.SetPixels32(px);
            t.Apply();
            pastels[name] = t;
            return t;
        }
        public static Texture2D Sand => Asset("terrain/sand_tile");

        static Texture2D[] water;
        // Water: 2 animation frames stacked vertically, copied out so they tile
        public static Texture2D[] Water
        {
            get
            {
                if (water != null) return water;
                var src = Asset("terrain/water_tile");
                water = new Texture2D[2];
                for (int i = 0; i < 2; i++)
                {
                    var t = new Texture2D(16, 16, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat };
                    t.SetPixels(src.GetPixels(0, src.height - (i + 1) * 16, 16, 16));
                    t.Apply();
                    water[i] = t;
                }
                return water;
            }
        }

        // ---- Spirit dimension ----
        // The same ground art recoloured: crimson grass, cold grey rock, a dark teal bed under the
        // shallow water, which is a pale jade; plus the waterfall and the white mist of the void

        static Texture2D Recolor(Texture2D src, string name, System.Func<Color32, Color32> f)
        {
            var px = src.GetPixels32();
            for (int i = 0; i < px.Length; i++) if (px[i].a > 0) px[i] = f(px[i]);
            var t = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = src.wrapMode, name = name };
            t.SetPixels32(px);
            t.Apply();
            return t;
        }

        static float Lum(Color32 c) => (c.r * 0.3f + c.g * 0.59f + c.b * 0.11f) / 255f;
        static byte B(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255), 0, 255);

        // Light and shade of the grass kept, its colour turned to a deep red
        static Color32 Crimson(Color32 c)
        {
            float l = Lum(c);
            return new Color32(B(0.25f + l * 0.95f), B(0.05f + l * 0.32f), B(0.09f + l * 0.33f), c.a);
        }

        static Texture2D spiritGrass, spiritTuft, spiritRock, spiritBed, spiritMist;
        static Texture2D[] spiritWater, waterfall;
        public static Texture2D SpiritGrass => spiritGrass ??= Recolor(Grass, "Spirit grass", Crimson);
        public static Texture2D SpiritGrassTuft => spiritTuft ??= Recolor(GrassTuft, "Spirit tuft", Crimson);
        public static Texture2D SpiritRock => spiritRock ??= Recolor(Cliff, "Spirit rock", c =>
        {
            float l = Lum(c) * 0.9f + 0.08f;
            return new Color32(B(l), B(l * 1.01f), B(l * 1.06f), c.a);
        });
        public static Texture2D SpiritShallowBed => spiritBed ??= Recolor(Sand, "Spirit bed", c =>
        {
            float l = Lum(c);
            return new Color32(B(l * 0.24f), B(l * 0.52f), B(l * 0.44f), c.a);
        });
        public static Texture2D[] SpiritWater
        {
            get
            {
                if (spiritWater != null) return spiritWater;
                spiritWater = new Texture2D[Water.Length];
                for (int i = 0; i < Water.Length; i++)
                    spiritWater[i] = Recolor(Water[i], "Spirit water", c =>
                    {
                        float l = Lum(c);
                        // Jade green-blue
                        return new Color32(B(0.22f + l * 0.45f), B(0.58f + l * 0.4f), B(0.5f + l * 0.38f), c.a);
                    });
                return spiritWater;
            }
        }

        // The waterfall: the game's own water tile in the spirit colour, in 8 frames that slide it down
        // 2 px each (the waterfall mesh's v grows with depth, so moving the pattern to higher rows
        // makes it fall)
        public static Texture2D[] Waterfall
        {
            get
            {
                if (waterfall != null) return waterfall;
                const int F = 8, Step = 2;
                var src = SpiritWater[0];
                int w = src.width, h = src.height;
                var basePx = src.GetPixels32();
                waterfall = new Texture2D[F];
                for (int f = 0; f < F; f++)
                {
                    var px = new Color32[w * h];
                    for (int y = 0; y < h; y++)
                    {
                        int from = ((y - f * Step) % h + h) % h;
                        System.Array.Copy(basePx, from * w, px, y * w, w);
                    }
                    var t = new Texture2D(w, h, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat, name = "Waterfall" };
                    t.SetPixels32(px);
                    t.Apply();
                    waterfall[f] = t;
                }
                return waterfall;
            }
        }

        static Texture2D spiritCliff;
        // The spirit void's cliff face, 64 x 256 px (4 x 16 tiles at 16 px per tile), tiling both ways:
        // the red grass overhanging the lip, a band of rust-orange rock hanging down in points with dark
        // streaks running from it, then tall grey-tan stone columns, each shaded like a rounded pillar
        // lit from the left, split by dark crevices and crossed by ledges. Row 0 of the art is the top
        // (stored flipped: textures start at the bottom)
        public static Texture2D SpiritCliff
        {
            get
            {
                if (spiritCliff != null) return spiritCliff;
                const int W = 64, H = 256;
                float Hash(int x, int y) { float v = Mathf.Sin(x * 127.1f + y * 311.7f) * 43758.5453f; return v - Mathf.Floor(v); }
                Color32 C(int hex) => new Color32((byte)(hex >> 16), (byte)(hex >> 8), (byte)hex, 255);
                Color32 grass = C(0x6a2129), grassDark = C(0x4a161d), shadow = C(0x2e201d), crack = C(0x2f2a26), drip = C(0x3e302a);
                Color32[] rust = { C(0x7e3a1c), C(0xa8521f), C(0xc8692a), C(0xe08a3e), C(0xf0aa5c) };
                Color32[] stone = { C(0x4a443e), C(0x655e55), C(0x80786b), C(0x9a9181), C(0xb3aa98), C(0xc8c0ae) };
                // Columns 9..18 px wide; the last one takes what is left so the tile wraps
                var colOf = new int[W];
                var colStart = new List<int>();
                var posIn = new float[W];
                for (int x = 0; x < W;)
                {
                    int w = 9 + (int)(Hash(x, 7) * 10);
                    if (W - (x + w) < 8) w = W - x;
                    for (int k = 0; k < w; k++) { colOf[x + k] = colStart.Count; posIn[x + k] = (k + 0.5f) / w; }
                    colStart.Add(x);
                    x += w;
                }
                var px = new Color32[W * H];
                for (int x = 0; x < W; x++)
                {
                    int ci = colOf[x], cs = colStart[ci];
                    float p = posIn[x], tone = (Hash(ci, 2) - 0.5f) * 1.4f;
                    int rustEnd = 20 + (int)(Hash(x >> 1, 11) * 10) + Mathf.RoundToInt(Mathf.Sin(x * 0.45f) * 4) + (Hash(ci, 4) > 0.5f ? 6 : 0);
                    int dripEnd = Hash(x >> 1, 19) > 0.8f ? rustEnd + 16 + (int)(Hash(x >> 1, 23) * 70) : 0;
                    int ledgeOff = (int)(Hash(ci, 9) * 30);
                    for (int y = 0; y < H; y++)
                    {
                        Color32 c;
                        if (y < 2) c = grass;
                        else if (y < 3) c = grassDark;
                        else if (y < 5) c = shadow;
                        else if (y < rustEnd)
                        {
                            // Rust, rounded per column like the stone, in thin strata
                            int k = Mathf.RoundToInt(3.4f - p * 2.6f + (Hash(x >> 1, y >> 1) - 0.5f) * 1.2f);
                            if (((y >> 1) + ci) % 6 == 0) k--;
                            if (y < 8) k--;
                            c = rust[Mathf.Clamp(k, 0, 4)];
                        }
                        else
                        {
                            int ny = y - rustEnd;
                            float shade = 3.6f + tone - Mathf.Abs(p - 0.32f) * 4.4f + (Hash(x >> 1, y >> 1) - 0.5f) * 0.9f;
                            if (y > H - 60) shade += (y - (H - 60)) / 60f * 1.2f; // paler toward the mist
                            c = stone[Mathf.Clamp(Mathf.RoundToInt(shade), 0, 5)];
                            if (ny < 3) c = Color32.Lerp(rust[1], c, ny / 3f);
                            int ledge = (y + ledgeOff) % 84;
                            if (ledge == 0) c = crack;
                            else if (ledge == 1) c = stone[5];
                            else if (ledge == 2) c = stone[4];
                            // Short fissures across a column
                            if ((y + ledgeOff) % 21 == 0 && Hash(ci, (y + ledgeOff) / 21) > 0.7f && p > 0.15f && p < 0.85f) c = stone[1];
                        }
                        // The crevice between two columns, 2 px wide in places
                        if (y >= 3 && (x == cs || (x == cs + 1 && Hash(ci, y >> 3) > 0.3f))) c = y < rustEnd ? rust[0] : crack;
                        if (y >= rustEnd - 3 && y < dripEnd && (x & 1) == 0) c = drip;
                        px[(H - 1 - y) * W + x] = c;
                    }
                }
                spiritCliff = new Texture2D(W, H, TextureFormat.RGBA32, true) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat, name = "Spirit cliff" };
                spiritCliff.SetPixels32(px);
                spiritCliff.Apply(true);
                return spiritCliff;
            }
        }

        // Soft pixel clouds on transparency, tiling every 32 px
        public static Texture2D SpiritMist
        {
            get
            {
                if (spiritMist != null) return spiritMist;
                const int S = 32;
                var px = new Color32[S * S];
                for (int y = 0; y < S; y++)
                    for (int x = 0; x < S; x++)
                    {
                        float a = 0;
                        // A few blobs, wrapped so the tile repeats seamlessly
                        foreach (var (cx, cy, r) in new[] { (6f, 8f, 7f), (20f, 5f, 6f), (14f, 20f, 9f), (28f, 24f, 6f), (3f, 27f, 5f) })
                        {
                            float dx = Mathf.Abs(x + 0.5f - cx), dy = Mathf.Abs(y + 0.5f - cy);
                            dx = Mathf.Min(dx, S - dx); dy = Mathf.Min(dy, S - dy);
                            a = Mathf.Max(a, 1 - Mathf.Sqrt(dx * dx + dy * dy) / r);
                        }
                        a = Mathf.Floor(Mathf.Clamp01(a) * 4) / 4; // banded like pixel art
                        px[y * S + x] = new Color32(250, 251, 255, B(a * 0.9f));
                    }
                spiritMist = new Texture2D(S, S, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Repeat, name = "Spirit mist" };
                spiritMist.SetPixels32(px);
                spiritMist.Apply();
                return spiritMist;
            }
        }

        // ---- UI ----
        public static Texture2D UI(string name) => name == "stone" ? StoneIcon : Asset("ui/" + name);

        static Texture2D stoneIcon;
        // A grey pixel-art rock for the stone resource, drawn here like the icons of unity/Tools/gen-art.py
        static Texture2D StoneIcon
        {
            get
            {
                if (stoneIcon != null) return stoneIcon;
                string[] art =
                {
                    "................",
                    "................",
                    "................",
                    "......dddd......",
                    "....ddlllldd....",
                    "...dllwwllmmd...",
                    "..dlwwllllmmmd..",
                    "..dllllllmmmmd..",
                    ".dmllllmmmmmmkd.",
                    ".dmmlmmmmmmmkkd.",
                    ".dmmmmmmmmkkkkd.",
                    "..dkmmmmmkkkkd..",
                    "...ddkkkkkkdd...",
                    ".....dddddd.....",
                    "................",
                    "................",
                };
                var colors = new Dictionary<char, Color32>
                {
                    ['d'] = new Color32(0x3e, 0x3c, 0x3a, 255), ['k'] = new Color32(0x6e, 0x6b, 0x66, 255), ['m'] = new Color32(0x98, 0x95, 0x8e, 255),
                    ['l'] = new Color32(0xbe, 0xbb, 0xb3, 255), ['w'] = new Color32(0xe6, 0xe4, 0xde, 255),
                };
                stoneIcon = new Texture2D(16, 16, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
                for (int y = 0; y < 16; y++)
                    for (int x = 0; x < 16; x++)
                        stoneIcon.SetPixel(x, 15 - y, colors.TryGetValue(art[y][x], out var c) ? (Color)c : Color.clear);
                stoneIcon.Apply();
                return stoneIcon;
            }
        }

        static Texture2D white;
        public static Texture2D White
        {
            get
            {
                if (white != null) return white;
                white = new Texture2D(2, 2) { filterMode = FilterMode.Point };
                white.SetPixels(new[] { Color.white, Color.white, Color.white, Color.white });
                white.Apply();
                return white;
            }
        }

        static Sprite whiteSprite;
        public static Sprite WhiteSprite => whiteSprite ??= Sprite.Create(White, new Rect(0, 0, 2, 2), new Vector2(0.5f, 0), 2);

        // ---- Colour helpers ----

        public static Color Hex(int rgb, float a = 1) =>
            new Color(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f, a);

        // Copies a texture with only its green pixels (the leaves) shifted; the trunk keeps its colours
        static Texture2D RecolorFoliage(Texture2D src, (float h, float s, float l) tint)
        {
            var px = src.GetPixels32();
            for (int i = 0; i < px.Length; i++)
            {
                var c = px[i];
                if (c.a == 0 || c.g < c.r + 20) continue;
                RgbToHsl(c.r, c.g, c.b, out float h, out float s, out float l);
                HslToRgb((h + tint.h + 360) % 360, Mathf.Min(1, s * tint.s), Mathf.Min(1, l * tint.l), out c.r, out c.g, out c.b);
                px[i] = c;
            }
            var t = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            t.SetPixels32(px);
            t.Apply();
            return t;
        }

        static readonly Dictionary<(Texture2D, int), Texture2D> teamTextures = new Dictionary<(Texture2D, int), Texture2D>();

        // Copies a model texture with its team-green pixels (the rigs' #93ff83 key, in any shade) in
        // the team colour, each keeping its shade
        public static Texture2D TeamRecolor(Texture2D src, int team)
        {
            if (src == null) return null;
            if (teamTextures.TryGetValue((src, team), out var t)) return t;
            var color = Hex(team);
            var px = src.GetPixels32();
            for (int i = 0; i < px.Length; i++)
            {
                var c = px[i];
                if (c.a == 0 || c.g < c.r + 50 || c.g < c.b + 50) continue;
                float k = c.g / 255f;
                px[i] = new Color32((byte)(color.r * k * 255), (byte)(color.g * k * 255), (byte)(color.b * k * 255), c.a);
            }
            t = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false) { filterMode = src.filterMode, wrapMode = src.wrapMode };
            t.SetPixels32(px);
            t.Apply();
            teamTextures[(src, team)] = t;
            return t;
        }

        static void RgbToHsl(byte rb, byte gb, byte bb, out float h, out float s, out float l)
        {
            float r = rb / 255f, g = gb / 255f, b = bb / 255f;
            float max = Mathf.Max(r, g, b), min = Mathf.Min(r, g, b);
            l = (max + min) / 2;
            if (max == min) { h = 0; s = 0; return; }
            float d = max - min;
            s = l > 0.5f ? d / (2 - max - min) : d / (max + min);
            h = max == r ? (g - b) / d + (g < b ? 6 : 0) : max == g ? (b - r) / d + 2 : (r - g) / d + 4;
            h *= 60;
        }

        static void HslToRgb(float h, float s, float l, out byte r, out byte g, out byte b)
        {
            float a = s * Mathf.Min(l, 1 - l);
            float F(float n)
            {
                float k = (n + h / 30) % 12;
                return l - a * Mathf.Max(-1, Mathf.Min(k - 3, Mathf.Min(9 - k, 1)));
            }
            r = (byte)Mathf.RoundToInt(F(0) * 255);
            g = (byte)Mathf.RoundToInt(F(8) * 255);
            b = (byte)Mathf.RoundToInt(F(4) * 255);
        }
    }
}
