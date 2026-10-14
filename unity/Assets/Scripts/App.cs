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

        enum Screen { Lobby, Room, Game }
        Screen screen = Screen.Lobby;
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

        // Flag editor: the player draws a black shape; the game receives it as white on transparent
        const int FlagW = 96, FlagH = 64, FlagBrush = 6, FlagZoom = 3;
        Texture2D flagCanvas;
        Vector2? lastFlagPoint;

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
            socket.OnConnect += () => lobbyError = "";
            socket.OnDisconnect += () =>
            {
                currentRoom = null;
                LeaveGame();
                screen = Screen.Lobby;
                lobbyError = "Desconectado del servidor. Reconectando…";
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
                screen = Screen.Game;
                Sfx.Play("start");
                Sfx.StartAmbient();
                game = GameView.Create(socket, myId, d, cam);
                if (AutoTest.Enabled) StartCoroutine(AutoTest.Run(game));
            });
            socket.On("game:state", d => game?.ApplyState(d));
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
                bool won = winnerId != null && winnerId == myId;
                var text = winnerName != null ? $"¡{(won ? "Tu reino" : winnerName)} {reason}!" : $"Sin ganador: {reason}.";
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
            // Slow orbit over nothing in particular while in the menus
            if (game == null) cam.transform.rotation = Quaternion.Euler(8, Time.unscaledTime * 3, 0);
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

            if (screen == Screen.Lobby) DrawLobby(W, H);
            else if (screen == Screen.Room) DrawRoom(W, H);
            if (end != null) DrawEnd(W, H);

            // Sound toggle (M)
            var muteRect = new Rect(W - 54, H - 54, 44, 44);
            appRects.Add(muteRect);
            if (GUI.Button(muteRect, Sfx.Muted ? "×♪" : "♪", Skin.Button)) Sfx.Muted = !Sfx.Muted;
        }

        void DrawLobby(float W, float H)
        {
            float w = 560, h = Mathf.Min(H - 40, 700);
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            GUI.Label(new Rect(panel.x + 60, panel.y - 18, w - 120, 64), "Tiny Swords RTS", Skin.Ribbon("blue"));
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
            GUI.Label(new Rect(x + 170, y + 2, cw - 170, 24), "(se pinta con tu color al jugar)", Skin.SmallDark);
            y += 26;
            var flagRect = new Rect(x, y, FlagW * FlagZoom * 0.75f, FlagH * FlagZoom * 0.75f);
            Skin.Rect(new Rect(flagRect.x - 3, flagRect.y - 3, flagRect.width + 6, flagRect.height + 6), new Color(0.24f, 0.16f, 0.08f));
            Skin.Rect(flagRect, Color.white);
            GUI.DrawTexture(flagRect, flagCanvas);
            if (!serverMenuOpen) HandleFlagInput(flagRect);
            if (GUI.Button(new Rect(flagRect.xMax + 16, flagRect.y + flagRect.height - 40, 110, 40), "Borrar", Skin.RedButton))
            {
                ClearFlag();
                PlayerPrefs.DeleteKey("flagDrawing");
            }
            y += flagRect.height + 14;

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
                    GUI.Label(new Rect(0, i * 46 + 8, cw - 150, 30), $"{room.name} — {room.players}/{room.max} {status}{(room.central ? "" : " · sin castillo")}", Skin.LabelDark);
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
            float w = 720, h = 460;
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            GUI.Label(new Rect(panel.x + 60, panel.y - 18, w - 120, 64), currentRoom.name, Skin.Ribbon("blue"));
            float x = panel.x + 34, y = panel.y + 60, cw = w - 68;
            bool isHost = currentRoom.hostId == myId;
            GUI.Label(new Rect(x, y, cw, 30), isHost ? "Eres el anfitrión. Inicia la partida cuando estén todos." : "Esperando a que el anfitrión inicie la partida…", Skin.LabelDark);
            y += 40;
            foreach (var p in currentRoom.playerList)
            {
                Skin.Rect(new Rect(x, y + 8, 16, 16), GameAssets.Hex(p.color));
                GUI.Label(new Rect(x + 24, y + 2, 190, 30), $"{p.name}{(p.id == myId ? " (tú)" : "")}", Skin.LabelDark);
                // Civilization: my own is a picker, everyone else's is shown as text
                if (p.id == myId)
                {
                    for (int i = 0; i < C.Civilizations.Length; i++)
                    {
                        var (id, name) = C.Civilizations[i];
                        bool on = p.civ == id;
                        if (GUI.Toggle(new Rect(x + 220 + i * 82, y, 78, 34), on, name, Skin.Button) && !on) socket.Emit("room:civ", id);
                    }
                }
                else GUI.Label(new Rect(x + 220, y + 4, 140, 30), C.Civilizations.FirstOrDefault(c => c.id == p.civ).name ?? "", Skin.SmallDark);
                if (p.id == currentRoom.hostId) GUI.Label(new Rect(x + cw - 90, y + 4, 90, 30), "anfitrión", Skin.SmallDark);
                y += 40;
            }
            y = Mathf.Max(y + 10, panel.y + 290);
            GUI.enabled = isHost;
            bool central = GUI.Toggle(new Rect(x, y, cw, 30), currentRoom.central, " Castillo central", Skin.Toggle);
            if (central != currentRoom.central) socket.Emit("room:settings", new { central });
            GUI.enabled = true;
            GUI.Label(new Rect(x + 22, y + 24, cw - 22, 36), "Se gana dominándolo; sin él solo se gana destruyendo a los rivales", Skin.SmallDark);
            y += 70;
            if (isHost && GUI.Button(new Rect(x, y, 200, 44), "Iniciar partida", Skin.Button)) socket.Emit("room:start");
            if (GUI.Button(new Rect(x + cw - 200, y, 200, 44), "Salir de la sala", Skin.RedButton)) socket.Emit("room:leave");
            var errStyle = new GUIStyle(Skin.LabelDark);
            errStyle.normal.textColor = new Color(0.75f, 0.15f, 0.1f);
            GUI.Label(new Rect(x, panel.yMax - 44, cw, 30), roomError, errStyle);
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

        void HandleFlagInput(Rect r)
        {
            var e = Event.current;
            if (e.button != 0) return;
            Vector2 ToCanvas(Vector2 m) => new Vector2((m.x - r.x) / r.width * FlagW, (1 - (m.y - r.y) / r.height) * FlagH);
            if (e.type == EventType.MouseDown && r.Contains(e.mousePosition))
            {
                var p = ToCanvas(e.mousePosition);
                Stamp(p);
                lastFlagPoint = p;
                flagCanvas.Apply();
                e.Use();
            }
            else if (e.type == EventType.MouseDrag && lastFlagPoint != null)
            {
                var p = ToCanvas(e.mousePosition);
                var a = lastFlagPoint.Value;
                int steps = Mathf.CeilToInt(Vector2.Distance(a, p));
                for (int i = 0; i <= steps; i++) Stamp(Vector2.Lerp(a, p, i / (float)Mathf.Max(1, steps)));
                lastFlagPoint = p;
                flagCanvas.Apply();
                e.Use();
            }
            else if (e.type == EventType.MouseUp && lastFlagPoint != null)
            {
                lastFlagPoint = null;
                PlayerPrefs.SetString("flagDrawing", Convert.ToBase64String(flagCanvas.EncodeToPNG()));
                e.Use();
            }
        }

        void Stamp(Vector2 c)
        {
            float rad = FlagBrush / 2f;
            for (int y = Mathf.FloorToInt(c.y - rad); y <= Mathf.CeilToInt(c.y + rad); y++)
                for (int x = Mathf.FloorToInt(c.x - rad); x <= Mathf.CeilToInt(c.x + rad); x++)
                    if (x >= 0 && y >= 0 && x < FlagW && y < FlagH && (x + 0.5f - c.x) * (x + 0.5f - c.x) + (y + 0.5f - c.y) * (y + 0.5f - c.y) <= rad * rad)
                        flagCanvas.SetPixel(x, y, Color.black);
        }

        // The drawing as white on transparent (PNG data URL, as the web client sends it), or null
        string ExportFlag()
        {
            var px = flagCanvas.GetPixels32();
            if (!px.Any(p => p.a > 0)) return null;
            var tex = new Texture2D(FlagW, FlagH, TextureFormat.RGBA32, false);
            tex.SetPixels32(px.Select(p => new Color32(255, 255, 255, p.a)).ToArray());
            tex.Apply();
            var url = "data:image/png;base64," + Convert.ToBase64String(tex.EncodeToPNG());
            Destroy(tex);
            return url;
        }
    }
}
