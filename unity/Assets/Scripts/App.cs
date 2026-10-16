using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using RTS.Game;
using RTS.Net;
using RTS.UI;

// Port of client/src/main.js + index.html: connects to the Node server, runs the lobby (name, flag
// editor, rooms), the waiting room (civilization, central castle option) and the end screen, and
// creates the 3D game when a match starts. Also builds the scene: camera, sun, sky, post-processing.
namespace RTS
{
    public class App : MonoBehaviour
    {
        public static App Instance { get; private set; }

        // Main menu -> Jugar (lobby: name, server, flag, rooms) -> room -> game; Opciones and Cómo jugar
        // hang off the main menu. Everything but the game shows the animated backdrop behind it.
        enum Screen { Menu, Options, Help, Lobby, Room, Game }
        Screen screen = Screen.Menu;
        MenuBackdrop backdrop;
        float fpsSmooth;
        bool reconnecting;
        float reconnectedAt = -1;
        SocketIO socket;
        string myId;
        string token;
        string playerName, roomName = "", server;

        // Servers offered in the lobby: shown by name only (the address stays hidden)
        static readonly (string name, string host)[] Servers =
        {
            ("Local", $"localhost:{C.DefaultPort}"),
            ("Producción", $"157.230.50.215:{C.DefaultPort}"),
        };
        int serverChoice;
        bool serverMenuOpen;
        string ServerName => serverChoice >= 0 ? Servers[serverChoice].name : "Personalizado";
        string lobbyError = "", roomError = "";
        List<RoomSummary> rooms = new List<RoomSummary>();
        RoomDetails currentRoom;
        GameView game;
        Camera cam;
        Vector2 roomScroll;
        bool autoStarted;

        // Flag editor: freehand, lines and filled shapes in a small palette. Black is "my colour": it is
        // exported as pure white, which the game paints in the player's colour; every other colour is
        // kept as drawn. Transparent shows the white cloth.
        const int FlagW = 96, FlagH = 64, FlagZoom = 3;
        Texture2D flagCanvas;
        Vector2? lastFlagPoint, shapeStart;
        Color32[] beforeStroke, undoPixels;
        enum FlagTool { Brush, Line, Rect, Circle, Triangle, Fill, Eraser }
        static readonly (FlagTool tool, string label)[] FlagTools =
        {
            (FlagTool.Brush, "Pincel"), (FlagTool.Line, "Línea"), (FlagTool.Rect, "Rect."), (FlagTool.Circle, "Círculo"),
            (FlagTool.Triangle, "Triáng."), (FlagTool.Fill, "Relleno"), (FlagTool.Eraser, "Goma"),
        };
        static readonly Color32 TeamInk = new Color32(0, 0, 0, 255);
        static readonly Color32[] FlagPalette =
        {
            TeamInk, new Color32(0xf5, 0xf5, 0xf0, 255), new Color32(0x26, 0x22, 0x22, 255), new Color32(0xd6, 0x3c, 0x34, 255), new Color32(0xf0, 0x8a, 0x24, 255),
            new Color32(0xf2, 0xcf, 0x3a, 255), new Color32(0x4f, 0xa8, 0x4a, 255), new Color32(0x3a, 0x74, 0xd0, 255), new Color32(0x8a, 0x55, 0xc4, 255), new Color32(0x7a, 0x4e, 0x2c, 255),
        };
        FlagTool flagTool = FlagTool.Brush;
        int flagColor, flagBrush = 6;

        // End screen
        class EndScreen
        {
            public string title, text, time, faction;
            public bool won, canSpectate;
            public List<PlayerInfo> players;
            public string winnerId;
            public float shownAt;
        }
        EndScreen end;
        readonly List<(Vector2 pos, float speed, float rot, Color color, float delay)> confetti = new List<(Vector2, float, float, Color, float)>();
        readonly List<Rect> appRects = new List<Rect>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (FindAnyObjectByType<App>() == null) new GameObject("RTS").AddComponent<App>();
        }

        void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            DontDestroyOnLoad(gameObject);
            Application.targetFrameRate = 120;
            Application.runInBackground = true;

            token = PlayerPrefs.GetString("playerToken", "");
            if (token.Length < 16) { token = Guid.NewGuid().ToString(); PlayerPrefs.SetString("playerToken", token); }
            if (AutoTest.Enabled) token = Guid.NewGuid().ToString(); // a fresh player every test run
            playerName = PlayerPrefs.GetString("playerName", $"Jugador{UnityEngine.Random.Range(0, 1000)}");
            // The web build talks to the server that served the page unless the player picked otherwise
            var pageHost = RTS.Net.SocketIO.PageHostName();
            int defaultChoice = !string.IsNullOrEmpty(pageHost) && !pageHost.StartsWith("localhost") ? 1 : 0;
            serverChoice = Mathf.Clamp(PlayerPrefs.GetInt("serverChoice", defaultChoice), 0, Servers.Length - 1);
            server = Servers[serverChoice].host;
            var args = Environment.GetCommandLineArgs();
            int serverArg = Array.IndexOf(args, "-server");
            if (serverArg >= 0 && serverArg + 1 < args.Length) { server = args[serverArg + 1]; serverChoice = -1; }

            flagCanvas = new Texture2D(FlagW, FlagH, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
            ClearFlag();
            var saved = PlayerPrefs.GetString("flagDrawing", "");
            if (saved.Length > 0)
            {
                try { flagCanvas.LoadImage(Convert.FromBase64String(saved)); flagCanvas.filterMode = FilterMode.Point; } catch { ClearFlag(); }
            }

            BuildScene();
            gameObject.AddComponent<Sfx>();
            Settings.Apply();
            Connect();
        }

        // ---------- Scene ----------

        void BuildScene()
        {
            var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
            DontDestroyOnLoad(camGo);
            cam = camGo.AddComponent<Camera>();
            cam.fieldOfView = 35;
            cam.nearClipPlane = 0.3f;
            cam.farClipPlane = 500;
            cam.clearFlags = CameraClearFlags.Skybox;
            cam.transform.SetPositionAndRotation(new Vector3(0, 12, -20), Quaternion.Euler(20, 0, 0));
            var data = camGo.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            Outlines.Attach(cam);

            // Soft, slightly pastel daylight (Hilda-like): a pale sun, cool sky light, gentle shadows
            var sunGo = new GameObject("Sun");
            DontDestroyOnLoad(sunGo);
            var sun = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.96f, 0.9f);
            sun.intensity = 1.25f;
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.7f;
            sunGo.transform.rotation = Quaternion.Euler(38, -40, 0);
            RenderSettings.sun = sun;

