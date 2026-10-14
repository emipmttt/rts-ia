using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using RTS.Net;

// Juice: pixel particles, projectiles, shockwaves and sprite effects. Speeds and sizes keep the 2D
// client's numbers in game px and are converted to world units (1/40) here.
namespace RTS.Game
{
    public partial class GameView
    {
        static readonly int[] WindColors = { 0xffffff, 0xc9d3dc, 0x8fd0ff, 0xe8f6ff };
        static readonly int[] FireColors = { 0xfff3b0, 0xffd34d, 0xff8a2a, 0xe0401f };
        static readonly int[] Embers = { 0xffd34d, 0xff8a2a, 0xe0401f, 0x6b5a50, 0x4a4440 };
        static readonly int[] WoodChips = { 0x8b5a2b, 0xc89b62, 0x6b4423 };
        static readonly int[] StoneSparks = { 0xfff3b0, 0xffffff, 0xb8c0c8, 0x7a828a };
        static readonly int[] Dust = { 0xd8c08a, 0xbfa678, 0x9c8660 };
        static readonly int[] MeatBits = { 0xd9534f, 0xb3261e, 0xffffff };
        static readonly int[] HitSparks = { 0xffffff, 0xfff3b0, 0xb3261e };
        static readonly int[] Swoosh = { 0xffffff, 0xe8f6ff, 0xc9d3dc };
        static readonly int[] StunColors = { 0xfff176, 0xffffff, 0x8fd0ff };
        static readonly int[] EarthColors = { 0xb9ab92, 0x8f8270, 0x5e5446, 0xd8c08a };
        static readonly int[] WaterColors = { 0xf2fbff, 0x9fdcff, 0x4a9fe0, 0xffffff };
        static readonly int[] IceColors = { 0xffffff, 0xd8f3ff, 0x9fdcff };
        static readonly Dictionary<string, int> MarkerColors = new Dictionary<string, int>
        {
            ["move"] = 0x7dff7a, ["attack"] = 0xff5252, ["gather"] = 0xffd34d, ["build"] = 0xffa040,
        };
        const float MarkerLife = 0.55f;
        const float P = C.PxToUnit;
        const float PixelSize = 2.2f * P * 1.3f; // one art pixel of the rigs, a bit bigger to read in 3D

        class Bit { public Vector3 pos, vel; public float life, max, g; public int color; public int[] colors; }
        class Wave { public float x, y, radius, t, life; public int[] colors; }
        class Projectile { public Vector3 from; public int? targetId; public Vector3 to; public float t, spin; public SpriteRenderer sprite; }
        class Marker { public float x, y, t; public int color; }
        class FxAnim { public SpriteRenderer sr; public Sprite[] frames; public float t, fps; }
        class Trail { public float x, y, life, max; public int color; }
        class Spike { public float x, y, t, height; public bool dusted; }

        readonly List<Bit> bits = new List<Bit>();
        readonly List<Wave> waves = new List<Wave>();
        readonly List<Projectile> arrows = new List<Projectile>(), gusts = new List<Projectile>(), fireballs = new List<Projectile>();
        readonly List<Projectile> boulders = new List<Projectile>(), shards = new List<Projectile>();
        readonly List<Trail> trails = new List<Trail>();
        readonly List<Spike> spikes = new List<Spike>();
        readonly List<Marker> markers = new List<Marker>();
        readonly List<FxAnim> fxAnims = new List<FxAnim>();

        // Loose pixels are only spawned where the player can see
        void AddBit(Vector3 pos, Vector3 vel, float life, int[] colors, int color = 0xffffff, float g = 0, float max = -1)
        {
            if (InSight(pos)) bits.Add(new Bit { pos = pos, vel = vel, life = life, max = max > 0 ? max : life, colors = colors, color = color, g = g });
        }

        // Scatters n loose pixels from pos: `speed` outward over the ground, `up` extra upward kick,
        // `g` gravity in px/s² (positive falls, negative rises); `dir` (screen angle, 0 = right,
        // pi/2 = toward the camera) + `spread` aim them in a cone
        void Burst(Vector3 pos, int n, int[] colors, float speed, float up = 0, float life = 0.4f, float g = 0, float? dir = null, float spread = Mathf.PI * 2)
        {
            for (int i = 0; i < n; i++)
            {
                float a = dir == null ? Random.value * Mathf.PI * 2 : dir.Value + (Random.value - 0.5f) * spread;
                float v = speed * (0.4f + Random.value * 0.8f);
                var vel = (ScreenVec(Mathf.Cos(a), Mathf.Sin(a) * 0.7f) * v + Vector3.up * up * Random.value) * P;
                AddBit(pos, vel, life * (0.7f + Random.value * 0.5f), null, colors[i % colors.Length], g, life);
            }
        }

        // One-shot sprite animation at a world position (dust, explosions, blasts)
        SpriteRenderer SpawnFx(string name, Vector3 pos, float scale = 1, float fps = 18)
        {
            var go = new GameObject("Fx " + name);
            go.transform.SetParent(worldRoot, false);
            go.transform.position = pos;
            go.transform.rotation = billboardRot;
            go.transform.localScale = Vector3.one * scale;
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sharedMaterial = Materials.SpriteGlow;
            sr.shadowCastingMode = ShadowCastingMode.Off;
            var frames = GameAssets.Fx(name);
            sr.sprite = frames[0];
            fxAnims.Add(new FxAnim { sr = sr, frames = frames, fps = fps });
            return sr;
        }

