using System.Collections.Generic;
using UnityEngine;

// Port of client/src/audio.js: named sounds with random variants, per-sound throttling, a voice
// limit, slight pitch variation, looping ambience and a persistent mute toggle (M).
namespace RTS
{
    public class Sfx : MonoBehaviour
    {
        class Sound { public string[] files; public float volume, gap, rate = 1; }

        static readonly Dictionary<string, Sound> Sounds = new Dictionary<string, Sound>
        {
            ["sword"] = new Sound { files = new[] { "sword_1", "sword_2", "sword_3", "sword_impact_1", "sword_impact_2", "sword_impact_3" }, volume = 0.35f, gap = 0.08f },
            ["swing"] = new Sound { files = new[] { "swing_1", "swing_2", "swing_3" }, volume = 0.22f, gap = 0.07f },
            ["block"] = new Sound { files = new[] { "block_1", "block_2", "block_3" }, volume = 0.3f, gap = 0.1f },
            ["battlecry"] = new Sound { files = new[] { "unsheath_1", "unsheath_2" }, volume = 0.3f, gap = 0.12f },
            ["bowDraw"] = new Sound { files = new[] { "bow_draw" }, volume = 0.25f, gap = 0.15f },
            ["arrowBlock"] = new Sound { files = new[] { "arrow_block_1", "arrow_block_2", "arrow_block_3" }, volume = 0.22f, gap = 0.12f },
            ["fireball"] = new Sound { files = new[] { "fireball_1", "fireball_2", "fireball_3" }, volume = 0.28f, gap = 0.12f },
            ["firespray"] = new Sound { files = new[] { "firespray_1", "firespray_2" }, volume = 0.32f, gap = 0.2f },
            ["iceThrow"] = new Sound { files = new[] { "ice_throw_1", "ice_throw_2" }, volume = 0.26f, gap = 0.12f },
            ["freeze"] = new Sound { files = new[] { "ice_freeze_1", "ice_freeze_2" }, volume = 0.22f, gap = 0.3f },
            ["wave"] = new Sound { files = new[] { "wave_1", "wave_2" }, volume = 0.35f, gap = 0.2f },
            ["waterspray"] = new Sound { files = new[] { "waterspray_1", "waterspray_2" }, volume = 0.22f, gap = 0.12f },
            ["rockThrow"] = new Sound { files = new[] { "rock_throw_1", "rock_throw_2" }, volume = 0.3f, gap = 0.15f },
            ["rockWall"] = new Sound { files = new[] { "rock_wall_1", "rock_wall_2" }, volume = 0.32f, gap = 0.15f },
            ["spellImpact"] = new Sound { files = new[] { "spell_impact_1", "spell_impact_2", "spell_impact_3" }, volume = 0.3f, gap = 0.15f },
            ["ageup"] = new Sound { files = new[] { "firebuff_1", "firebuff_2" }, volume = 0.3f, gap = 0.15f },
            ["unlock"] = new Sound { files = new[] { "unlock" }, volume = 0.45f, gap = 1 },
            ["research"] = new Sound { files = new[] { "chest_open" }, volume = 0.4f, gap = 0.5f },
            ["gateOpen"] = new Sound { files = new[] { "gate_open" }, volume = 0.3f, gap = 0.3f },
            ["gateClose"] = new Sound { files = new[] { "gate_close" }, volume = 0.3f, gap = 0.3f },
            ["march"] = new Sound { files = new[] { "march_1", "march_2", "march_3", "march_4", "march_5" }, volume = 0.16f, gap = 0.3f },
            ["ignite"] = new Sound { files = new[] { "ignite" }, volume = 0.3f, gap = 0.5f },
            ["hit"] = new Sound { files = new[] { "hit_1", "hit_2", "hit_3" }, volume = 0.3f, gap = 0.1f },
            ["bow"] = new Sound { files = new[] { "bow_1", "bow_2", "bow_attack_1", "bow_attack_2" }, volume = 0.3f, gap = 0.1f },
            ["arrowHit"] = new Sound { files = new[] { "arrow_hit_1", "arrow_hit_2", "arrow_hit_3", "arrow_impact_1", "arrow_impact_2", "arrow_impact_3" }, volume = 0.25f, gap = 0.12f },
            ["chop"] = new Sound { files = new[] { "chop_1", "chop_2", "chop_3", "chop_4" }, volume = 0.22f, gap = 0.12f },
            ["mine"] = new Sound { files = new[] { "mine_1", "mine_2", "mine_3", "mine_4", "mine_5" }, volume = 0.22f, gap = 0.12f },
            ["hammer"] = new Sound { files = new[] { "chop_2", "chop_4" }, volume = 0.18f, gap = 0.15f, rate = 1.5f },
            ["death"] = new Sound { files = new[] { "death_1", "death_2" }, volume = 0.3f, gap = 0.1f },
            ["collapse"] = new Sound { files = new[] { "collapse" }, volume = 0.5f, gap = 0.4f },
            ["built"] = new Sound { files = new[] { "built" }, volume = 0.45f, gap = 0.3f },
            ["trained"] = new Sound { files = new[] { "trained" }, volume = 0.35f, gap = 0.2f },
            ["heal"] = new Sound { files = new[] { "heal" }, volume = 0.2f, gap = 0.6f },
            ["notice"] = new Sound { files = new[] { "notice" }, volume = 0.4f, gap = 0.5f },
            ["error"] = new Sound { files = new[] { "error" }, volume = 0.35f, gap = 0.3f },
            ["start"] = new Sound { files = new[] { "start" }, volume = 0.5f, gap = 1 },
            ["victory"] = new Sound { files = new[] { "victory" }, volume = 0.6f, gap = 1 },
            ["defeat"] = new Sound { files = new[] { "defeat" }, volume = 0.6f, gap = 1 },
            ["click"] = new Sound { files = new[] { "ui_click" }, volume = 0.3f, gap = 0.05f },
            ["hover"] = new Sound { files = new[] { "ui_hover" }, volume = 0.12f, gap = 0.06f, rate = 1.4f },
            ["place"] = new Sound { files = new[] { "ui_place" }, volume = 0.4f, gap = 0.1f },
        };
        const float AmbientVolume = 0.18f;
        const int MaxVoices = 12;

