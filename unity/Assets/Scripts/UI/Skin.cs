using System.Collections.Generic;
using UnityEngine;

// IMGUI skin made from the game's own pixel-art UI pieces (painted by unity/Tools/gen-art.py): blue
// and red 9-slice buttons, parchment and wooden panels, ribbons in every team colour. The pieces are
// tiny; they are scaled up by a whole factor with nearest-neighbour so every art pixel stays a crisp
// square block.
namespace RTS.UI
{
    public static class Skin
    {
        public static GUIStyle Slot, Panel, Button, RedButton, Paper, Wood, Label, LabelDark, Title, TitleDark, Small, SmallDark, Field, Tooltip, Toggle, Center;
        static readonly Dictionary<string, GUIStyle> ribbons = new Dictionary<string, GUIStyle>();
        static bool ready;
        public static float Scale = 1;

        // Scales pixel art up by the whole factor k (nearest-neighbour): each art pixel a k x k block
        static Texture2D Resample(Texture2D src, int k)
        {
            int w = src.width * k, h = src.height * k;
            var dst = new Texture2D(w, h, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            var sp = src.GetPixels();
            var px = new Color[w * h];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    px[y * w + x] = sp[(y / k) * src.width + x / k];
            dst.SetPixels(px);
            dst.Apply();
            return dst;
        }

        // `slice`: art pixels of the piece's border; `k`: screen pixels per art pixel
        static GUIStyle NineSlice(string name, int slice, int k, int padding, Color text, int fontSize)
        {
            var tex = Resample(GameAssets.UI(name), k);
            int border = slice * k;
            var s = new GUIStyle
            {
                border = new RectOffset(border, border, border, border),
                padding = new RectOffset(padding, padding, padding, padding),
                alignment = TextAnchor.MiddleCenter,
                fontSize = fontSize,
                fontStyle = FontStyle.Bold,
                wordWrap = true,
            };
            s.normal.background = tex;
            s.normal.textColor = text;
            return s;
        }

        static GUIStyle ButtonStyle(string color)
        {
            var s = NineSlice($"btn_{color}_9", 5, 3, 6, Color.white, 15);
            var pressed = NineSlice($"btn_{color}_pressed_9", 5, 3, 6, Color.white, 15);
            s.active.background = pressed.normal.background;
            s.active.textColor = Color.white;
            s.hover.background = s.normal.background;
            s.hover.textColor = new Color(1, 0.95f, 0.75f);
            s.onNormal.background = pressed.normal.background;
            s.onNormal.textColor = new Color(1, 0.92f, 0.5f);
            s.contentOffset = new Vector2(0, -2);
            return s;
        }

        public static void Ensure()
        {
            if (ready) return;
            ready = true;
            Button = ButtonStyle("blue");
            RedButton = ButtonStyle("red");
            Paper = NineSlice("paper_9", 8, 3, 20, new Color(0.24f, 0.16f, 0.08f), 15);
            Paper.alignment = TextAnchor.UpperLeft;
            Wood = NineSlice("woodtable_9", 8, 3, 16, Color.white, 14);
            Wood.alignment = TextAnchor.UpperLeft;
            Slot = SlotStyle();
            Panel = new GUIStyle { border = new RectOffset(6, 6, 6, 6), padding = new RectOffset(10, 10, 8, 8) };
            Panel.normal.background = PanelTexture();
            Tooltip = NineSlice("paper_9", 8, 2, 14, new Color(0.24f, 0.16f, 0.08f), 13);
            Tooltip.alignment = TextAnchor.UpperLeft;
            Tooltip.fontStyle = FontStyle.Normal;

            Label = new GUIStyle(GUI.skin.label) { fontSize = 15, fontStyle = FontStyle.Bold, wordWrap = true };
            Label.normal.textColor = Color.white;
            LabelDark = new GUIStyle(Label);
            LabelDark.normal.textColor = new Color(0.24f, 0.16f, 0.08f);
            Small = new GUIStyle(Label) { fontSize = 12, fontStyle = FontStyle.Normal };
            SmallDark = new GUIStyle(Small);
            SmallDark.normal.textColor = new Color(0.36f, 0.27f, 0.17f);
            Title = new GUIStyle(Label) { fontSize = 28, alignment = TextAnchor.MiddleCenter };
            TitleDark = new GUIStyle(Title);
            TitleDark.normal.textColor = new Color(0.24f, 0.16f, 0.08f);
            Center = new GUIStyle(Label) { alignment = TextAnchor.MiddleCenter };
            Field = new GUIStyle(GUI.skin.textField) { fontSize = 16, padding = new RectOffset(8, 8, 6, 6) };
            Field.normal.textColor = Field.focused.textColor = Field.hover.textColor = new Color(0.2f, 0.13f, 0.06f);
            var fieldTex = new Texture2D(1, 1);
            fieldTex.SetPixel(0, 0, new Color(1f, 0.97f, 0.88f));
            fieldTex.Apply();
            Field.normal.background = Field.focused.background = Field.hover.background = fieldTex;
            Toggle = new GUIStyle(GUI.skin.toggle) { fontSize = 15 };
            Toggle.normal.textColor = Toggle.onNormal.textColor = Toggle.hover.textColor = Toggle.onHover.textColor = new Color(0.24f, 0.16f, 0.08f);
        }

        // Command bar slot: dark inset wood; a light rim on hover, a gold rim when active (selected)
        static GUIStyle SlotStyle()
        {
            Texture2D Make(Color rim, Color fill)
            {
                const int N = 12;
                var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
                for (int y = 0; y < N; y++)
                    for (int x = 0; x < N; x++)
                    {
                        int d = Mathf.Min(Mathf.Min(x, y), Mathf.Min(N - 1 - x, N - 1 - y));
                        t.SetPixel(x, y, d < 2 ? rim : d == 2 ? new Color(0, 0, 0, 0.35f) : fill);
                    }
                t.Apply();
                return t;
            }
            var fill = new Color(0.17f, 0.13f, 0.1f, 0.95f);
            var s = new GUIStyle { border = new RectOffset(4, 4, 4, 4) };
            s.normal.background = Make(new Color(0.42f, 0.32f, 0.22f), fill);
            s.hover.background = Make(new Color(0.85f, 0.75f, 0.55f), new Color(0.22f, 0.17f, 0.13f, 0.95f));
            s.active.background = Make(new Color(0.95f, 0.85f, 0.6f), new Color(0.12f, 0.09f, 0.07f, 0.95f));
            s.onNormal.background = s.onHover.background = s.onActive.background = Make(new Color(0.93f, 0.76f, 0.35f), new Color(0.26f, 0.2f, 0.12f, 0.95f));
            return s;
        }

        // Dark translucent wood: a 3 px frame with a light inner edge
        static Texture2D PanelTexture()
        {
            const int N = 16;
            var t = new Texture2D(N, N, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            var frame = new Color(0.36f, 0.23f, 0.12f, 1);
            var dark = new Color(0.2f, 0.12f, 0.06f, 1);
            var edge = new Color(0.66f, 0.47f, 0.27f, 1);
            var fill = new Color(0.12f, 0.08f, 0.05f, 0.8f);
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    int d = Mathf.Min(Mathf.Min(x, y), Mathf.Min(N - 1 - x, N - 1 - y));
                    t.SetPixel(x, y, d == 0 ? dark : d < 3 ? frame : d == 3 ? edge : fill);
                }
            t.Apply();
            return t;
        }

        // A banner in a team colour; `ends`: about how wide its folded tails are on screen
        public static GUIStyle Ribbon(string color, int ends = 60)
        {
            var key = color + ends;
            if (ribbons.TryGetValue(key, out var s)) return s;
            const int ArtEnds = 10; // art pixels of each tail in ribbon_*.png
            int k = Mathf.Max(1, Mathf.RoundToInt(ends / (float)ArtEnds));
            var tex = Resample(GameAssets.UI($"ribbon_{color}"), k);
            int border = ArtEnds * k;
            s = new GUIStyle
            {
                border = new RectOffset(border, border, 0, 0),
                padding = new RectOffset(border - 6, border - 6, 2, 6),
                alignment = TextAnchor.MiddleCenter,
                fontSize = 20,
                fontStyle = FontStyle.Bold,
                wordWrap = true,
            };
            s.normal.background = tex;
            s.normal.textColor = Color.white;
            ribbons[key] = s;
            return s;
        }

        public static void Rect(Rect r, Color c)
        {
            var old = GUI.color;
            GUI.color = c;
            GUI.DrawTexture(r, GameAssets.White);
            GUI.color = old;
        }

        public static void Frame(Rect r, Color c, float w = 1)
        {
            Rect(new Rect(r.x, r.y, r.width, w), c);
            Rect(new Rect(r.x, r.yMax - w, r.width, w), c);
            Rect(new Rect(r.x, r.y, w, r.height), c);
            Rect(new Rect(r.xMax - w, r.y, w, r.height), c);
        }

        // Label with a dark outline so it reads over the 3D world
        public static void Outlined(Rect r, string text, GUIStyle style)
        {
            var normal = style.normal.textColor;
            style.normal.textColor = new Color(0, 0, 0, 0.85f);
            foreach (var o in new[] { new Vector2(-1, 0), new Vector2(1, 0), new Vector2(0, -1), new Vector2(0, 1) })
                GUI.Label(new Rect(r.x + o.x, r.y + o.y, r.width, r.height), text, style);
            style.normal.textColor = normal;
            GUI.Label(r, text, style);
        }
    }
}
