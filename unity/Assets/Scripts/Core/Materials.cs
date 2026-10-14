using System.Collections.Generic;
using UnityEngine;

// Shared materials, created once at runtime
namespace RTS
{
    public static class Materials
    {
        // The "outlines" setting: team-coloured outlines around units and buildings
        public static bool Outlines
        {
            get => PlayerPrefs.GetInt("outlines", 0) == 1;
            set { PlayerPrefs.SetInt("outlines", value ? 1 : 0); ApplyOutlines(); }
        }
        public static void ApplyOutlines() => Shader.SetGlobalFloat("_OutlinesOn", Outlines ? 1 : 0);

        static readonly Dictionary<Color, Material> lit = new Dictionary<Color, Material>();
        static readonly Dictionary<(Texture2D, Texture2D, bool), Material> models = new Dictionary<(Texture2D, Texture2D, bool), Material>();
        static readonly Dictionary<(Texture2D, bool), Material> ghosts = new Dictionary<(Texture2D, bool), Material>();
        static readonly Dictionary<Color, Material> units = new Dictionary<Color, Material>();
        static Material spriteLit, spriteGlow, ghost, pixels, overlay;

        // Lit flat colour (bridges, logs, flag poles)
        public static Material Lit(Color color)
        {
            if (lit.TryGetValue(color, out var m)) return m;
            m = new Material(Shader.Find("RTS/Terrain"));
            m.SetTexture("_MainTex", GameAssets.White);
            m.SetColor("_Color", color);
            m.SetFloat("_SlopeDark", 0);
            m.SetFloat("_VertexColor", 0);
            lit[color] = m;
            return m;
        }

        // Textured 3D models (glTF) lit like the terrain, with an optional normal map; double-sided
        // ones skip back-face culling
        public static Material Model(Texture2D tex, Texture2D normal, bool doubleSided)
        {
            if (models.TryGetValue((tex, normal, doubleSided), out var m)) return m;
            m = new Material(Shader.Find("RTS/Terrain")) { name = "Model" };
            if (normal != null)
            {
                m.SetTexture("_BumpMap", normal);
                m.EnableKeyword("_NORMALMAP");
            }
            m.SetTexture("_MainTex", tex != null ? tex : GameAssets.White);
            m.SetFloat("_SlopeDark", 0);
            m.SetFloat("_Cull", doubleSided ? 0 : 2);
            models[(tex, normal, doubleSided)] = m;
            return m;
        }

        // Translucent unlit copy of a model's texture (building placement preview)
        public static Material ModelGhost(Texture2D tex, bool doubleSided)
        {
            if (ghosts.TryGetValue((tex, doubleSided), out var m)) return m;
            m = new Material(Shader.Find("RTS/Unlit")) { name = "ModelGhost" };
            m.SetTexture("_MainTex", tex != null ? tex : GameAssets.White);
            m.SetFloat("_ZTest", 4);
            m.SetFloat("_FogOfWar", 0);
            ghosts[(tex, doubleSided)] = m;
            return m;
        }

        // Pixel-art billboards that cast and receive shadows
        public static Material SpriteLit => spriteLit ??= new Material(Shader.Find("RTS/SpriteLit")) { name = "SpriteLit" };

        // Units and sheep: lit sprites that show through buildings as a silhouette in this colour, and
        // are outlined in it when outlines are on (`outline` false for sheep)
        public static Material UnitSprite(Color color, bool outline = true)
        {
            var key = outline ? color : new Color(color.r, color.g, color.b, 0.5f);
            if (units.TryGetValue(key, out var m)) return m;
            m = new Material(SpriteLit) { name = "UnitSprite" };
            m.SetColor("_XrayColor", new Color(color.r, color.g, color.b, 0.55f));
            if (outline) m.SetColor("_OutlineColor", new Color(color.r, color.g, color.b, 1));
            units[key] = m;
            return m;
        }

        // Glowing sprites (fire, explosions, blasts): unlit, alpha blended
        public static Material SpriteGlow => spriteGlow ??= new Material(Shader.Find("RTS/Unlit")) { name = "SpriteGlow" };

        // Building placement preview: unlit and never darkened by the fog of war
        public static Material Ghost
        {
            get
            {
                if (ghost != null) return ghost;
                ghost = new Material(Shader.Find("RTS/Unlit")) { name = "Ghost" };
                ghost.SetFloat("_FogOfWar", 0);
                return ghost;
            }
        }

        // Camera-facing pixel particles
        public static Material Pixels
        {
            get
            {
                if (pixels != null) return pixels;
                pixels = new Material(Shader.Find("RTS/Unlit")) { name = "Pixels" };
                pixels.SetTexture("_MainTex", GameAssets.White);
                return pixels;
            }
        }

        // Rings, footprints and markers drawn on the ground (always visible over the terrain and the fog)
        public static Material Overlay
        {
            get
            {
                if (overlay != null) return overlay;
                overlay = new Material(Shader.Find("RTS/Unlit")) { name = "Overlay" };
                overlay.SetTexture("_MainTex", GameAssets.White);
                overlay.SetFloat("_ZBias", -4);
                overlay.SetFloat("_FogOfWar", 0);
                overlay.renderQueue = 3100;
                return overlay;
            }
        }
    }
}