        void UpdateFx(float dt)
        {
            for (int i = fxAnims.Count - 1; i >= 0; i--)
            {
                var f = fxAnims[i];
                f.t += dt;
                int frame = (int)(f.t * f.fps);
                if (frame >= f.frames.Length) { Destroy(f.sr.gameObject); fxAnims.RemoveAt(i); continue; }
                f.sr.sprite = f.frames[frame];
                f.sr.transform.rotation = billboardRot;
            }
            // Loose pixels: drag, gravity, colours ageing through `colors` (fire -> smoke)
            float drag = Mathf.Pow(0.92f, dt * 60);
            for (int i = bits.Count - 1; i >= 0; i--)
            {
                var b = bits[i];
                b.life -= dt;
                if (b.life <= 0) { bits[i] = bits[bits.Count - 1]; bits.RemoveAt(bits.Count - 1); continue; }
                b.vel.y -= b.g * P * dt;
                b.pos += b.vel * dt;
                b.vel *= drag;
                float age = 1 - b.life / b.max;
                int color = b.colors != null ? b.colors[Mathf.Min(b.colors.Length - 1, (int)(age * b.colors.Length))] : b.color;
                pixels.Pixel(b.pos, PixelSize, GameAssets.Hex(color, Mathf.Min(1, b.life / b.max * 1.5f)));
            }
            // Surfer trails: dust or frost marks on the ground, fading
            for (int i = trails.Count - 1; i >= 0; i--)
            {
                var tr = trails[i];
                tr.life -= dt;
                if (tr.life <= 0) { trails[i] = trails[trails.Count - 1]; trails.RemoveAt(trails.Count - 1); continue; }
                overlay.GroundRect(tr.x - 2.5f, tr.y - 2.5f, 5, 5, GameAssets.Hex(tr.color, Mathf.Min(0.8f, tr.life / tr.max)), 0.06f);
            }
            DrawSpikes(dt);
            // Shockwaves: a ring of pixels on the ground growing outward and thinning
            for (int i = waves.Count - 1; i >= 0; i--)
            {
                var w = waves[i];
                w.t += dt;
                if (w.t >= w.life) { waves.RemoveAt(i); continue; }
                if (w.t < 0) continue;
                float q = w.t / w.life;
                float rx = w.radius * (0.2f + q * 0.8f);
                int n = Mathf.Max(8, Mathf.RoundToInt(rx * 1.2f));
                for (int k = 0; k < n; k++)
                {
                    float a = k * Mathf.PI * 2 / n;
                    float px = 3.2f;
                    overlay.GroundRect(w.x + Mathf.Cos(a) * rx - px / 2, w.y + Mathf.Sin(a) * rx - px / 2, px, px, GameAssets.Hex(w.colors[k % 3], 1 - q), 0.08f);
                }
            }
        }

        // Taking damage: a short red flash and sparks off the body
        void OnHit(EntityView s)
        {
            s.hitAt = Time.time;
            if (s.isBuilding)
            {
                float half = Defs.BuildingSize(s.s.type) / 2;
                Burst(s.root.transform.position + camRight * (Random.value - 0.5f) * half * P + Vector3.up * 0.3f, 8, Dust, 70, 50, 0.5f, 200);
                return;
            }
            Burst(Chest(s), 7, HitSparks, 90, 30, 0.3f, 150);
        }