        static Sfx instance;
        readonly Dictionary<string, AudioClip> clips = new Dictionary<string, AudioClip>();
        readonly Dictionary<string, float> lastPlayed = new Dictionary<string, float>();
        readonly List<AudioSource> voices = new List<AudioSource>();
        AudioSource ambient, river;

        public static bool Muted
        {
            get => PlayerPrefs.GetInt("muted", 0) == 1;
            set
            {
                PlayerPrefs.SetInt("muted", value ? 1 : 0);
                AudioListener.volume = value ? 0 : 1;
            }
        }

        void Awake()
        {
            instance = this;
            gameObject.AddComponent<AudioListener>();
            AudioListener.volume = Muted ? 0 : 1;
            for (int i = 0; i < MaxVoices; i++)
            {
                var src = gameObject.AddComponent<AudioSource>();
                src.playOnAwake = false;
                src.spatialBlend = 0;
                voices.Add(src);
            }
            ambient = gameObject.AddComponent<AudioSource>();
            ambient.loop = true;
            ambient.volume = AmbientVolume;
            ambient.playOnAwake = false;
            river = gameObject.AddComponent<AudioSource>();
            river.loop = true;
            river.volume = 0;
            river.playOnAwake = false;
        }

        AudioClip Clip(string file)
        {
            if (!clips.TryGetValue(file, out var c))
            {
                c = Resources.Load<AudioClip>("assets/sfx/" + file);
                clips[file] = c;
            }
            return c;
        }

        // `volume` scales the sound's own volume (used for distance)
        public static void Play(string name, float volume = 1)
        {
            if (instance == null || Muted || volume <= 0.02f || !Sounds.TryGetValue(name, out var sound)) return;
            float now = Time.unscaledTime;
            if (instance.lastPlayed.TryGetValue(name, out var last) && now - last < sound.gap) return;
            var free = instance.voices.Find(v => !v.isPlaying);
            if (free == null) return;
            instance.lastPlayed[name] = now;
            var clip = instance.Clip(sound.files[Random.Range(0, sound.files.Length)]);
            if (clip == null) return;
            free.pitch = sound.rate * (0.92f + Random.value * 0.16f);
            free.volume = sound.volume * Mathf.Min(1, volume);
            free.clip = clip;
            free.Play();
        }

        // Daytime forest under everything, and a river that swells when the camera is over water
        public static void StartAmbient()
        {
            if (instance == null || instance.ambient.isPlaying) return;
            instance.ambient.clip = instance.Clip("ambient_forest") ?? instance.Clip("ambient");
            if (instance.ambient.clip != null) instance.ambient.Play();
            instance.river.clip = instance.Clip("river_loop");
            if (instance.river.clip != null) instance.river.Play();
        }

        // 0..1: how much river is in view
        public static void SetRiver(float amount)
        {
            if (instance == null || instance.river == null) return;
            instance.river.volume = Mathf.MoveTowards(instance.river.volume, Mathf.Clamp01(amount) * 0.35f, Time.unscaledDeltaTime * 0.3f);
        }

        public static void StopAmbient()
        {
            if (instance && instance.ambient) instance.ambient.Stop();
            if (instance && instance.river) instance.river.Stop();
        }
    }
}