            var skyShader = Shader.Find("Skybox/Procedural");
            if (skyShader == null) { cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = new Color(0.55f, 0.7f, 0.9f); }
            var sky = new Material(skyShader != null ? skyShader : Shader.Find("RTS/Unlit"));
            sky.SetFloat("_FogOfWar", 0);
            sky.SetFloat("_SunSize", 0.035f);
            sky.SetFloat("_AtmosphereThickness", 0.85f);
            sky.SetColor("_SkyTint", new Color(0.5f, 0.66f, 0.82f));
            sky.SetColor("_GroundColor", new Color(0.4f, 0.48f, 0.46f));
            sky.SetFloat("_Exposure", 1.2f);
            RenderSettings.skybox = sky;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.68f, 0.76f, 0.86f);
            RenderSettings.ambientEquatorColor = new Color(0.62f, 0.68f, 0.68f);
            RenderSettings.ambientGroundColor = new Color(0.38f, 0.4f, 0.38f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(0.76f, 0.83f, 0.87f);
            RenderSettings.fogStartDistance = 55;
            RenderSettings.fogEndDistance = 140;
            DynamicGI.UpdateEnvironment();

            // Post-processing: neutral tonemapping, a soft bloom on flames and sparks, a light vignette, and
            // a pastel grade that pulls every source of pixel art into one muted palette: less
            // saturation and contrast, blacks lifted toward teal, cool shadows and warm highlights
            var volGo = new GameObject("Post");
            DontDestroyOnLoad(volGo);
            var vol = volGo.AddComponent<Volume>();
            vol.isGlobal = true;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            var tone = profile.Add<Tonemapping>(true);
            tone.mode.Override(TonemappingMode.Neutral);
            var bloom = profile.Add<Bloom>(true);
            bloom.intensity.Override(0.45f);
            bloom.threshold.Override(1.0f);
            bloom.scatter.Override(0.6f);
            var color = profile.Add<ColorAdjustments>(true);
            color.saturation.Override(-14);
            color.postExposure.Override(0.12f);
            color.contrast.Override(-8);
            var lgg = profile.Add<LiftGammaGain>(true);
            lgg.lift.Override(new Vector4(0.98f, 1.01f, 1.04f, 0.05f));
            lgg.gain.Override(new Vector4(1.02f, 1.0f, 0.97f, 0f));
            var split = profile.Add<SplitToning>(true);
            split.shadows.Override(new Color(0.42f, 0.56f, 0.62f));
            split.highlights.Override(new Color(0.8f, 0.75f, 0.66f));
            var vignette = profile.Add<Vignette>(true);
            vignette.intensity.Override(0.22f);
            vol.profile = profile;
        }

        // ---------- Network ----------

        void Connect()
        {
            socket?.Dispose();
            socket = new SocketIO(server, new { token });
            socket.OnConnect += () =>
            {
                lobbyError = "";
                if (reconnecting) reconnectedAt = Time.unscaledTime;
            };
            // A dropped connection mid-game keeps the game on screen with a notice: the socket
            // reconnects by itself and the server sends the game again. Only if it doesn't (the game
            // is gone) do we fall back to the lobby.
            socket.OnDisconnect += () =>
            {
                lobbyError = "Desconectado del servidor. Reconectando…";
                if (game != null) { reconnecting = true; reconnectedAt = -1; return; }
                currentRoom = null;
                if (screen == Screen.Room || screen == Screen.Game) screen = Screen.Lobby;
            };
            socket.On("session", d =>
            {
                myId = (string)d["playerId"];
                if (AutoTest.Enabled && !autoStarted) StartCoroutine(AutoTest.Lobby(() => socket.Emit("room:create", new { roomName = "autotest", playerName = "Unity", flag = ExportFlag() })));
            });
            socket.On("lobby:rooms", d => rooms = ((JArray)d).Select(RoomSummary.Parse).ToList());
            socket.On("lobby:error", d =>
            {
                if (currentRoom != null) roomError = (string)d["message"];
                else lobbyError = (string)d["message"];
            });
            socket.On("room:update", d =>
            {
                currentRoom = RoomDetails.Parse(d);
                lobbyError = "";
                if (AutoTest.Enabled && !autoStarted && currentRoom.hostId == myId && currentRoom.status == "waiting")
                {
                    autoStarted = true;
                    socket.Emit("room:start");
                }
                if (currentRoom.status == "waiting") screen = Screen.Room;
            });
            socket.On("room:left", _ =>
            {
                currentRoom = null;
                end = null;
                LeaveGame();
                screen = Screen.Lobby;
            });
            socket.On("game:start", d =>
            {
                end = null;
                LeaveGame();
                if (backdrop != null) { Destroy(backdrop.gameObject); backdrop = null; }
                reconnecting = false;
                screen = Screen.Game;
                Sfx.Play("start");
                Sfx.StartAmbient();
                game = GameView.Create(socket, myId, d, cam);
                if (AutoTest.Enabled) StartCoroutine(AutoTest.Run(game));
            });
            socket.OnState = d => game?.ApplyState(d);
            socket.On("game:resources", d => game?.ApplyResourceChanges(d));
            socket.On("game:shots", d => game?.AddShots(d));
            socket.On("game:ageup", d => game?.OnAgeUp((string)d["playerId"], (int)d["age"]));
            socket.On("game:error", d => game?.ShowMessage((string)d["message"]));
            socket.On("game:notice", d => game?.ShowMessage((string)d["message"], true));
            socket.On("game:defeated", _ => ShowEnd(new EndScreen
            {
                title = "DERROTA", text = "Todos tus Centros urbanos fueron destruidos.", won = false, canSpectate = true,
            }));
            socket.On("game:over", d =>
            {
                var winnerId = (string)d["winnerId"];
                var winnerName = (string)d["winnerName"];
                var reason = (string)d["reason"];
                var winnerIds = (d["winnerIds"] as JArray)?.Select(w => (string)w).ToList();
                bool won = winnerId != null && (winnerId == myId || winnerIds != null && winnerIds.Contains(myId));
                bool teamWon = winnerIds != null && winnerIds.Count > 1;
                var text = winnerName != null ? $"¡{(won ? (teamWon ? "Tu equipo" : "Tu reino") : winnerName)} {(won && teamWon ? reason.Replace("destruyeron", "destruyó") : reason)}!" : $"Sin ganador: {reason}.";
                float duration = (float?)d["duration"] ?? 0;
                ShowEnd(new EndScreen
                {
                    title = won ? "¡VICTORIA!" : winnerName != null ? "FIN DE LA PARTIDA" : "EMPATE",
                    text = text, won = won, faction = (string)d["winnerFaction"], canSpectate = false,
                    time = duration > 0 ? $"Duración de la partida: {Defs.FormatTime(duration)}" : "",
                    players = ((JArray)d["players"]).Select(PlayerInfo.Parse).ToList(), winnerId = winnerId,
                });
            });
            socket.Start();
        }

        void LeaveGame()
        {
            Sfx.StopAmbient();
            if (game != null) Destroy(game.gameObject);
            game = null;
        }

        void ShowEnd(EndScreen e)
        {
            e.shownAt = Time.unscaledTime;
            end = e;
            Sfx.Play(e.won ? "victory" : "defeat");
            confetti.Clear();
            if (!e.won) return;
            var colors = new[] { 0xffd34d, 0xfff3c4, 0xf0a030, 0x3b82f6, 0xe74c3c, 0xffffff };
            for (int i = 0; i < 120; i++)
                confetti.Add((new Vector2(UnityEngine.Random.value, -0.05f), 0.18f + UnityEngine.Random.value * 0.2f, UnityEngine.Random.value * 360,
                    GameAssets.Hex(colors[UnityEngine.Random.Range(0, colors.Length)]), UnityEngine.Random.value * 2));
        }

        void Update()
        {
            socket?.Pump();
            if (Input.GetKeyDown(KeyCode.M) && GUIUtility.keyboardControl == 0) Sfx.Muted = !Sfx.Muted;
            Skin.Scale = Mathf.Max(1, UnityEngine.Screen.height / 900f);
            // Reconnected but the server didn't send our game back within a few seconds: it's over
            if (reconnecting && reconnectedAt > 0 && Time.unscaledTime - reconnectedAt > 4)
            {
                reconnecting = false;
                currentRoom = null;
                LeaveGame();
                screen = Screen.Lobby;
                lobbyError = "La partida ya no está disponible";
            }
            // Outside a game the menus show two villages at war behind them
            if (game == null && backdrop == null) { backdrop = MenuBackdrop.Create(cam); Sfx.StartAmbient(); }
            fpsSmooth = Mathf.Lerp(fpsSmooth, 1 / Mathf.Max(0.0001f, Time.unscaledDeltaTime), 0.05f);
        }

        void OnDestroy()
        {
            socket?.Dispose();
        }

        void OnApplicationQuit() => socket?.Dispose();

        public bool PointerOverAppUI(Vector2 guiPoint) => end != null || appRects.Any(r => r.Contains(guiPoint));

        // ---------- UI ----------

        void OnGUI()
        {
            Skin.Ensure();
            float k = Skin.Scale;
            GUI.matrix = Matrix4x4.Scale(new Vector3(k, k, 1));
            float W = UnityEngine.Screen.width / k, H = UnityEngine.Screen.height / k;
            GUI.depth = -10; // over the game HUD
            if (Event.current.type == EventType.Layout) appRects.Clear();

            if (screen == Screen.Menu) DrawMainMenu(W, H);
            else if (screen == Screen.Options) DrawOptions(W, H);
            else if (screen == Screen.Help) DrawHelp(W, H);
            else if (screen == Screen.Lobby) DrawLobby(W, H);
            else if (screen == Screen.Room) DrawRoom(W, H);
            if (end != null) DrawEnd(W, H);
            if (reconnecting && game != null)
            {
                var rr = new Rect(W / 2 - 200, 70, 400, 44);
                GUI.Box(rr, "Conexión perdida · reconectando…", new GUIStyle(Skin.Ribbon("red", 50)) { fontSize = 18 });
            }
            if (Settings.ShowFps) GUI.Label(new Rect(8, H - 26, 120, 22), $"{Mathf.RoundToInt(fpsSmooth)} FPS", Skin.Small);

            // Sound toggle (M)
            var muteRect = new Rect(W - 54, H - 54, 44, 44);
            appRects.Add(muteRect);
            if (GUI.Button(muteRect, Sfx.Muted ? "×♪" : "♪", Skin.Button)) Sfx.Muted = !Sfx.Muted;
        }

        // ---------- Main menu ----------

        const string GameTitle = "Age of Elemental Wars";
        static readonly (string id, string name)[] MapThemes = { ("classic", "Valle clásico"), ("spirit", "Dimensión de los espíritus") };
        static string MapName(string id) { foreach (var (i, n) in MapThemes) if (i == id) return n; return id; }

        void DrawMainMenu(float W, float H)
        {
            // Title over the scene, buttons in a column on the left like a classic RTS menu
            var title = new GUIStyle(Skin.Title) { fontSize = 54, alignment = TextAnchor.MiddleLeft };
            float x = Mathf.Max(40, W * 0.08f), y = H * 0.2f;
            Shadowed(new Rect(x, y, W - x, 70), GameTitle, title);
            Shadowed(new Rect(x + 4, y + 64, W - x, 30), "Estrategia en tiempo real · aire, fuego, tierra y agua", new GUIStyle(Skin.Label) { fontSize = 18 });
            y += 130;
            float bw = 300, bh = 54;
            bool connected = socket != null && socket.Connected;
            if (MenuButton(new Rect(x, y, bw, bh), "Jugar", true)) screen = Screen.Lobby;
            y += bh + 12;
            if (MenuButton(new Rect(x, y, bw, bh), "Opciones", false)) screen = Screen.Options;
            y += bh + 12;
            if (MenuButton(new Rect(x, y, bw, bh), "Cómo jugar", false)) screen = Screen.Help;
#if !UNITY_WEBGL
            y += bh + 12;
            if (MenuButton(new Rect(x, y, bw, bh), "Salir", false, true)) Application.Quit();
#endif
            var status = connected ? $"Conectado · servidor {ServerName.ToLower()} · {rooms.Count} sala{(rooms.Count == 1 ? "" : "s")}" : $"Conectando con el servidor {ServerName.ToLower()}…";
            Shadowed(new Rect(x, H - 40, W - x, 24), status, Skin.Small);
        }

        bool MenuButton(Rect r, string text, bool primary, bool danger = false)
        {
            appRects.Add(r);
            var style = new GUIStyle(danger ? Skin.RedButton : Skin.Button) { fontSize = primary ? 24 : 20 };
            bool hit = GUI.Button(r, text, style);
            if (hit) Sfx.Play("click");
            return hit;
        }

        static void Shadowed(Rect r, string text, GUIStyle style)
        {
            var old = style.normal.textColor;
            style.normal.textColor = new Color(0, 0, 0, 0.55f);
            GUI.Label(new Rect(r.x + 2, r.y + 2, r.width, r.height), text, style);
            style.normal.textColor = old;
            GUI.Label(r, text, style);
        }

        bool BackButton(Rect panel)
        {
            var r = new Rect(panel.x + 14, panel.y + 14, 96, 34);
            appRects.Add(r);
            if (!GUI.Button(r, "← Volver", new GUIStyle(Skin.Button) { fontSize = 14 })) return false;
            Sfx.Play("click");
            return true;
        }

        void DrawOptions(float W, float H)
        {
            float w = 600, h = Mathf.Min(H - 40, 690);
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            appRects.Add(panel);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            GUI.Label(new Rect(panel.x + 120, panel.y - 18, w - 240, 64), "Opciones", Skin.Ribbon("blue"));
            if (BackButton(panel)) screen = Screen.Menu;
            optionsScroll = GUI.BeginScrollView(new Rect(panel.x + 30, panel.y + 60, w - 50, h - 80), optionsScroll, new Rect(0, 0, w - 80, optionsHeight));
            optionsHeight = OptionsPanel.Draw(new Rect(0, 0, w - 80, 2000));
            GUI.EndScrollView();
        }
        Vector2 optionsScroll;
        float optionsHeight = 600;

        static readonly (string keys, string what)[] Controls =
        {
            ("Clic izquierdo", "Seleccionar (arrastra para seleccionar en grupo)"),
            ("Doble clic", "Todas las unidades o edificios de ese tipo en pantalla"),
            ("Clic derecho", "Mover, recolectar, construir o atacar"),
            ("Shift + clic derecho", "Encadenar órdenes"),
            ("Ctrl/Cmd + 1-9 · 1-9", "Guardar / elegir un grupo (doble pulsación: centrar)"),
            ("Z X C V B N F G J K", "Botones de la barra de comandos"),
            ("H · .", "Centro urbano · aldeano desocupado"),
            ("WASD / flechas · rueda", "Mover la cámara · zoom"),
            ("Q / E · botón central", "Girar la cámara · arrastrar"),
            ("Esc · M", "Menú y opciones · silenciar"),
        };

        void DrawHelp(float W, float H)
        {
            float w = 680, h = Mathf.Min(H - 40, 640);
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            appRects.Add(panel);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            GUI.Label(new Rect(panel.x + 120, panel.y - 18, w - 240, 64), "Cómo jugar", Skin.Ribbon("blue"));
            if (BackButton(panel)) screen = Screen.Menu;
            float x = panel.x + 40, y = panel.y + 66, cw = w - 80;
            var wrap = new GUIStyle(Skin.LabelDark) { wordWrap = true, fontSize = 15 };
            GUI.Label(new Rect(x, y, cw, 90), "Recolecta comida, madera, oro y piedra con tus aldeanos, construye casas para crecer y cuarteles para entrenar tu ejército. Avanza de edad en el Centro urbano para desbloquear edificios y unidades. Gana destruyendo los Centros urbanos rivales o dominando la Fortaleza central.", wrap);
            y += 100;
            GUI.Label(new Rect(x, y, cw, 26), "Controles", new GUIStyle(Skin.TitleDark) { fontSize = 18, alignment = TextAnchor.MiddleLeft });
            y += 32;
            foreach (var (keys, what) in Controls)
            {
                GUI.Label(new Rect(x, y, 230, 24), keys, new GUIStyle(Skin.LabelDark) { fontStyle = FontStyle.Bold });
                GUI.Label(new Rect(x + 240, y, cw - 240, 24), what, Skin.SmallDark);
                y += 28;
            }
        }

        void DrawLobby(float W, float H)
        {
            float w = 560, h = Mathf.Min(H - 40, 700);
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            appRects.Add(panel);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            if (BackButton(panel)) { screen = Screen.Menu; return; }
            GUI.Label(new Rect(panel.x + 120, panel.y - 18, w - 240, 64), "Jugar", Skin.Ribbon("blue"));
            float x = panel.x + 34, y = panel.y + 60, cw = w - 68;

            GUI.Label(new Rect(x, y, 120, 30), "Tu nombre", Skin.LabelDark);
            var newName = GUI.TextField(new Rect(x + 120, y, cw - 120, 30), playerName, 20, Skin.Field);
            if (newName != playerName) { playerName = newName; PlayerPrefs.SetString("playerName", playerName); }
            y += 40;

            GUI.Label(new Rect(x, y, 120, 30), "Servidor", Skin.LabelDark);
            var serverRect = new Rect(x + 120, y, cw - 250, 30);
            if (GUI.Button(serverRect, $"{ServerName}  {(serverMenuOpen ? "▲" : "▼")}", Skin.Field)) serverMenuOpen = !serverMenuOpen;
            if (GUI.Button(new Rect(x + cw - 120, y - 2, 120, 36), socket != null && socket.Connected ? "Reconectar" : "Conectar", Skin.Button))
            {
                serverMenuOpen = false;
                Connect();
            }
            y += 44;

            // Flag editor
            GUI.Label(new Rect(x, y, cw, 24), "Dibuja tu bandera", Skin.LabelDark);
            GUI.Label(new Rect(x + 170, y + 2, cw - 170, 24), "(el negro se pinta con tu color al jugar)", Skin.SmallDark);
            y += 26;
            var flagRect = new Rect(x, y, FlagW * FlagZoom * 0.75f, FlagH * FlagZoom * 0.75f);
            Skin.Rect(new Rect(flagRect.x - 3, flagRect.y - 3, flagRect.width + 6, flagRect.height + 6), new Color(0.24f, 0.16f, 0.08f));
            Skin.Rect(flagRect, Color.white);
            GUI.DrawTexture(flagRect, flagCanvas);
            if (!serverMenuOpen) HandleFlagInput(flagRect);
            float toolsH = DrawFlagTools(new Rect(flagRect.xMax + 14, flagRect.y - 4, cw - flagRect.width - 14, 180));
            y += Mathf.Max(flagRect.height, toolsH) + 14;

            roomName = GUI.TextField(new Rect(x, y + 3, cw - 160, 32), roomName, 30, Skin.Field);
            if (string.IsNullOrEmpty(roomName)) GUI.Label(new Rect(x + 10, y + 7, 200, 24), "Nombre de la sala", Skin.SmallDark);
            GUI.enabled = socket != null && socket.Connected;
            if (GUI.Button(new Rect(x + cw - 150, y, 150, 40), "Crear sala", Skin.Button))
            {
                socket.Emit("room:create", new { roomName, playerName = playerName.Trim(), flag = ExportFlag() });
                roomName = "";
            }
            GUI.enabled = true;
            y += 50;

            GUI.Label(new Rect(x, y, cw, 30), "Salas", new GUIStyle(Skin.TitleDark) { fontSize = 20, alignment = TextAnchor.MiddleLeft });
            y += 32;
            float listH = panel.yMax - y - 50;
            var listRect = new Rect(x, y, cw, listH);
            if (rooms.Count == 0) GUI.Label(new Rect(x, y, cw, 30), "Aún no hay salas — ¡crea una!", Skin.SmallDark);
            else
            {
                roomScroll = GUI.BeginScrollView(listRect, roomScroll, new Rect(0, 0, cw - 20, rooms.Count * 46));
                for (int i = 0; i < rooms.Count; i++)
                {
                    var room = rooms[i];
                    var status = room.status == "playing" ? "(en partida)" : room.status == "finished" ? "(terminada)" : "";
                    GUI.Label(new Rect(0, i * 46 + 8, cw - 150, 30), $"{room.name} — {room.players}/{room.max} {status}{(room.central ? "" : " · sin castillo")}{(room.map == "classic" ? "" : $" · {MapName(room.map)}")}", Skin.LabelDark);
                    GUI.enabled = room.status == "waiting" && room.players < room.max;
                    if (GUI.Button(new Rect(cw - 140, i * 46, 116, 40), "Unirse", Skin.Button))
                        socket.Emit("room:join", new { roomId = room.id, playerName = playerName.Trim(), flag = ExportFlag() });
                    GUI.enabled = true;
                }
                GUI.EndScrollView();
            }
            var errStyle = new GUIStyle(Skin.LabelDark);
            errStyle.normal.textColor = new Color(0.75f, 0.15f, 0.1f);
            GUI.Label(new Rect(x, panel.yMax - 48, cw, 30), socket != null && !socket.Connected && lobbyError == "" ? $"Conectando con el servidor {ServerName.ToLower()}…" : lobbyError, errStyle);
            DrawServerMenu(serverRect);
        }

        // The server dropdown's list, drawn last so it sits over the rest of the lobby; picking one
        // remembers it and connects straight away
        void DrawServerMenu(Rect field)
        {
            if (!serverMenuOpen) return;
            for (int i = 0; i < Servers.Length; i++)
            {
                var r = new Rect(field.x, field.yMax + 2 + i * 32, field.width, 30);
                Skin.Rect(r, i == serverChoice ? new Color(0.98f, 0.9f, 0.7f) : new Color(1f, 0.97f, 0.9f));
                if (GUI.Button(r, (i == serverChoice ? "✓ " : "   ") + Servers[i].name, Skin.LabelDark))
                {
                    serverMenuOpen = false;
                    if (i == serverChoice) continue;
                    serverChoice = i;
                    server = Servers[i].host;
                    PlayerPrefs.SetInt("serverChoice", i);
                    Connect();
                }
            }
            // A click anywhere else closes it
            if (Event.current.type == EventType.MouseDown) serverMenuOpen = false;
        }

        void DrawRoom(float W, float H)
        {
            if (currentRoom == null) return;
            float w = 760, h = Mathf.Min(H - 30, 700);
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            appRects.Add(panel);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            GUI.Label(new Rect(panel.x + 80, panel.y - 18, w - 160, 64), currentRoom.name, Skin.Ribbon("blue"));
            float x = panel.x + 34, y = panel.y + 58, cw = w - 68;
            bool isHost = currentRoom.hostId == myId;
            GUI.Label(new Rect(x, y, cw - 120, 26), isHost ? "Eres el anfitrión: organiza los equipos e inicia la partida cuando estén todos." : "Esperando a que el anfitrión inicie la partida…", Skin.LabelDark);
            GUI.Label(new Rect(x + cw - 110, y, 110, 26), $"{currentRoom.playerList.Count}/{C.Factions.Length} jugadores", new GUIStyle(Skin.SmallDark) { alignment = TextAnchor.MiddleRight });
            y += 34;
            // Column heads
            GUI.Label(new Rect(x + 24, y, 190, 22), "Jugador", Skin.SmallDark);
            GUI.Label(new Rect(x + 220, y, 320, 22), "Civilización", Skin.SmallDark);
            GUI.Label(new Rect(x + cw - 230, y, 230, 22), "Equipo", Skin.SmallDark);
            y += 24;
            // Player list scrolls when the room is too full for the panel (up to 10 players)
            const float Row = 38;
            float listBottom = panel.yMax - 112 - 64 - 44 - (isHost ? 46 : 0);
            float contentH = currentRoom.playerList.Count * Row + 46;
            var listRect = new Rect(x - 8, y, cw + 16, Mathf.Max(80, listBottom - y));
            bool scrolls = contentH > listRect.height;
            roomPlayersScroll = GUI.BeginScrollView(listRect, roomPlayersScroll, new Rect(0, 0, cw + (scrolls ? 0 : 16), contentH));
            float ox = x;
            x = 8; y = 4;
            if (scrolls) cw -= 16;
            foreach (var p in currentRoom.playerList)
            {
                bool me = p.id == myId;
                if (me) Skin.Rect(new Rect(x - 8, y - 3, cw + 16, Row + 44), new Color(1, 0.95f, 0.75f, 0.45f));
                Skin.Rect(new Rect(x, y + 9, 16, 16), GameAssets.Hex(p.color));
                GUI.Label(new Rect(x + 24, y + 2, 190, 30), $"{(p.id == currentRoom.hostId ? "★ " : "")}{p.name}{(me ? " (tú)" : "")}", Skin.LabelDark);
                // Civilization: my own is a picker, everyone else's is shown as text
                if (me)
                {
                    for (int i = 0; i < C.Civilizations.Length; i++)
                    {
                        var (id, name) = C.Civilizations[i];
                        bool on = p.civ == id;
                        if (GUI.Toggle(new Rect(x + 220 + i * 70, y, 66, 34), on, name, new GUIStyle(Skin.Button) { fontSize = 13 }) && !on) socket.Emit("room:civ", id);
                    }
                }
                else GUI.Label(new Rect(x + 220, y + 4, 200, 30), C.Civilizations.FirstOrDefault(c => c.id == p.civ).name ?? "", Skin.SmallDark);
                // Team: anyone sets their own, the host sets everybody's (AoE style: — = alone)
                float tx = x + cw - 230;
                if (me || isHost)
                {
                    for (int t = 0; t <= 4; t++)
                    {
                        bool on = p.team == t;
                        if (GUI.Toggle(new Rect(tx + t * 46, y, 42, 34), on, t == 0 ? "—" : t.ToString(), Skin.Button) && !on)
                        {
                            Sfx.Play("click");
                            if (me) socket.Emit("room:team", t);
                            else socket.Emit("room:team", new { playerId = p.id, team = t });
                        }
                    }
                }
                else GUI.Label(new Rect(tx, y + 4, 230, 30), TeamName(p.team), Skin.SmallDark);
                y += Row;
                if (me) { DrawColorPicker(x + 24, y, p); y += 44; }
            }
            GUI.EndScrollView();
            x = ox; cw = w - 68;
            y = listRect.yMax + 6;
            if (isHost)
            {
                GUI.Label(new Rect(x, y + 8, 150, 26), "Repartir equipos:", Skin.SmallDark);
                var small = new GUIStyle(Skin.Button) { fontSize = 13 };
                if (GUI.Button(new Rect(x + 140, y, 120, 34), "2 equipos", small)) socket.Emit("room:autoteams", 2);
                if (currentRoom.playerList.Count >= 3 && GUI.Button(new Rect(x + 266, y, 120, 34), "3 equipos", small)) socket.Emit("room:autoteams", 3);
                if (currentRoom.playerList.Count >= 4 && GUI.Button(new Rect(x + 392, y, 120, 34), "4 equipos", small)) socket.Emit("room:autoteams", 4);
                if (GUI.Button(new Rect(x + 518, y, 160, 34), "Todos contra todos", small)) socket.Emit("room:autoteams", 0);
                y += 46;
            }
            GUI.enabled = isHost;
            bool central = GUI.Toggle(new Rect(x, y, cw, 30), currentRoom.central, " Fortaleza central", Skin.Toggle);
            if (central != currentRoom.central) socket.Emit("room:settings", new { central });
            GUI.enabled = true;
            GUI.Label(new Rect(x + 22, y + 24, cw - 22, 36), "Se gana dominándola; sin ella solo se gana destruyendo a los rivales", Skin.SmallDark);
            // The map's look: only the host picks it, everyone sees the choice
            y += 62;
            GUI.Label(new Rect(x, y + 7, 70, 26), "Mapa:", Skin.LabelDark);
            var mapStyle = new GUIStyle(Skin.Button) { fontSize = 14 };
            for (int i = 0; i < MapThemes.Length; i++)
            {
                var (id, label) = MapThemes[i];
                bool on = currentRoom.map == id;
                GUI.enabled = isHost || on;
                if (GUI.Toggle(new Rect(x + 74 + i * 236, y, 228, 36), on, label, mapStyle) && !on && isHost)
                {
                    Sfx.Play("click");
                    socket.Emit("room:settings", new { map = id });
                }
            }
            GUI.enabled = true;
            y = panel.yMax - 112;
            if (isHost && GUI.Button(new Rect(x, y, 220, 48), "Iniciar partida", new GUIStyle(Skin.Button) { fontSize = 20 })) { Sfx.Play("click"); socket.Emit("room:start"); }
            if (GUI.Button(new Rect(x + cw - 200, y, 200, 48), "Salir de la sala", Skin.RedButton)) { Sfx.Play("click"); socket.Emit("room:leave"); }
            var errStyle = new GUIStyle(Skin.LabelDark);
            errStyle.normal.textColor = new Color(0.75f, 0.15f, 0.1f);
            GUI.Label(new Rect(x, panel.yMax - 54, cw, 30), roomError, errStyle);
        }

        Vector2 roomPlayersScroll;

        static string TeamName(int team) => team == 0 ? "sin equipo" : $"equipo {team}";

        // My colour; colours other players already use are crossed out and can't be picked
        void DrawColorPicker(float x, float y, PlayerInfo me)
        {
            GUI.Label(new Rect(x, y + 6, 60, 26), "Color", Skin.SmallDark);
            for (int i = 0; i < C.Factions.Length; i++)
            {
                var (id, color) = C.Factions[i];
                var r = new Rect(x + 56 + i * 40, y + 2, 32, 30);
                bool mine = me.faction == id;
                bool taken = !mine && currentRoom.playerList.Any(o => o.faction == id);
                Skin.Rect(new Rect(r.x - 3, r.y - 3, r.width + 6, r.height + 6), mine ? new Color(0.24f, 0.16f, 0.08f) : new Color(0, 0, 0, 0));
                Skin.Rect(r, GameAssets.Hex(color, taken ? 0.3f : 1));
                if (taken) GUI.Label(r, "×", new GUIStyle(Skin.LabelDark) { alignment = TextAnchor.MiddleCenter });
                else if (!mine && GUI.Button(r, GUIContent.none, GUIStyle.none)) { Sfx.Play("click"); socket.Emit("room:color", id); }
            }
        }

        void DrawEnd(float W, float H)
        {
            float t = Time.unscaledTime - end.shownAt;
            Skin.Rect(new Rect(0, 0, W, H), new Color(0, 0, 0, Mathf.Min(0.6f, t * 1.5f)));
            // Confetti on a win
            foreach (var c in confetti)
            {
                float ct = t - c.delay;
                if (ct < 0) continue;
                float yy = (c.pos.y + ct * c.speed) % 1.1f;
                var m = GUI.matrix;
                var p = new Vector2(c.pos.x * W + Mathf.Sin(ct * 3 + c.rot) * 20, yy * H);
                GUIUtility.RotateAroundPivot(c.rot + ct * 180, p * Skin.Scale);
                Skin.Rect(new Rect(p.x - 4, p.y - 2, 8, 4), c.color);
                GUI.matrix = m;
            }
            var color = end.faction ?? (end.won ? "yellow" : "black");
            float scale = Mathf.Min(1, t * 3);
            float cx = W / 2, top = H / 2 - 230;
            var sword = GameAssets.UI($"sword_{color}");
            GUI.DrawTexture(new Rect(cx - 220, top, 220 * scale, 88 * scale), sword, ScaleMode.ScaleToFit);
            var mm = GUI.matrix;
            GUIUtility.ScaleAroundPivot(new Vector2(-1, 1), new Vector2(cx, top) * Skin.Scale);
            GUI.DrawTexture(new Rect(cx - 220, top, 220 * scale, 88 * scale), sword, ScaleMode.ScaleToFit);
            GUI.matrix = mm;
            GUI.Label(new Rect(cx - 260, top + 70, 520, 80), end.title, new GUIStyle(Skin.Ribbon(end.won ? "yellow" : color, 90)) { fontSize = 34 });
            var panel = new Rect(cx - 280, top + 160, 560, 300);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            float y = panel.y + 26;
            GUI.Label(new Rect(panel.x + 30, y, 500, 50), end.text, new GUIStyle(Skin.LabelDark) { alignment = TextAnchor.UpperCenter, fontSize = 17 });
            y += 46;
            if (!string.IsNullOrEmpty(end.time)) GUI.Label(new Rect(panel.x + 30, y, 500, 24), end.time, new GUIStyle(Skin.SmallDark) { alignment = TextAnchor.UpperCenter });
            y += 28;
            if (end.players != null)
            {
                string[] heads = { "Jugador", "Entrenadas", "Bajas", "Perdidas", "Recolectado" };
                float[] cols = { 0, 170, 270, 340, 420 };
                for (int i = 0; i < heads.Length; i++) GUI.Label(new Rect(panel.x + 30 + cols[i], y, 120, 22), heads[i], Skin.SmallDark);
                y += 22;
                foreach (var p in end.players)
                {
                    Skin.Rect(new Rect(panel.x + 30, y + 5, 12, 12), GameAssets.Hex(p.color));
                    var style = p.id == end.winnerId ? Skin.LabelDark : Skin.SmallDark;
                    GUI.Label(new Rect(panel.x + 48, y, 150, 22), (p.id == end.winnerId ? "★ " : "") + p.name, style);
                    var vals = new[] { p.trained, p.kills, p.lost, p.gathered };
                    for (int i = 0; i < 4; i++) GUI.Label(new Rect(panel.x + 30 + cols[i + 1], y, 80, 22), vals[i].ToString(), style);
                    y += 22;
                }
            }
            float by = panel.yMax - 66;
            if (end.canSpectate && GUI.Button(new Rect(panel.x + 40, by, 220, 44), "Seguir mirando", Skin.Button)) end = null;
            if (end != null && GUI.Button(new Rect(panel.xMax - 260, by, 220, 44), "Volver al lobby", Skin.RedButton))
            {
                socket.Emit("room:leave");
                end = null;
            }
        }

        // ---------- Flag editor ----------

        void ClearFlag()
        {
            var px = new Color32[FlagW * FlagH];
            flagCanvas.SetPixels32(px);
            flagCanvas.Apply();
        }

        // Tools, palette, brush size, undo and clear beside the canvas; returns the height used
        float DrawFlagTools(Rect r)
        {
            var small = new GUIStyle(Skin.Button) { fontSize = 12 };
            float bw = Mathf.Floor((r.width - 9) / 4), y = r.y;
            for (int i = 0; i < FlagTools.Length; i++)
            {
                var (tool, label) = FlagTools[i];
                var br = new Rect(r.x + (i % 4) * (bw + 3), y + (i / 4) * 32, bw, 30);
                if (GUI.Toggle(br, flagTool == tool, label, small) && flagTool != tool) flagTool = tool;
            }
            // Brush size, in the free slot of the second row
            var sizeRect = new Rect(r.x + 3 * (bw + 3), y + 32, bw, 30);
            if (GUI.Button(sizeRect, flagBrush <= 3 ? "Fino" : flagBrush <= 6 ? "Medio" : "Grueso", small)) flagBrush = flagBrush <= 3 ? 6 : flagBrush <= 6 ? 10 : 3;
            y += 70;
            float sw = Mathf.Floor((r.width - 4 * 4) / 5);
            for (int i = 0; i < FlagPalette.Length; i++)
            {
                var sr = new Rect(r.x + (i % 5) * (sw + 4), y + (i / 5) * 30, sw, 26);
                Skin.Rect(new Rect(sr.x - 2, sr.y - 2, sr.width + 4, sr.height + 4), i == flagColor ? new Color(0.24f, 0.16f, 0.08f) : new Color(0.24f, 0.16f, 0.08f, 0.25f));
                Skin.Rect(sr, FlagPalette[i]);
                if (i == 0) GUI.Label(sr, "tu color", new GUIStyle(Skin.Small) { alignment = TextAnchor.MiddleCenter, fontSize = 10 });
                if (GUI.Button(sr, GUIContent.none, GUIStyle.none)) { flagColor = i; if (flagTool == FlagTool.Eraser) flagTool = FlagTool.Brush; }
            }
            y += 64;
            GUI.enabled = undoPixels != null;
            if (GUI.Button(new Rect(r.x, y, r.width / 2 - 3, 32), "Deshacer", small)) { flagCanvas.SetPixels32(undoPixels); flagCanvas.Apply(); undoPixels = null; SaveFlag(); }
            GUI.enabled = true;
            if (GUI.Button(new Rect(r.x + r.width / 2 + 3, y, r.width / 2 - 3, 32), "Borrar todo", new GUIStyle(Skin.RedButton) { fontSize = 12 }))
            {
                undoPixels = flagCanvas.GetPixels32();
                ClearFlag();
                PlayerPrefs.DeleteKey("flagDrawing");
            }
            return y + 34 - r.y;
        }

        void SaveFlag() => PlayerPrefs.SetString("flagDrawing", Convert.ToBase64String(flagCanvas.EncodeToPNG()));

        Color32 InkColor => flagTool == FlagTool.Eraser ? new Color32(0, 0, 0, 0) : FlagPalette[flagColor];

        void HandleFlagInput(Rect r)
        {
            var e = Event.current;
            if (e.button != 0) return;
            Vector2 ToCanvas(Vector2 m) => new Vector2((m.x - r.x) / r.width * FlagW, (1 - (m.y - r.y) / r.height) * FlagH);
            bool freehand = flagTool == FlagTool.Brush || flagTool == FlagTool.Eraser;
            if (e.type == EventType.MouseDown && r.Contains(e.mousePosition))
            {
                var p = ToCanvas(e.mousePosition);
                beforeStroke = flagCanvas.GetPixels32();
                undoPixels = beforeStroke;
                if (flagTool == FlagTool.Fill) { FloodFill(Mathf.FloorToInt(p.x), Mathf.FloorToInt(p.y), InkColor); flagCanvas.Apply(); SaveFlag(); e.Use(); return; }
                if (freehand) Stamp(p);
                lastFlagPoint = p;
                shapeStart = p;
                flagCanvas.Apply();
                e.Use();
            }
            else if (e.type == EventType.MouseDrag && lastFlagPoint != null)
            {
                var p = ToCanvas(e.mousePosition);
                if (freehand)
                {
                    var a = lastFlagPoint.Value;
                    int steps = Mathf.CeilToInt(Vector2.Distance(a, p));
                    for (int i = 0; i <= steps; i++) Stamp(Vector2.Lerp(a, p, i / (float)Mathf.Max(1, steps)));
                }
                else
                {
                    // Shapes are previewed live: redrawn over the canvas as it was when the drag began
                    flagCanvas.SetPixels32(beforeStroke);
                    DrawShape(shapeStart.Value, p);
                }
                lastFlagPoint = p;
                flagCanvas.Apply();
                e.Use();
            }
            else if (e.type == EventType.MouseUp && lastFlagPoint != null)
            {
                lastFlagPoint = null;
                shapeStart = null;
                SaveFlag();
                e.Use();
            }
        }

        void Plot(int x, int y, Color32 c)
        {
            if (x >= 0 && y >= 0 && x < FlagW && y < FlagH) flagCanvas.SetPixel(x, y, c);
        }

        void Stamp(Vector2 c)
        {
            float rad = flagBrush / 2f;
            var ink = InkColor;
            for (int y = Mathf.FloorToInt(c.y - rad); y <= Mathf.CeilToInt(c.y + rad); y++)
                for (int x = Mathf.FloorToInt(c.x - rad); x <= Mathf.CeilToInt(c.x + rad); x++)
                    if ((x + 0.5f - c.x) * (x + 0.5f - c.x) + (y + 0.5f - c.y) * (y + 0.5f - c.y) <= rad * rad) Plot(x, y, ink);
        }

        // Filled shapes spanning the drag (a line is stroked with the brush)
        void DrawShape(Vector2 a, Vector2 b)
        {
            var ink = InkColor;
            float x0 = Mathf.Min(a.x, b.x), x1 = Mathf.Max(a.x, b.x), y0 = Mathf.Min(a.y, b.y), y1 = Mathf.Max(a.y, b.y);
            switch (flagTool)
            {
                case FlagTool.Line:
                    int steps = Mathf.CeilToInt(Vector2.Distance(a, b));
                    for (int i = 0; i <= steps; i++) Stamp(Vector2.Lerp(a, b, i / (float)Mathf.Max(1, steps)));
                    break;
                case FlagTool.Rect:
                    for (int y = Mathf.RoundToInt(y0); y <= Mathf.RoundToInt(y1); y++)
                        for (int x = Mathf.RoundToInt(x0); x <= Mathf.RoundToInt(x1); x++) Plot(x, y, ink);
                    break;
                case FlagTool.Circle:
                {
                    var c = new Vector2((x0 + x1) / 2, (y0 + y1) / 2);
                    float rx = Mathf.Max(0.5f, (x1 - x0) / 2), ry = Mathf.Max(0.5f, (y1 - y0) / 2);
                    for (int y = Mathf.FloorToInt(y0); y <= Mathf.CeilToInt(y1); y++)
                        for (int x = Mathf.FloorToInt(x0); x <= Mathf.CeilToInt(x1); x++)
                        {
                            float dx = (x + 0.5f - c.x) / rx, dy = (y + 0.5f - c.y) / ry;
                            if (dx * dx + dy * dy <= 1) Plot(x, y, ink);
                        }
                    break;
                }
                case FlagTool.Triangle:
                {
                    // Point at the top of the dragged box (canvas y grows upward), base along the bottom
                    float h = Mathf.Max(1, y1 - y0), cx = (x0 + x1) / 2;
                    for (int y = Mathf.FloorToInt(y0); y <= Mathf.CeilToInt(y1); y++)
                    {
                        float half = (x1 - x0) / 2 * (1 - (y + 0.5f - y0) / h);
                        for (int x = Mathf.FloorToInt(cx - half); x <= Mathf.CeilToInt(cx + half); x++)
                            if (Mathf.Abs(x + 0.5f - cx) <= half + 0.01f) Plot(x, y, ink);
                    }
                    break;
                }
            }
        }

        // Paint bucket over the area of the same colour
        void FloodFill(int sx, int sy, Color32 ink)
        {
            if (sx < 0 || sy < 0 || sx >= FlagW || sy >= FlagH) return;
            var px = flagCanvas.GetPixels32();
            var target = px[sy * FlagW + sx];
            bool Same(Color32 p) => p.a == 0 && target.a == 0 || p.r == target.r && p.g == target.g && p.b == target.b && p.a == target.a;
            if (Same(ink)) return;
            var stack = new Stack<int>();
            stack.Push(sy * FlagW + sx);
            while (stack.Count > 0)
            {
                int i = stack.Pop();
                if (!Same(px[i])) continue;
                px[i] = ink;
                int x = i % FlagW, y = i / FlagW;
                if (x > 0) stack.Push(i - 1);
                if (x < FlagW - 1) stack.Push(i + 1);
                if (y > 0) stack.Push(i - FlagW);
                if (y < FlagH - 1) stack.Push(i + FlagW);
            }
            flagCanvas.SetPixels32(px);
        }

        // The drawing as a PNG data URL, or null: "my colour" ink (black) goes out as pure white, which the
        // game paints in the player's colour; other colours as drawn
        string ExportFlag()
        {
            var px = flagCanvas.GetPixels32();
            if (!px.Any(p => p.a > 0)) return null;
            var tex = new Texture2D(FlagW, FlagH, TextureFormat.RGBA32, false);
            tex.SetPixels32(px.Select(p => p.a == 0 ? new Color32(0, 0, 0, 0) : p.r == 0 && p.g == 0 && p.b == 0 ? new Color32(255, 255, 255, p.a) : p).ToArray());
            tex.Apply();
            var url = "data:image/png;base64," + Convert.ToBase64String(tex.EncodeToPNG());
            Destroy(tex);
            return url;
        }
    }
}