        // Animation events: particles fired on the frame where a tool or weapon lands
        void FrameEvent(EntityView s, string anim, int frame)
        {
            int f = s.facing;
            float reach = s.view == "side" ? 14 : 8;
            var hit = Feet(s) + camRight * f * reach * P + Vector3.up * 0.35f;
            bool civFire = IsFire(s.s.owner);
            float away = f > 0 ? Mathf.PI : 0;
            if (s.s.type == "villager")
            {
                if (anim == "axe" && frame == 3) Burst(hit + Vector3.up * 0.1f, 8, WoodChips, 90, 60, 0.5f, 260, away, 2.4f);
                else if (anim == "pickaxe" && frame == 3)
                {
                    Burst(hit, 6, StoneSparks, 120, 40, 0.3f, 200);
                    Burst(hit - Vector3.up * 0.1f, 4, Dust, 40, 20, 0.5f, 100);
                }
                else if (anim == "hammer" && frame == 3)
                {
                    Burst(hit - Vector3.up * 0.15f, 6, Dust, 50, 30, 0.45f, 120);
                    Burst(hit, 2, StoneSparks, 80, 40, 0.25f, 200);
                }
                else if (anim == "knife" && frame == 1) Burst(hit, 5, MeatBits, 60, 40, 0.4f, 240);
                return;
            }
            // Melee swings leave a swoosh: a half-ring of pixels in front of the fighter drifting forward
            void DoSwoosh(float r)
            {
                SfxAt("swing", s.gx, s.gy);
                for (int i = 0; i < 7; i++)
                {
                    float a = -Mathf.PI / 2 + i / 6f * Mathf.PI;
                    var pos = Feet(s) + Vector3.up * 0.4f + camRight * f * Mathf.Cos(a) * r * P - Vector3.up * Mathf.Sin(a) * r * 0.8f * P;
                    AddBit(pos, camRight * f * 25 * P, 0.16f + i * 0.015f, null, Swoosh[i % Swoosh.Length], 0, 0.26f);
                }
            }
            // Spearman: the blade whistles as it gathers back; the thrust shoots a line of air off the
            // tip with sparks where it lands and kicks dust from the planted foot
            if (s.s.type == "spearman" && anim == "attack")
            {
                if (frame == 1) SfxAt("swing", s.gx, s.gy);
                else if (frame == 2)
                {
                    var tip = Feet(s) + Vector3.up * 0.45f + camRight * f * 16 * P;
                    for (int i = 0; i < 5; i++) AddBit(tip - camRight * f * i * 3 * P, camRight * f * (60 + i * 12) * P, 0.18f, null, Swoosh[i % Swoosh.Length], 0, 0.22f);
                    Burst(tip, 6, HitSparks, 80, 30, 0.3f, 200, f > 0 ? 0 : Mathf.PI, 1.0f);
                    Burst(Feet(s) + camRight * f * 4 * P, 4, Dust, 40, 15, 0.4f, 100);
                }
                return;
            }
            var civ = CivOf(s.s.owner);
            if (civ == "earth" || civ == "water")
            {
                bool water = civ == "water";
                var bent = water ? WaterColors : EarthColors;
                if (s.s.type == "swordsman" && anim == "attack" && frame == 2)
                    Burst(hit + Vector3.up * 0.15f, 8, bent, 90, 40, 0.4f, water ? 160 : 260, f > 0 ? 0 : Mathf.PI, 1.4f);
                else if (s.s.type == "archer" && anim == "shoot" && frame == 1)
                {
                    // The stomp (earth) or the water drawn into a ring (water)
                    Burst(Feet(s) + Vector3.up * 0.05f, 10, water ? WaterColors : Dust, 70, water ? 60 : 20, 0.45f, water ? 120 : 80);
                    var sp = global::RTS.World.Ground.ToServer(Feet(s));
                    waves.Add(new Wave { x = sp.x, y = sp.y, radius = 22, life = 0.25f, colors = water ? WaterColors : EarthColors });
                }
                else if (s.s.type == "horseman" && anim == "attack" && frame == 3)
                    Burst(Feet(s) + Vector3.up * 0.05f, 12, water ? IceColors : Dust, 90, 30, 0.45f, 120);
                return;
            }
            if (s.s.type == "swordsman" && anim == "attack")
            {
                if (civFire && (frame == 1 || frame == 2)) DoSwoosh(14);
                else if (civFire && frame == 4) { DoSwoosh(16); DoSwoosh(11); }
                else if (!civFire && frame == 3)
                {
                    DoSwoosh(16);
                    Burst(hit + camRight * f * 6 * P, 5, Dust, 50, 20, 0.35f, 120);
                }
            }
            else if (s.s.type == "archer" && anim == "shoot" && !civFire && frame == 3)
                Burst(hit + Vector3.up * 0.1f, 10, WindColors, 110, 0, 0.35f, 0, f > 0 ? 0 : Mathf.PI, 1.2f);
            else if (s.s.type == "monk" && anim == "heal" && frame == 2)
                Burst(Feet(s) + camRight * f * 6 * P + Vector3.up * 1.1f, 6, new[] { 0x7dff7a, 0xfff59d }, 30, 30, 0.6f, -40);
        }

        // The air explosion art, recoloured into flames for the fire civilization
        void BlastFx(Vector3 pos, float scale, bool fire)
        {
            var sr = SpawnFx("airBlast", pos, scale);
            if (fire) sr.color = GameAssets.Hex(0xff7a2a);
        }

        void BlastFx(Vector3 pos, float scale, int tint) => SpawnFx("airBlast", pos, scale).color = GameAssets.Hex(tint);

        // Takeoff aura: a low ring of wind (or flames) blasting outward, pixels shooting upward
        void TakeoffBurst(Vector3 feet, bool fire)
        {
            var colors = fire ? FireColors : WindColors;
            BlastFx(feet, 2, fire);
            for (int i = 0; i < 26; i++)
            {
                float a = i / 26f * Mathf.PI * 2;
                float speed = 160 + Random.value * 60;
                AddBit(feet + Vector3.up * 0.05f, new Vector3(Mathf.Cos(a), 0, Mathf.Sin(a)) * speed * P, 0.35f, null, colors[i % colors.Length]);
            }
            for (int i = 0; i < 10; i++)
                AddBit(feet + camRight * (Random.value - 0.5f) * 20 * P, (camRight * (Random.value - 0.5f) * 30 + Vector3.up * (150 + Random.value * 120)) * P, 0.4f, null, colors[i % colors.Length]);
            var sp = global::RTS.World.Ground.ToServer(feet);
            waves.Add(new Wave { x = sp.x, y = sp.y, radius = 34, life = 0.3f, colors = colors });
        }

        // Stunned units: three pixel stars circling over the head
        void DrawStun(EntityView s, float r)
        {
            float t = Time.time * 1000 / 160;
            for (int i = 0; i < 3; i++)
            {
                float a = t + i * Mathf.PI * 2 / 3;
                var c = Feet(s) + Vector3.up * (1.75f + s.alt * P) + new Vector3(Mathf.Cos(a), 0, Mathf.Sin(a)) * 9 * P;
                var col = GameAssets.Hex(StunColors[i]);
                pixels.Pixel(c, PixelSize, col);
                pixels.Pixel(c + camRight * PixelSize, PixelSize, col);
                pixels.Pixel(c - camRight * PixelSize, PixelSize, col);
                pixels.Pixel(c + Vector3.up * PixelSize, PixelSize, col);
                pixels.Pixel(c - Vector3.up * PixelSize, PixelSize, col);
            }
        }

