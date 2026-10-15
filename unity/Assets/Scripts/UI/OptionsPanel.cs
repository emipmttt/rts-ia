using UnityEngine;

// The options page: sound, graphics, camera and interface. Drawn inside whatever panel calls it
// (main menu or the in-game menu); returns the height it used.
namespace RTS.UI
{
    public static class OptionsPanel
    {
        public static float Draw(Rect r)
        {
            float y = r.y, lw = 210, cw = r.width - lw;
            void Section(string title)
            {
                GUI.Label(new Rect(r.x, y, r.width, 26), title, new GUIStyle(Skin.TitleDark) { fontSize = 17, alignment = TextAnchor.MiddleLeft });
                y += 30;
            }
            float Slider(string label, float value, float min, float max, string shown)
            {
                GUI.Label(new Rect(r.x, y, lw, 26), label, Skin.LabelDark);
                float v = GUI.HorizontalSlider(new Rect(r.x + lw, y + 8, cw - 60, 18), value, min, max);
                GUI.Label(new Rect(r.xMax - 52, y, 52, 26), shown, Skin.SmallDark);
                y += 32;
                return v;
            }
            bool Switch(string label, bool on)
            {
                GUI.Label(new Rect(r.x, y, lw, 26), label, Skin.LabelDark);
                bool v = on;
                if (GUI.Button(new Rect(r.x + lw, y - 2, 110, 30), on ? "Sí" : "No", on ? Skin.Button : Skin.RedButton)) { v = !on; Sfx.Play("click"); }
                y += 36;
                return v;
            }
            int Choice(string label, int value, string[] names)
            {
                GUI.Label(new Rect(r.x, y, lw, 26), label, Skin.LabelDark);
                float bw = (cw - (names.Length - 1) * 4) / names.Length;
                int v = value;
                for (int i = 0; i < names.Length; i++)
                    if (GUI.Toggle(new Rect(r.x + lw + i * (bw + 4), y - 2, bw, 30), value == i, names[i], Skin.Button) && value != i) { v = i; Sfx.Play("click"); }
                y += 36;
                return v;
            }

            Section("Sonido");
            float vol = Slider("Volumen general", Settings.MasterVolume, 0, 1, $"{Mathf.RoundToInt(Settings.MasterVolume * 100)}%");
            if (!Mathf.Approximately(vol, Settings.MasterVolume)) Settings.MasterVolume = vol;
            float amb = Slider("Ambiente (bosque, río)", Settings.AmbientVolume, 0, 1, $"{Mathf.RoundToInt(Settings.AmbientVolume * 100)}%");
            if (!Mathf.Approximately(amb, Settings.AmbientVolume)) Settings.AmbientVolume = amb;
            bool muted = Switch("Silenciar todo (M)", Sfx.Muted);
            if (muted != Sfx.Muted) Sfx.Muted = muted;

            Section("Gráficos");
            int sh = Choice("Sombras", (int)Settings.Shadows, new[] { "Altas", "Bajas", "No" });
            if (sh != (int)Settings.Shadows) Settings.Shadows = (Settings.ShadowQuality)sh;
            bool grass = Switch("Pasto animado", Settings.Grass);
            if (grass != Settings.Grass) Settings.Grass = grass;
            bool parts = Switch("Partículas y efectos", Settings.Particles);
            if (parts != Settings.Particles) Settings.Particles = parts;
            bool outl = Switch("Contornos de color", Materials.Outlines);
            if (outl != Materials.Outlines) Materials.Outlines = outl;
            bool full = Switch("Pantalla completa", Screen.fullScreen);
            if (full != Screen.fullScreen) Screen.fullScreen = full;

            Section("Cámara e interfaz");
            float cs = Slider("Velocidad de la cámara", Settings.CameraSpeed, 0.4f, 2.5f, $"x{Settings.CameraSpeed:0.0}");
            if (!Mathf.Approximately(cs, Settings.CameraSpeed)) Settings.CameraSpeed = cs;
            bool edge = Switch("Mover con el borde de la pantalla", Settings.EdgeScroll);
            if (edge != Settings.EdgeScroll) Settings.EdgeScroll = edge;
            bool fps = Switch("Mostrar FPS", Settings.ShowFps);
            if (fps != Settings.ShowFps) Settings.ShowFps = fps;
            return y - r.y;
        }
    }
}
