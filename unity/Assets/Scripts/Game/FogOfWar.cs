using UnityEngine;

// Fog of war, Age of Empires style: the map starts black, ground seen once stays explored (dark and
// greyish, showing the terrain, resources and buildings as they were last seen) and only what the
// player's units and buildings see right now is lit and shows enemy units. Visibility is recomputed
// a few times per second on a grid of half tiles, eased over time so edges glide instead of popping,
// and uploaded as a global texture that every world shader applies (FogOfWar.hlsl).
// Purely visual: the server still sends everything.
namespace RTS.Game
{
    public class FogOfWar
    {
        public const int Res = 2;                  // cells per tile
        const float Soft = 1.2f;                   // tiles over which sight fades out at its edge
        const float Refresh = 0.1f;                // seconds between visibility updates
        const float FadeSpeed = 2.5f;              // display change per second (0..1)
        const float SeenThreshold = 0.25f;         // sight needed to show enemy units

        readonly int n, w;                         // map side in tiles, in cells
        readonly float[] sight;                    // this update: 0..1 per cell
        readonly bool[] explored;
        readonly float[] shown, target;            // displayed and wanted texture values
        readonly byte[] bytes;
        public readonly Texture2D Texture;
        float lastRefresh = -1;
        bool revealAll;

        public FogOfWar(int mapTiles)
        {
            n = mapTiles;
            w = n * Res;
            sight = new float[w * w];
            explored = new bool[w * w];
            shown = new float[w * w];
            target = new float[w * w];
            bytes = new byte[w * w];
            Texture = new Texture2D(w, w, TextureFormat.R8, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp, name = "FogOfWar" };
            Upload();
            Shader.SetGlobalTexture("_FogOfWarTex", Texture);
            Shader.SetGlobalVector("_FogOfWarParams", new Vector4(1f / n, 1, 0, 0));
        }

        // Spectators and finished games see the whole map
        public bool RevealAll
        {
            get => revealAll;
            set
            {
                if (revealAll == value) return;
                revealAll = value;
                lastRefresh = -1;
            }
        }

        public bool Due => Time.time - lastRefresh >= Refresh;

        // Start a visibility update: forget what was seen last time
        public void Begin()
        {
            lastRefresh = Time.time;
            System.Array.Clear(sight, 0, sight.Length);
        }

        // Something of ours at server px (x, y) sees `radius` px around it
        public void Reveal(float x, float y, float radius)
        {
            float cx = x / C.TileSize * Res, cy = y / C.TileSize * Res;
            float r = radius / C.TileSize * Res, soft = Soft * Res;
            int x0 = Mathf.Max(0, Mathf.FloorToInt(cx - r)), x1 = Mathf.Min(w - 1, Mathf.CeilToInt(cx + r));
            int y0 = Mathf.Max(0, Mathf.FloorToInt(cy - r)), y1 = Mathf.Min(w - 1, Mathf.CeilToInt(cy + r));
            for (int j = y0; j <= y1; j++)
            {
                float dy = j + 0.5f - cy;
                for (int i = x0; i <= x1; i++)
                {
                    float dx = i + 0.5f - cx;
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d >= r) continue;
                    float v = Mathf.Min(1, (r - d) / soft);
                    int k = j * w + i;
                    if (v > sight[k]) sight[k] = v;
                    explored[k] = true;
                }
            }
        }

        // Finish the update: new texture targets
        public void End()
        {
            for (int k = 0; k < target.Length; k++)
                target[k] = revealAll ? 1 : explored[k] ? 0.5f + 0.5f * sight[k] : 0;
        }

        // Ease the displayed fog toward the targets and upload it when it changed
        public void Animate(float dt)
        {
            float step = FadeSpeed * dt;
            bool changed = false;
            for (int k = 0; k < shown.Length; k++)
            {
                float s = shown[k], t = target[k];
                if (s == t) continue;
                shown[k] = s < t ? Mathf.Min(t, s + step) : Mathf.Max(t, s - step);
                changed = true;
            }
            if (changed) Upload();
        }

        void Upload()
        {
            for (int k = 0; k < shown.Length; k++) bytes[k] = (byte)(shown[k] * 255);
            Texture.SetPixelData(bytes, 0);
            Texture.Apply(false);
        }

        int Cell(float x, float y)
        {
            int i = Mathf.FloorToInt(x / C.TileSize * Res), j = Mathf.FloorToInt(y / C.TileSize * Res);
            if (i < 0 || j < 0 || i >= w || j >= w) return -1;
            return j * w + i;
        }

        // In sight of the player right now (server px)
        public bool Visible(float x, float y)
        {
            if (revealAll) return true;
            int k = Cell(x, y);
            return k >= 0 && sight[k] > SeenThreshold;
        }

        // Seen at some point in the game (server px)
        public bool Explored(float x, float y)
        {
            if (revealAll) return true;
            int k = Cell(x, y);
            return k >= 0 && explored[k];
        }

        public bool VisibleTile(int tx, int ty) => Visible((tx + 0.5f) * C.TileSize, (ty + 0.5f) * C.TileSize);

        public bool ExploredTile(int tx, int ty) => Explored((tx + 0.5f) * C.TileSize, (ty + 0.5f) * C.TileSize);

        // Any of a building's footprint in sight: its centre or a point inside each corner
        public bool VisibleArea(float x, float y, float half)
        {
            float h = Mathf.Max(0, half - 10);
            return Visible(x, y) || Visible(x - h, y - h) || Visible(x + h, y - h) || Visible(x - h, y + h) || Visible(x + h, y + h);
        }

        // The colour the territory map darkens a tile to: black unexplored, dim out of sight
        public float Brightness(int tx, int ty)
        {
            if (revealAll) return 1;
            int k = (ty * Res + Res / 2) * w + tx * Res + Res / 2;
            return explored[k] ? 0.5f + 0.5f * Mathf.Min(1, sight[k] * 1.5f) : 0;
        }

        public static void Disable() => Shader.SetGlobalVector("_FogOfWarParams", Vector4.zero);
    }
}