        static int[] ElementColors(string element) => element switch
        {
            "fire" => FireColors, "earth" => EarthColors, "water" => WaterColors, _ => WindColors,
        };

        // Fast units' area hits: the flyers' dive (wind or fire) and the surfers' slam, which also
        // throws up a ring of rock spikes (earth) or a splash of water (water)
        void ElementBlast(float x, float y, float radius, int? attackerId, string element)
        {
            if (element != "earth" && element != "water") { WindBlast(x, y, radius, attackerId, element == "fire"); return; }
            if (attackerId != null && sprites.TryGetValue(attackerId.Value, out var attacker)) attacker.lastBlast = Time.time;
            bool water = element == "water";
            var colors = ElementColors(element);
            SfxAt(water ? "wave" : "rockWall", x, y);
            var pos = ground.ToWorld(x, y);
            BlastFx(pos, 3.5f, water ? 0x8fd8ff : 0xc8a878);
            waves.Add(new Wave { x = x, y = y, radius = radius * 1.3f, life = 0.45f, colors = colors });
            waves.Add(new Wave { x = x, y = y, radius = radius * 0.7f, t = -0.08f, life = 0.4f, colors = colors });
            if (!water)
                for (int i = 0; i < 7; i++)
                {
                    float a = i / 7f * Mathf.PI * 2 + Random.value * 0.4f;
                    spikes.Add(new Spike { x = x + Mathf.Cos(a) * radius * 0.6f, y = y + Mathf.Sin(a) * radius * 0.6f, t = -i * 0.02f, height = 6 + Random.value * 3 });
                }
            for (int i = 0; i < 40; i++)
            {
                float a = Random.value * Mathf.PI * 2;
                var dir = new Vector3(Mathf.Cos(a), 0, Mathf.Sin(a));
                AddBit(pos + dir * radius * 0.2f * P + Vector3.up * 0.1f,
                    (dir * radius * (1.5f + Random.value * 2) + Vector3.up * (80 + Random.value * 140)) * P, 0.6f, null, colors[i % colors.Length], water ? 300 : 400);
            }
            var vp = rts.cam.WorldToViewportPoint(pos);
            if (vp.z > 0 && vp.x > 0 && vp.y > 0 && vp.x < 1 && vp.y < 1) rts.Shake = Mathf.Max(rts.Shake, water ? 0.2f : 0.35f);
        }

        // Flyer's dive impact: dust, a double shockwave, a wall of wind over the blast radius,
        // debris thrown up and a short camera shake
        void WindBlast(float x, float y, float radius, int? attackerId, bool fire)
        {
            var colors = fire ? FireColors : WindColors;
            if (attackerId != null && sprites.TryGetValue(attackerId.Value, out var attacker)) attacker.lastBlast = Time.time;
            SfxAt(fire ? "firespray" : "spellImpact", x, y);
            var pos = ground.ToWorld(x, y);
            BlastFx(pos, 4, fire);
            waves.Add(new Wave { x = x, y = y, radius = radius * 1.4f, life = 0.45f, colors = colors });
            waves.Add(new Wave { x = x, y = y, radius = radius * 0.8f, t = -0.08f, life = 0.4f, colors = colors });
            for (int i = 0; i < 24; i++)
            {
                var p = ground.ToWorld(x + (Random.value - 0.5f) * radius, y + (Random.value - 0.5f) * radius * 0.5f, 0.05f);
                AddBit(p, (Random.insideUnitSphere * 30 + Vector3.up * (120 + Random.value * 160)) * P, 0.55f, null, colors[i % colors.Length]);
            }
            var vp = rts.cam.WorldToViewportPoint(pos);
            if (vp.z > 0 && vp.x > 0 && vp.y > 0 && vp.x < 1 && vp.y < 1) rts.Shake = Mathf.Max(rts.Shake, 0.3f);
            for (int i = 0; i < 70; i++)
            {
                float a = i / 70f * Mathf.PI * 2 + Random.value * 0.2f;
                float speed = radius * (4 + Random.value * 2);
                float start = 4 + Random.value * 6;
                var dir = new Vector3(Mathf.Cos(a), 0, Mathf.Sin(a));
                AddBit(pos + dir * start * P + Vector3.up * 0.1f, dir * speed * P, 0.5f, null, colors[i % colors.Length]);
            }
        }

        // Fireball impact: flames thrown out in a ring, sparks shooting up, a hot shockwave
        void FireBurst(Vector3 pos)
        {
            var sp = global::RTS.World.Ground.ToServer(pos);
            SfxAt("arrowHit", sp.x, sp.y);
            for (int i = 0; i < 40; i++)
            {
                float a = i / 40f * Mathf.PI * 2 + Random.value * 0.2f;
                float speed = 100 + Random.value * 120;
                AddBit(pos, new Vector3(Mathf.Cos(a), 0.2f, Mathf.Sin(a)) * speed * P, 0.5f + Random.value * 0.3f, Embers, 0, -120, 0.8f);
            }
            var hot = new[] { 0xfff3b0, 0xffd34d, 0xff8a2a, 0xe0401f, 0x6b5a50, 0x4a4440 };
            for (int i = 0; i < 10; i++)
                AddBit(pos + camRight * (Random.value - 0.5f) * 12 * P, (camRight * (Random.value - 0.5f) * 40 + Vector3.up * (120 + Random.value * 120)) * P, 0.6f, hot);
            waves.Add(new Wave { x = sp.x, y = sp.y, radius = 42, life = 0.3f, colors = FireColors });
            waves.Add(new Wave { x = sp.x, y = sp.y, radius = 24, t = -0.06f, life = 0.25f, colors = FireColors });
        }

