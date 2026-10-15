using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

// Player options, kept in PlayerPrefs and applied at once. Shown by UI.OptionsPanel in the main menu
// and in the in-game menu.
namespace RTS
{
    public static class Settings
    {
        public enum ShadowQuality { High, Low, Off }

        static float F(string k, float d) => PlayerPrefs.GetFloat(k, d);
        static bool B(string k, bool d) => PlayerPrefs.GetInt(k, d ? 1 : 0) == 1;
        static void Set(string k, float v) { PlayerPrefs.SetFloat(k, v); Apply(); }
        static void Set(string k, bool v) { PlayerPrefs.SetInt(k, v ? 1 : 0); Apply(); }

        public static float MasterVolume { get => F("opt.volume", 0.8f); set => Set("opt.volume", Mathf.Clamp01(value)); }
        public static float AmbientVolume { get => F("opt.ambient", 0.6f); set => Set("opt.ambient", Mathf.Clamp01(value)); }
        public static ShadowQuality Shadows { get => (ShadowQuality)PlayerPrefs.GetInt("opt.shadows", 0); set { PlayerPrefs.SetInt("opt.shadows", (int)value); Apply(); } }
        public static bool Grass { get => B("opt.grass", true); set => Set("opt.grass", value); }
        public static bool EdgeScroll { get => B("opt.edgeScroll", false); set => Set("opt.edgeScroll", value); }
        public static float CameraSpeed { get => F("opt.camSpeed", 1); set => Set("opt.camSpeed", Mathf.Clamp(value, 0.4f, 2.5f)); }
        public static bool ShowFps { get => B("opt.fps", false); set => Set("opt.fps", value); }
        public static bool Particles { get => B("opt.particles", true); set => Set("opt.particles", value); }

        // Bumped on every change so views can refresh what they cache (grass on/off, ...)
        public static int Version { get; private set; }

        public static void Apply()
        {
            Version++;
            Sfx.ApplyVolumes();
            var sun = RenderSettings.sun;
            if (sun != null) sun.shadows = Shadows == ShadowQuality.Off ? LightShadows.None : Shadows == ShadowQuality.Low ? LightShadows.Hard : LightShadows.Soft;
            if (GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp)
            {
                urp.shadowDistance = Shadows == ShadowQuality.High ? 80 : 45;
                urp.shadowCascadeCount = Shadows == ShadowQuality.High ? 2 : 1;
            }
        }
    }
}