        // Where a fire mage's hand is: art coords relative to the rig's 16 px reference sprite,
        // which sits at (10, 10) in the 24x28 frame whose feet are at row 24
        Vector3 MageHand(EntityView s, float ax, float ay)
        {
            float k = UnitArt["archer"].scale;
            return Feet(s) + camRight * (ax + 10 - 12) * k * s.facing * P + Vector3.up * (24 - (ay + 10)) * k * P;
        }

        // Fire mage particles: embers rise off the flame in its hand; while winding up an attack,
        // sparks spiral in toward the fireball forming over its head
        void MageFire(EntityView s)
        {
            bool casting = s.s.action == "attacking";
            if (casting && s.frame < 3)
            {
                var c = MageHand(s, 2, 0);
                for (int i = 0; i < 3; i++)
                {
                    float a = Random.value * Mathf.PI * 2;
                    float d = 14 + Random.value * 10;
                    var off = (camRight * Mathf.Cos(a) * d + Vector3.up * Mathf.Sin(a) * d * 0.7f) * P;
                    AddBit(c + off, -off * 5, 0.22f, new[] { 0xfff3b0, 0xffd34d, 0xff8a2a });
                }
                return;
            }
            if (casting || Random.value > 0.45f) return;
            var h = MageHand(s, 7, 4);
            AddBit(h + camRight * (Random.value - 0.5f) * 3 * P, (camRight * (Random.value - 0.5f) * 12 + Vector3.up * (20 + Random.value * 25)) * P, 0.5f, Embers, 0, -30);
        }

        // The moment the fireball leaves: the cast jumps to the throw, flames burst from the hands
        // and a hot ring pushes out
        void MageRelease(EntityView s)
        {
            if (s == null) return;
            if (s.frames.Length > 3) s.animTime = 3 * s.frameDuration;
            var h = MageHand(s, 8, 6);
            var hot = new[] { 0xfff3b0, 0xffd34d, 0xff8a2a, 0xe0401f, 0x6b5a50, 0x4a4440 };
            for (int i = 0; i < 22; i++)
            {
                float a = (Random.value - 0.5f) * 1.6f;
                float speed = 60 + Random.value * 120;
                AddBit(h, (camRight * Mathf.Cos(a) * speed * s.facing + Vector3.up * (-Mathf.Sin(a) * speed + 20)) * P, 0.45f, hot, 0, -80);
            }
            waves.Add(new Wave { x = s.gx, y = s.gy, radius = 26, life = 0.25f, colors = FireColors });
        }

        // A burning unit or building: flame tongues licking up its body, embers rising off it,
        // and (units) the sprite flickering orange
        void DrawBurning(EntityView s)
        {
            bool building = s.isBuilding;
            float half = building ? Defs.BuildingSize(s.s.type) / 2 : s.stats.radius;
            float now = Time.time * 1000;
            int n = building ? 6 : 3;
            var basePos = Feet(s) + Vector3.up * (building ? 0.15f : 0.05f + s.alt * P) - camFwdFlat * (building ? half * 0.4f * P : 0.05f);
            for (int i = 0; i < n; i++)
            {
                var fx = basePos + camRight * ((i + 0.5f) / n - 0.5f) * half * 1.6f * P;
                int h = 2 + Mathf.RoundToInt((Mathf.Sin(now / 70 + i * 2.1f + s.s.id) + 1) * 1.5f);
                for (int k = 0; k < h; k++)
                {
                    int color = FireColors[Mathf.Min(3, (int)((float)k / h * 4))];
                    float sway = Mathf.Round(Mathf.Sin(now / 90 + k + i) * 0.6f);
                    pixels.Pixel(fx + camRight * sway * PixelSize + Vector3.up * k * PixelSize, PixelSize, GameAssets.Hex(color));
                }
            }
            if (Random.value < (building ? 0.6f : 0.35f))
                AddBit(basePos + camRight * (Random.value - 0.5f) * half * 1.4f * P + Vector3.up * Random.value * 0.35f,
                    (camRight * (Random.value - 0.5f) * 15 + Vector3.up * (30 + Random.value * 30)) * P, 0.8f, Embers, 0, -40);
            if (!building && Mathf.Sin(now / 60 + s.s.id) > 0.2f) s.sprite.color = GameAssets.Hex(0xffb27a);
        }

        // ---------- Projectiles ----------

        // Arrows from towers, air blasts from air warriors, fireballs from fire mages and the
        // flyers' dive impacts
        public void AddShots(JToken shots)
        {
            foreach (var t in (JArray)shots)
            {
                var shot = Shot.Parse(t);
                // Shots fired and landing in the fog are not shown
                if (!InSight(shot.x, shot.y) && !(shot.tx != null && InSight(shot.tx.Value, shot.ty ?? shot.y))
                    && !(shot.targetId != null && sprites.TryGetValue(shot.targetId.Value, out var seenTarget) && seenTarget.inSight)) continue;
                if (shot.kind == "blast") { ElementBlast(shot.x, shot.y, shot.radius, shot.attackerId, shot.element ?? (shot.fire ? "fire" : "air")); continue; }
                if (shot.kind == "earthLine") { EarthLine(shot); continue; }
                if (shot.targetId == null || !sprites.TryGetValue(shot.targetId.Value, out var target)) continue;
                SfxAt(shot.kind == "fireball" ? "fireball" : shot.kind == "ice" ? "iceThrow" : shot.kind == "rock" ? "rockThrow" : "bow", shot.x, shot.y);
                EntityView attacker = null;
                if (shot.attackerId != null) sprites.TryGetValue(shot.attackerId.Value, out attacker);
                // Units shoot from their hands; towers and town centers from high up
                var from = attacker != null ? Chest(attacker) + Vector3.up * 0.2f : ground.ToWorld(shot.x, shot.y + 20, 2.2f);
                var p = new Projectile { from = from, targetId = shot.targetId, to = Chest(target), spin = Random.value * Mathf.PI * 2 };
                if (shot.kind == "archer") gusts.Add(p);
                else if (shot.kind == "fireball") { fireballs.Add(p); MageRelease(attacker); }
                else if (shot.kind == "rock") boulders.Add(p);
                else if (shot.kind == "ice") shards.Add(p);
                else arrows.Add(p);
            }
        }

        void Track(Projectile p)
        {
            if (p.targetId != null && sprites.TryGetValue(p.targetId.Value, out var target)) p.to = Chest(target);
        }

        void DrawArrows(float dt)
        {
            const float FlightTime = 0.3f;
            for (int i = arrows.Count - 1; i >= 0; i--)
            {
                var a = arrows[i];
                if (a.sprite == null)
                {
                    var go = new GameObject("Arrow");
                    go.transform.SetParent(worldRoot, false);
                    a.sprite = go.AddComponent<SpriteRenderer>();
                    a.sprite.sprite = GameAssets.Arrow;
                    a.sprite.sharedMaterial = Materials.SpriteLit;
                    a.sprite.shadowCastingMode = ShadowCastingMode.On;
                    go.transform.localScale = Vector3.one * 0.45f;
                }
                a.t += dt / FlightTime;
                Track(a);
                float t = Mathf.Min(1, a.t);
                // Arc so arrows read as shots rather than lasers
                var pos = Vector3.Lerp(a.from, a.to, t) + Vector3.up * Mathf.Sin(t * Mathf.PI) * 0.8f;
                var dir = (a.to - a.from) + Vector3.up * Mathf.Cos(t * Mathf.PI) * 0.8f * Mathf.PI;
                a.sprite.transform.position = pos;
                // The arrow art points right (+x): lay that axis along the flight, face the camera
                var right = dir.normalized;
                var fwd = Vector3.ProjectOnPlane(rts.cam.transform.forward, right).normalized;
                if (fwd.sqrMagnitude > 0.001f) a.sprite.transform.rotation = Quaternion.LookRotation(fwd, Vector3.Cross(fwd, right));
                if (a.t >= 1)
                {
                    Destroy(a.sprite.gameObject);
                    var sp = global::RTS.World.Ground.ToServer(a.to);
                    SfxAt("arrowHit", sp.x, sp.y);
                    arrows.RemoveAt(i);
                }
            }
        }

        // Air blast: a spinning knot of grey/white/blue pixels with a fading trail, bursting on impact
        void DrawGusts(float dt)
        {
            const float FlightTime = 0.4f;
            for (int i = gusts.Count - 1; i >= 0; i--)
            {
                var a = gusts[i];
                a.t += dt / FlightTime;
                Track(a);
                float t = Mathf.Min(1, a.t);
                var c = Vector3.Lerp(a.from, a.to, t);
                var heading = (a.to - a.from).normalized;
                var across = Vector3.Cross(heading, rts.cam.transform.forward).normalized;
                a.spin += dt * 18;
                float size = 1 + Mathf.Sin(t * Mathf.PI) * 0.6f;
                for (int k = 0; k < 9; k++)
                {
                    float ang = a.spin + k / 9f * Mathf.PI * 2;
                    var p = c + heading * Mathf.Cos(ang) * 6 * size * P + across * Mathf.Sin(ang) * 3.5f * size * P;
                    pixels.Pixel(p, PixelSize, GameAssets.Hex(WindColors[k % WindColors.Length]));
                }
                pixels.Pixel(c, PixelSize, Color.white);
                for (int k = 0; k < 2; k++)
                    AddBit(c + Random.insideUnitSphere * 3 * P, (-heading * 30 + Random.insideUnitSphere * 10) * P, 0.3f, null, WindColors[Random.Range(0, WindColors.Length)]);
                if (a.t >= 1)
                {
                    var sp = global::RTS.World.Ground.ToServer(a.to);
                    SfxAt("arrowHit", sp.x, sp.y);
                    for (int k = 0; k < 18; k++)
                    {
                        float ang = k / 18f * Mathf.PI * 2 + Random.value * 0.3f;
                        float speed = 50 + Random.value * 50;
                        AddBit(a.to, (camRight * Mathf.Cos(ang) + Vector3.up * Mathf.Sin(ang) * 0.6f) * speed * P, 0.45f, null, WindColors[k % WindColors.Length]);
                    }
                    gusts.RemoveAt(i);
                }
            }
        }

        // Fireball: a flickering pixel ball on a high arc, shedding embers; bursts into flames on impact
        void DrawFireballs(float dt)
        {
            const float FlightTime = 0.6f;
            for (int i = fireballs.Count - 1; i >= 0; i--)
            {
                var f = fireballs[i];
                f.t += dt / FlightTime;
                Track(f);
                float t = Mathf.Min(1, f.t);
                var c = Vector3.Lerp(f.from, f.to, t) + Vector3.up * (0.35f + Mathf.Sin(t * Mathf.PI) * 0.75f);
                var up = rts.cam.transform.up;
                // A 7x7 diamond with a white-hot core and a flickering edge
                for (int dy = -3; dy <= 3; dy++)
                    for (int dx = -3; dx <= 3; dx++)
                    {
                        int d = Mathf.Abs(dx) + Mathf.Abs(dy);
                        if (d > 3 || (d == 3 && Random.value < 0.4f)) continue;
                        pixels.Pixel(c + camRight * dx * PixelSize + up * dy * PixelSize, PixelSize,
                            GameAssets.Hex(FireColors[Mathf.Min(3, d + (Random.value < 0.3f ? 1 : 0))]));
                    }
                var back = (f.from - f.to).normalized;
                for (int k = 1; k <= 4; k++)
                    pixels.Pixel(c + back * (k + 2) * PixelSize + camRight * (Random.value - 0.5f) * 2 * PixelSize, PixelSize, GameAssets.Hex(FireColors[Mathf.Min(3, k)]));
                for (int k = 0; k < 5; k++)
                    AddBit(c + Random.insideUnitSphere * 3 * P, Random.insideUnitSphere * 10 * P, 0.5f, Embers, 0, -60);
                if (f.t >= 1)
                {
                    FireBurst(f.to);
                    fireballs.RemoveAt(i);
                }
            }
        }

        // ---------- Earth and water ----------

        // Geomancer's line: rock spikes erupt one after another from the caster to past the target
        void EarthLine(Shot shot)
        {
            float tx = shot.tx ?? shot.x, ty = shot.ty ?? shot.y;
            float dx = tx - shot.x, dy = ty - shot.y, len = Mathf.Sqrt(dx * dx + dy * dy);
            if (len < 1) return;
            const float Step = 13;
            int n = Mathf.Max(1, Mathf.FloorToInt((len - 16) / Step));
            for (int i = 0; i <= n; i++)
            {
                float d = 16 + i * Step, side = (i % 2 == 0 ? 1 : -1) * 3;
                spikes.Add(new Spike
                {
                    x = shot.x + dx / len * d - dy / len * side, y = shot.y + dy / len * d + dx / len * side,
                    t = -i * 0.035f, height = 7 + Mathf.Min(i, 4) * 1.2f + Random.value * 2,
                });
            }
            SfxAt("rockWall", shot.x, shot.y);
        }

        // Spikes: triangles of rock pixels pushing out of the ground, holding, then sinking back
        void DrawSpikes(float dt)
        {
            const float Rise = 0.1f, Hold = 0.4f, Sink = 0.25f;
            var up = Vector3.up;
            for (int i = spikes.Count - 1; i >= 0; i--)
            {
                var sp = spikes[i];
                sp.t += dt;
                if (sp.t >= Rise + Hold + Sink) { spikes[i] = spikes[spikes.Count - 1]; spikes.RemoveAt(spikes.Count - 1); continue; }
                if (sp.t < 0) continue;
                var basePos = ground.ToWorld(sp.x, sp.y);
                if (!sp.dusted)
                {
                    sp.dusted = true;
                    Burst(basePos + up * 0.05f, 5, Dust, 50, 40, 0.45f, 160);
                    Burst(basePos + up * 0.1f, 3, EarthColors, 60, 90, 0.4f, 350);
                }
                float q = sp.t < Rise ? sp.t / Rise : sp.t < Rise + Hold ? 1 : 1 - (sp.t - Rise - Hold) / Sink;
                int rows = Mathf.RoundToInt(sp.height);
                float sunk = (1 - q) * rows; // rows still under the ground
                for (int k = 0; k < rows; k++)
                {
                    float y = k - sunk;
                    if (y < 0) continue;
                    int w = Mathf.Max(0, Mathf.RoundToInt((rows - k) * 3f / rows));
                    for (int x = -w; x <= w; x++)
                    {
                        int color = k == rows - 1 ? 0xb9ab92 : x < 0 ? 0xb9ab92 : x == 0 ? 0x8f8270 : 0x5e5446;
                        pixels.Pixel(basePos + camRight * x * PixelSize + up * (y + 0.5f) * PixelSize, PixelSize, GameAssets.Hex(color));
                    }
                }
            }
        }

        // Boulder (geomancers against buildings): a lumpy rock on a high arc shedding dust;
        // shatters into rubble on impact
        void DrawBoulders(float dt)
        {
            const float FlightTime = 0.7f;
            var up = rts.cam.transform.up;
            for (int i = boulders.Count - 1; i >= 0; i--)
            {
                var b = boulders[i];
                b.t += dt / FlightTime;
                Track(b);
                float t = Mathf.Min(1, b.t);
                var c = Vector3.Lerp(b.from, b.to, t) + Vector3.up * (Mathf.Sin(t * Mathf.PI) * 1.4f);
                b.spin += dt * 8;
                for (int dy = -2; dy <= 2; dy++)
                    for (int dx = -2; dx <= 2; dx++)
                    {
                        if (Mathf.Abs(dx) + Mathf.Abs(dy) > 3) continue;
                        // Light from the top left, rotating slowly
                        float l = Mathf.Cos(b.spin) * dx - dy;
                        int color = l < -1 ? 0xb9ab92 : l > 1.5f ? 0x5e5446 : 0x8f8270;
                        pixels.Pixel(c + camRight * dx * PixelSize + up * dy * PixelSize, PixelSize, GameAssets.Hex(color));
                    }
                if (Random.value < 0.5f) AddBit(c + Random.insideUnitSphere * 0.08f, Random.insideUnitSphere * 10 * P, 0.4f, null, Dust[Random.Range(0, Dust.Length)], 40);
                if (b.t < 1) continue;
                var sp = global::RTS.World.Ground.ToServer(b.to);
                SfxAt("mine", sp.x, sp.y);
                Burst(b.to, 14, EarthColors, 120, 120, 0.6f, 400);
                Burst(b.to - Vector3.up * 0.2f, 10, Dust, 60, 30, 0.6f, 60);
                waves.Add(new Wave { x = sp.x, y = sp.y, radius = 30, life = 0.3f, colors = EarthColors });
                boulders.RemoveAt(i);
            }
        }

        // Ice shard (hydromancers): a fast, sharp sliver of ice trailing sparkles; shatters on impact
        void DrawShards(float dt)
        {
            const float FlightTime = 0.32f;
            for (int i = shards.Count - 1; i >= 0; i--)
            {
                var a = shards[i];
                a.t += dt / FlightTime;
                Track(a);
                float t = Mathf.Min(1, a.t);
                var c = Vector3.Lerp(a.from, a.to, t) + Vector3.up * Mathf.Sin(t * Mathf.PI) * 0.25f;
                var heading = (a.to - a.from).normalized;
                var across = Vector3.Cross(heading, rts.cam.transform.forward).normalized;
                for (int k = -3; k <= 3; k++)
                {
                    var p = c + heading * k * PixelSize;
                    pixels.Pixel(p, PixelSize, GameAssets.Hex(k >= 2 ? 0xffffff : k >= 0 ? 0xd8f3ff : 0x9fdcff));
                    if (Mathf.Abs(k) <= 1) pixels.Pixel(p + across * PixelSize, PixelSize, GameAssets.Hex(0x9fdcff));
                    if (k == 0) pixels.Pixel(p - across * PixelSize, PixelSize, GameAssets.Hex(0x4a9fe0));
                }
                if (Random.value < 0.6f) AddBit(c - heading * 0.15f, (-heading * 20 + Random.insideUnitSphere * 10) * P, 0.35f, null, IceColors[Random.Range(0, IceColors.Length)], 80);
                if (a.t < 1) continue;
                var sp = global::RTS.World.Ground.ToServer(a.to);
                SfxAt("arrowHit", sp.x, sp.y);
                Burst(a.to, 16, IceColors, 110, 60, 0.45f, 300);
                waves.Add(new Wave { x = sp.x, y = sp.y, radius = 20, life = 0.25f, colors = WaterColors });
                shards.RemoveAt(i);
            }
        }

        // Slowed by ice: a frosty tint and snowflakes drifting down around the unit
        void DrawChill(EntityView s)
        {
            if (Time.time - s.hitAt >= HitFlash) s.sprite.color = GameAssets.Hex(0xb5e3ff);
            if (Random.value < 0.25f)
                AddBit(Feet(s) + Vector3.up * (0.4f + Random.value * 0.9f + s.alt * P) + camRight * (Random.value - 0.5f) * 0.6f,
                    (Vector3.up * -15 + camRight * (Random.value - 0.5f) * 10) * P, 0.7f, null, IceColors[Random.Range(0, IceColors.Length)]);
            var sp = global::RTS.World.Ground.ToServer(Feet(s));
            float r = s.stats.radius + 4;
            for (int k = 0; k < 6; k++)
            {
                float a = k * Mathf.PI / 3 + s.s.id;
                overlay.GroundRect(sp.x + Mathf.Cos(a) * r - 1.5f, sp.y + Mathf.Sin(a) * r * 0.7f - 1.5f, 3, 3, GameAssets.Hex(0xd8f3ff, 0.8f), 0.06f);
            }
        }

        // Expanding ring + a burst of sparks where an order was given, in the order's colour
        void DrawMarkers(float dt)
        {
            for (int i = markers.Count - 1; i >= 0; i--)
            {
                var m = markers[i];
                m.t += dt;
                if (m.t >= MarkerLife) { markers.RemoveAt(i); continue; }
                float k = m.t / MarkerLife;
                float alpha = 1 - k;
                float ease = 1 - Mathf.Pow(1 - k, 3);
                float r = 6 + ease * 22;
                overlay.GroundRing(m.x, m.y, r, r, 2 + 2 * alpha, GameAssets.Hex(m.color, alpha));
                overlay.GroundRect(m.x - 4 * alpha, m.y - 4 * alpha, 8 * alpha, 8 * alpha, new Color(1, 1, 1, alpha));
                for (int j = 0; j < 8; j++)
                {
                    float a = j / 8f * Mathf.PI * 2;
                    float d = 6 + ease * 26;
                    var p = ground.ToWorld(m.x + Mathf.Cos(a) * d, m.y + Mathf.Sin(a) * d, 0.1f + ease * 0.25f);
                    pixels.Pixel(p, (2.5f * alpha + 0.5f) * 2 * P, GameAssets.Hex(m.color, alpha));
                }
            }
        }
    }
}
