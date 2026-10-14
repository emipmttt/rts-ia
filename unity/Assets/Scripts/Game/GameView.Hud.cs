using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using RTS.UI;

// In-game UI: resource bar, ranking, build menu, idle-villager button, territory minimap,
// tooltip, messages, the selection box and the bars over units and buildings.
namespace RTS.Game
{
    public partial class GameView
    {
        static readonly Dictionary<string, int> ResourceColors = new Dictionary<string, int>
        {
            ["gold"] = 0xffd34d, ["food"] = 0xe57373, ["wood"] = 0x8bc34a, ["stone"] = 0xb0b0b0,
        };
        readonly List<Rect> uiRects = new List<Rect>();
        readonly List<Rect> nextUiRects = new List<Rect>();
        string message;
        bool messageNotice;
        float messageUntil;

        public void ShowMessage(string text, bool notice = false)
        {
            Sfx.Play(notice ? "notice" : "error");
            message = text;
            messageNotice = notice;
            messageUntil = Time.unscaledTime + 3;
        }

        Vector2 GuiMouse => new Vector2(Input.mousePosition.x / Skin.Scale, (Screen.height - Input.mousePosition.y) / Skin.Scale);

        public bool PointerOverUI
        {
            get
            {
                var m = GuiMouse;
                foreach (var r in uiRects) if (r.Contains(m)) return true;
                return App.Instance != null && App.Instance.PointerOverAppUI(m);
            }
        }

        Rect Block(Rect r)
        {
            nextUiRects.Add(r);
            return r;
        }

        void OnGUI()
        {
            Skin.Ensure();
            float k = Skin.Scale;
            GUI.matrix = Matrix4x4.Scale(new Vector3(k, k, 1));
            float W = Screen.width / k, H = Screen.height / k;
            if (Event.current.type == EventType.Layout) nextUiRects.Clear();

            if (Event.current.type == EventType.Repaint)
            {
                DrawBars(k);
                if (dragStart != null)
                {
                    var a = dragStart.Value;
                    var b = (Vector2)Input.mousePosition;
                    var r = Rect.MinMaxRect(Mathf.Min(a.x, b.x) / k, (Screen.height - Mathf.Max(a.y, b.y)) / k, Mathf.Max(a.x, b.x) / k, (Screen.height - Mathf.Min(a.y, b.y)) / k);
                    Skin.Rect(r, new Color(0, 1, 0, 0.1f));
                    Skin.Frame(r, new Color(0, 1, 0, 0.9f));
                }
            }

            // Under the open menu the HUD is visible but does not take clicks
            GUI.enabled = !menuOpen;
            DrawResourceBar();
            DrawRanking(W);
            DrawCommandBar(W, H);
            DrawAgeBanner(W, H);
            DrawMinimap(H);
            DrawMessage(W);
            DrawTooltip(W, H);
            GUI.enabled = true;
            DrawMenuButton(W);
            if (menuOpen) DrawMenu(W, H);

            if (Event.current.type == EventType.Repaint)
            {
                uiRects.Clear();
                uiRects.AddRange(nextUiRects);
            }
        }

        // ---------- Top bar ----------

        void DrawResourceBar()
        {
            var mine = sprites.Values.Where(s => s.s.owner == myId).ToList();
            int villagers = mine.Count(s => s.s.type == "villager");
            int idle = IdleVillagers().Count;
            int army = mine.Count(s => Soldiers.Contains(s.s.type));
            bool popFull = popUsed >= popCap;
            int Get(string r) => stock.TryGetValue(r, out var v) ? v : 0;

            var items = new List<(Texture2D icon, string text, bool warn)>
            {
                (GameAssets.UI("food"), Get("food").ToString(), false),
                (GameAssets.UI("wood"), Get("wood").ToString(), false),
                (GameAssets.UI("gold"), Get("gold").ToString(), false),
                (GameAssets.UI("stone"), Get("stone").ToString(), false),
                (null, $"Población: {popUsed}/{popCap}{(popCap >= C.MaxPopulation ? " (máx.)" : "")}", popFull),
                (null, $"Aldeanos: {villagers} ({idle} inactivos)", false),
                (null, $"Ejército: {army}", false),
            };
            var aging = sprites.Values.FirstOrDefault(s => s.s.owner == myId && s.s.ageUpTo > 0);
            items.Insert(0, (null, aging != null ? $"Edad {Defs.AgeNumerals[MyAge - 1]} → {Defs.AgeNumerals[aging.s.ageUpTo - 1]} {Mathf.FloorToInt(aging.s.ageUpProgress * 100)}%" : $"Edad {Defs.AgeNumerals[MyAge - 1]} · {Defs.Ages[MyAge - 1].name}", false));
            var central = sprites.Values.FirstOrDefault(s => s.s.central);
            if (central != null)
            {
                string holder = central.s.owner == null ? "neutral"
                    : $"{(central.s.owner == myId ? "Tú" : players.TryGetValue(central.s.owner, out var hp) ? hp.name : "?")} {Defs.FormatTime(central.s.controlTime)} / {Defs.FormatTime(C.CentralControlTime)}";
                items.Add((null, $"Centro: {holder}", false));
            }

            float x = 10, y = 8, h = 40;
            var widths = items.Select(i => Skin.Label.CalcSize(new GUIContent(i.text)).x + (i.icon != null ? 30 : 0) + 18).ToList();
            var panel = Block(new Rect(x, y, widths.Sum() + 24, h));
            GUI.Box(panel, GUIContent.none, Skin.Panel);
            float cx = x + 14;
            for (int i = 0; i < items.Count; i++)
            {
                var (icon, text, warn) = items[i];
                if (icon != null) { GUI.DrawTexture(new Rect(cx, y + 7, 26, 26), icon, ScaleMode.ScaleToFit); cx += 30; }
                var style = Skin.Label;
                var old = style.normal.textColor;
                if (warn) style.normal.textColor = new Color(1, 0.45f, 0.4f);
                GUI.Label(new Rect(cx, y + 9, widths[i], 24), text, style);
                style.normal.textColor = old;
                cx += widths[i] - (icon != null ? 30 : 0);
            }

            // Idle villager button under the bar
            if (idle > 0)
            {
                var r = Block(new Rect(x, y + h + 6, 240, 40));
                if (GUI.Button(r, $"Aldeano inactivo ({idle})  [.]", Skin.Button)) SelectIdleVillager();
            }
        }

        // What a unit's attack does beyond its damage
        static string AbilityText(AttackStats a)
        {
            if (a.line > 0) return $"Púas de roca en hilera: golpea a todos en la línea · rocas x{a.vsBuildings} contra edificios";
            var parts = new List<string>();
            if (a.area > 0) parts.Add("golpe en área");
            if (a.stun > 0) parts.Add($"aturde {a.stun}s");
            if (a.burn) parts.Add("quema");
            if (a.chill > 0) parts.Add($"congela: frena un {Mathf.RoundToInt((1 - a.chill) * 100)}%");
            if (a.vsFast > 1) parts.Add($"x{a.vsFast} de daño contra unidades rápidas · su escudo frena flechas");
            if (parts.Count == 0) return null;
            var text = string.Join(" · ", parts);
            return char.ToUpper(text[0]) + text.Substring(1);
        }

        // ---------- Menu (Esc) ----------

        const float MenuButtonSize = 40;
        bool menuOpen, confirmLeave;

        void ToggleMenu()
        {
            menuOpen = !menuOpen;
            confirmLeave = false;
            Sfx.Play("click");
        }

        // Small button in the top-right corner: three bars
        void DrawMenuButton(float W)
        {
            var r = Block(new Rect(W - MenuButtonSize - 10, 8, MenuButtonSize, MenuButtonSize));
            if (GUI.Button(r, new GUIContent("", "Menú (Esc)"), Skin.Button)) ToggleMenu();
            if (Event.current.type != EventType.Repaint) return;
            for (int i = 0; i < 3; i++) Skin.Rect(new Rect(r.x + 11, r.y + 10 + i * 7, r.width - 22, 3), Color.white);
        }

        // The game keeps running (it is multiplayer); leaving removes the player and their village
        void DrawMenu(float W, float H)
        {
            Block(new Rect(0, 0, W, H));
            Skin.Rect(new Rect(0, 0, W, H), new Color(0, 0, 0, 0.45f));
            float w = 340, h = confirmLeave ? 230 : 322;
            var panel = new Rect((W - w) / 2, (H - h) / 2, w, h);
            GUI.Box(panel, GUIContent.none, Skin.Paper);
            float bx = panel.x + 40, bw = w - 80, y = panel.y + 28;
            if (confirmLeave)
            {
                GUI.Label(new Rect(bx, y, bw, 30), "¿Salir de la partida?", new GUIStyle(Skin.TitleDark) { fontSize = 22 });
                GUI.Label(new Rect(bx, y + 38, bw, 50), "Tu aldea desaparecerá y no podrás volver a esta partida.", new GUIStyle(Skin.SmallDark) { alignment = TextAnchor.UpperCenter });
                if (GUI.Button(new Rect(bx, y + 96, bw, 44), "Sí, salir", Skin.RedButton))
                {
                    Sfx.Play("click");
                    socket.Emit("room:leave");
                }
                if (GUI.Button(new Rect(bx, y + 146, bw, 40), "Cancelar", Skin.Button)) { Sfx.Play("click"); confirmLeave = false; }
                return;
            }
            GUI.Label(new Rect(bx, y, bw, 30), "Menú", new GUIStyle(Skin.TitleDark) { fontSize = 24 });
            y += 46;
            if (GUI.Button(new Rect(bx, y, bw, 44), "Continuar", Skin.Button)) ToggleMenu();
            y += 52;
            if (GUI.Button(new Rect(bx, y, bw, 44), Sfx.Muted ? "Activar sonido (M)" : "Silenciar (M)", Skin.Button))
            {
                Sfx.Muted = !Sfx.Muted;
                Sfx.Play("click");
            }
            y += 52;
            if (GUI.Button(new Rect(bx, y, bw, 44), Materials.Outlines ? "Contornos de color: sí" : "Contornos de color: no", Skin.Button))
            {
                Materials.Outlines = !Materials.Outlines;
                Sfx.Play("click");
            }
            y += 52;
            if (GUI.Button(new Rect(bx, y, bw, 44), "Salir de la partida", Skin.RedButton)) { Sfx.Play("click"); confirmLeave = true; }
        }

        // Every player by points, leader first; defeated crossed out, disconnected marked
        void DrawRanking(float W)
        {
            var list = players.Values.OrderByDescending(p => p.score).ToList();
            float w = 230, rowH = 22;
            var panel = Block(new Rect(W - w - 10 - MenuButtonSize - 6, 8, w, 46 + list.Count * rowH));
            GUI.Box(panel, GUIContent.none, Skin.Panel);
            GUI.Label(new Rect(panel.x + 16, panel.y + 10, w - 32, 24), "Ranking", Skin.Label);
            for (int i = 0; i < list.Count; i++)
            {
                var p = list[i];
                float y = panel.y + 34 + i * rowH;
                var name = $"{(i == 0 && !p.defeated ? "★" : $"{i + 1}.")} {p.name}{(p.id == myId ? " (tú)" : "")}{(p.connected ? "" : " ⚠")}";
                Skin.Rect(new Rect(panel.x + 16, y + 5, 12, 12), GameAssets.Hex(p.color));
                var style = p.id == myId ? Skin.Label : Skin.Small;
                var old = style.normal.textColor;
                if (p.defeated) style.normal.textColor = new Color(0.7f, 0.7f, 0.7f);
                GUI.Label(new Rect(panel.x + 34, y, w - 100, rowH), name, style);
                GUI.Label(new Rect(panel.xMax - 66, y, 50, rowH), p.score.ToString(), style);
                style.normal.textColor = old;
                if (p.defeated) Skin.Rect(new Rect(panel.x + 34, y + 11, w - 70, 1), new Color(0.8f, 0.8f, 0.8f));
            }
        }

        // ---------- Command bar ----------

        const float SlotW = 128, SlotH = 128, SlotGap = 8, BarPad = 14, BarHeader = 26;
        static readonly string[] CostOrder = { "food", "wood", "gold", "stone" };
        static readonly Color TextDim = new Color(0.85f, 0.8f, 0.72f);
        static readonly Color TextBad = new Color(1f, 0.5f, 0.45f);

        // One slot of the command bar
        class BarAction
        {
            public Texture tex; public Rect? uv; public Color? tint;
            public string title, line, hover;
            public Cost cost;
            public bool enabled = true, active;
            public int badge;
            public System.Action act;      // when clicked or its key is pressed
            public string disabledReason;  // shown when its key is pressed while it can't be used
            public string locked;          // age it needs, when not reached yet ("Edad II")
        }

        // Keys of the slots, left to right (WASD/QE move the camera, M mutes, H finds the town center)
        static readonly KeyCode[] SlotKeys = { KeyCode.Z, KeyCode.X, KeyCode.C, KeyCode.V, KeyCode.B, KeyCode.N, KeyCode.F, KeyCode.G, KeyCode.J, KeyCode.K };

        // What the bar along the bottom offers for the current selection: buildings to place (villagers
        // or nothing selected), the units and upgrades of a selected building of ours, or a summary of
        // the selected army
        List<BarAction> BarActions(out string title, out EntityView building)
        {
            var mine = selected.Where(id => sprites.TryGetValue(id, out var v) && v.s.owner == myId).Select(id => sprites[id]).ToList();
            building = mine.Count == 1 && mine[0].isBuilding ? mine[0] : null;
            var list = new List<BarAction>();
            var civ = CivOf(myId);
            if (building != null)
            {
                var b = building;
                var e = b.s;
                var stats = b.stats;
                if (e.built && stats.trains != null)
                    foreach (var type in stats.trains)
                    {
                        var unit = Defs.UnitStats(type, civ);
                        var (tex, uv) = UnitIcon(type, myId);
                        int needs = Defs.Entity[type].age;
                        string why = needs > MyAge ? $"Requiere la {Defs.Ages[needs - 1].name}"
                            : e.ageUpTo > 0 ? "Avanzando de edad"
                            : !Defs.CanAfford(stock, unit.cost) ? "Recursos insuficientes"
                            : e.queueLength >= C.MaxTrainQueue ? "La cola está llena"
                            : popUsed >= popCap ? (popCap >= C.MaxPopulation ? "Límite de población alcanzado" : "Necesitas más casas") : null;
                        var t = type;
                        list.Add(new BarAction { tex = tex, uv = uv, title = unit.name, cost = unit.cost, enabled = why == null, disabledReason = why, hover = "unit:" + type, badge = e.queue.Count(q => q == type), act = () => Train(b, t), locked = needs > MyAge ? $"Edad {Defs.AgeNumerals[needs - 1]}" : null });
                    }
                if (e.built && stats.dropOff)
                {
                    int level = players.TryGetValue(myId, out var me) ? me.gatherLevel : 0;
                    if (level < Defs.GatherUpgrades.Length && e.researchLevel < 0)
                    {
                        var up = Defs.GatherUpgrades[level];
                        bool ok = Defs.CanAfford(stock, up.cost);
                        list.Add(new BarAction { tex = GameAssets.UI("wood"), title = up.name, cost = up.cost, enabled = ok, disabledReason = "Recursos insuficientes", hover = "research", act = () => Research(b) });
                    }
                }
                // Town centers advance the player to the next age (pictured by the next age's town center)
                if (e.built && e.type == "townCenter" && MyAge < Defs.Ages.Length)
                {
                    var next = Defs.Ages[MyAge];
                    bool aging = sprites.Values.Any(o => o.s.owner == myId && o.s.ageUpTo > 0);
                    string why = aging ? "Ya estás avanzando de edad" : !Defs.CanAfford(stock, next.cost) ? "Recursos insuficientes" : null;
                    ModelIcons.TryGet(NextAgeIconKey(), out var ageIcon);
                    list.Add(new BarAction { tex = ageIcon ?? GameAssets.UI("gold"), title = $"Avanzar: {next.name}", cost = next.cost, enabled = why == null, disabledReason = why, hover = "ageup", act = () => socket.Emit("game:ageup", new { buildingId = b.s.id }) });
                }
                if (e.built && stats.IsFarm && e.food <= 0)
                {
                    bool ok = Defs.CanAfford(stock, stats.reseedCost);
                    list.Add(new BarAction { tex = GameAssets.UI("food"), title = "Resembrar", cost = stats.reseedCost, enabled = ok, disabledReason = "Recursos insuficientes", hover = "reseed", act = () => Reseed(b) });
                }
                var name = Defs.UnitStats(e.type, civ).name;
                title = list.Count > 0 ? $"{name} · entrenar y mejorar" : name;
                return list;
            }
            if (mine.Count > 0 && !mine.Any(v => v.s.type == "villager"))
            {
                foreach (var g in mine.GroupBy(v => v.s.type).OrderBy(g => g.Key))
                {
                    var (tex, uv) = UnitIcon(g.Key, myId);
                    var ids = g.Select(v => v.s.id).ToList();
                    list.Add(new BarAction { tex = tex, uv = uv, title = Defs.UnitStats(g.Key, civ).name, badge = ids.Count, hover = "unit:" + g.Key, act = () => selected = new HashSet<int>(ids) });
                }
                title = $"Ejército seleccionado · {mine.Count} unidades · elige un tipo para quedarte solo con esos";
                return list;
            }
            bool villagers = mine.Count > 0;
            var faction = FactionOf(myId);
            foreach (var type in Defs.Buildable)
            {
                var stats = Defs.Entity[type];
                var art = BuildingArt[type];
                // A render of the building's model in the player's civilization and colour; sprite otherwise
                bool modelIcon = ModelIcons.TryGet(BuildIconKey(type), out var icon);
                var t = type;
                bool reached = stats.age <= MyAge;
                list.Add(new BarAction
                {
                    tex = modelIcon ? icon : GameAssets.Asset($"{faction}/{art.texture}"), tint = modelIcon ? Color.white : GameAssets.Hex(art.tint),
                    title = stats.name, cost = stats.cost, enabled = reached && Defs.CanAfford(stock, stats.cost),
                    disabledReason = reached ? "Recursos insuficientes" : $"Requiere la {Defs.Ages[stats.age - 1].name}",
                    locked = reached ? null : $"Edad {Defs.AgeNumerals[stats.age - 1]}",
                    active = placing == type, hover = type, act = () => placing = placing == t ? null : t,
                });
            }
            title = villagers ? "Construir" : "Construir · selecciona aldeanos para que lo levanten";
            return list;
        }

        void DrawCommandBar(float W, float H)
        {
            var actions = BarActions(out var title, out var building);
            const float InfoW = 230;
            float extra = building != null ? InfoW + SlotGap : 0;
            var panel = BarPanel(actions.Count, extra, W, H, title);
            if (building != null) DrawBuildingInfo(new Rect(panel.x + BarPad, panel.y + BarHeader + BarPad - 4, InfoW, SlotH), building);
            for (int i = 0; i < actions.Count; i++)
            {
                var a = actions[i];
                var r = Slot(panel, i, extra);
                if (SlotButton(r, a.tex, a.uv, a.title, a.cost, a.line, a.enabled, a.active, a.tint, a.badge, i < SlotKeys.Length ? SlotKeys[i].ToString() : null, a.locked)) a.act();
                if (r.Contains(Event.current.mousePosition)) barHover = a.hover;
            }
        }

        // The slot keys run the bar's actions, as if clicked
        void HandleBarKeys()
        {
            if (GUIUtility.keyboardControl != 0) return;
            for (int i = 0; i < SlotKeys.Length; i++)
            {
                if (!Input.GetKeyDown(SlotKeys[i])) continue;
                var actions = BarActions(out _, out _);
                if (i >= actions.Count) return;
                var a = actions[i];
                if (!a.enabled) { ShowMessage(a.disabledReason ?? "No disponible"); return; }
                Sfx.Play("click");
                a.act();
                return;
            }
        }

        const float MinimapRight = 240; // the territory map takes the bottom-left corner
        float slotW = SlotW;

        // Panel holding `slots` buttons (plus `extra` px on the left), with a title along its top;
        // centred in the space right of the minimap, slots narrowing when they don't fit
        Rect BarPanel(int slots, float extra, float W, float H, string title)
        {
            int n = Mathf.Max(1, slots);
            float room = W - MinimapRight - 10 - BarPad * 2 - extra;
            slotW = Mathf.Clamp((room + SlotGap) / n - SlotGap, 96, SlotW);
            float inner = extra + n * (slotW + SlotGap) - SlotGap;
            float x = MinimapRight + (W - MinimapRight - 10 - inner - BarPad * 2) / 2;
            var panel = Block(new Rect(Mathf.Max(MinimapRight, x), H - SlotH - BarHeader - BarPad * 2 - 6, inner + BarPad * 2, SlotH + BarHeader + BarPad * 2));
            GUI.Box(panel, GUIContent.none, Skin.Panel);
            var head = new GUIStyle(Skin.Label) { fontSize = 15, alignment = TextAnchor.MiddleLeft, wordWrap = false };
            Shadowed(new Rect(panel.x + BarPad, panel.y + 6, panel.width - BarPad * 2, BarHeader - 4), title, head, new Color(1f, 0.9f, 0.65f));
            return panel;
        }

        Rect Slot(Rect panel, int i, float extra = 0) =>
            new Rect(panel.x + BarPad + extra + i * (slotW + SlotGap), panel.y + BarHeader + BarPad - 4, slotW, SlotH);

        static void Shadowed(Rect r, string text, GUIStyle style, Color color)
        {
            var old = style.normal.textColor;
            style.normal.textColor = new Color(0, 0, 0, 0.7f);
            GUI.Label(new Rect(r.x + 1, r.y + 1, r.width, r.height), text, style);
            style.normal.textColor = color;
            GUI.Label(r, text, style);
            style.normal.textColor = old;
        }

        // Label shrunk until it fits on one line
        static void FitLabel(Rect r, string text, int size, int min, Color color)
        {
            var style = new GUIStyle(Skin.Center) { fontSize = size, wordWrap = false, clipping = TextClipping.Clip };
            while (style.fontSize > min && style.CalcSize(new GUIContent(text)).x > r.width) style.fontSize--;
            Shadowed(r, text, style, color);
        }

        // Cost as resource icons and amounts, the ones we can't pay in red
        void CostRow(Rect r, Cost cost)
        {
            if (cost == null || cost.Count == 0) return;
            var style = new GUIStyle(Skin.Label) { fontSize = 13, wordWrap = false, alignment = TextAnchor.MiddleLeft };
            var items = CostOrder.Where(cost.ContainsKey).Select(k => (k, text: cost[k].ToString())).ToList();
            float total = items.Sum(i => 18 + style.CalcSize(new GUIContent(i.text)).x + 6) - 6;
            float x = r.center.x - total / 2;
            foreach (var (k, text) in items)
            {
                GUI.DrawTexture(new Rect(x, r.y + (r.height - 16) / 2, 16, 16), GameAssets.UI(k), ScaleMode.ScaleToFit);
                x += 18;
                float w = style.CalcSize(new GUIContent(text)).x;
                bool short_ = (stock.TryGetValue(k, out var have) ? have : 0) < cost[k];
                Shadowed(new Rect(x, r.y, w + 2, r.height), text, style, short_ ? TextBad : Color.white);
                x += w + 6;
            }
        }

        // A slot: picture, name and cost; greyed out when it can't be used; a count badge in the corner
        bool SlotButton(Rect r, Texture tex, Rect? uv, string title, Cost cost, string line, bool enabled, bool active = false, Color? tint = null, int badge = 0, string key = null, string locked = null)
        {
            GUI.enabled = enabled && !menuOpen;
            bool clicked = GUI.Toggle(r, active, GUIContent.none, Skin.Slot) != active;
            GUI.enabled = !menuOpen;
            var pic = new Rect(r.x + 8, r.y + 8, r.width - 16, 72);
            var old = GUI.color;
            GUI.color = enabled ? tint ?? Color.white : new Color(0.45f, 0.45f, 0.45f, 0.9f);
            if (tex != null)
            {
                if (uv != null) DrawFitted(pic, tex, uv.Value);
                else GUI.DrawTexture(pic, tex, ScaleMode.ScaleToFit);
            }
            GUI.color = old;
            FitLabel(new Rect(r.x + 4, r.y + 82, r.width - 8, 20), title, 14, 10, enabled ? Color.white : TextDim);
            if (cost != null) CostRow(new Rect(r.x + 4, r.y + 103, r.width - 8, 18), cost);
            else if (line != null) FitLabel(new Rect(r.x + 4, r.y + 103, r.width - 8, 18), line, 12, 9, TextDim);
            if (badge > 0)
            {
                var b = new Rect(r.xMax - 26, r.y + 6, 20, 20);
                Skin.Rect(b, new Color(0.93f, 0.76f, 0.35f));
                Skin.Rect(new Rect(b.x + 2, b.y + 2, b.width - 4, b.height - 4), new Color(0.26f, 0.18f, 0.08f));
                Shadowed(b, badge.ToString(), new GUIStyle(Skin.Center) { fontSize = 12 }, Color.white);
            }
            if (locked != null)
            {
                // Not available in this age: a dark veil over the picture with the age it needs
                Skin.Rect(new Rect(pic.x, pic.y + pic.height / 2 - 13, pic.width, 26), new Color(0, 0, 0, 0.6f));
                Shadowed(new Rect(pic.x, pic.y + pic.height / 2 - 13, pic.width, 26), locked, new GUIStyle(Skin.Center) { fontSize = 13 }, new Color(1f, 0.85f, 0.55f));
            }
            if (key != null)
            {
                // Its keyboard shortcut in the top-left corner
                var k = new Rect(r.x + 6, r.y + 6, 18, 18);
                Skin.Rect(k, new Color(0, 0, 0, 0.55f));
                Skin.Frame(k, new Color(1f, 0.9f, 0.65f, 0.8f));
                Shadowed(k, key, new GUIStyle(Skin.Center) { fontSize = 11 }, new Color(1f, 0.9f, 0.65f));
            }
            if (clicked) Sfx.Play("click");
            return clicked;
        }

        // Part of a texture (a sprite's rect) scaled to fit `r`: whole multiples for pixel art that is
        // small enough to grow, so its pixels stay square and crisp
        static void DrawFitted(Rect r, Texture tex, Rect uv)
        {
            float w = uv.width * tex.width, h = uv.height * tex.height;
            float k = Mathf.Min(r.width / w, r.height / h);
            if (k >= 1) k = Mathf.Floor(k);
            var dst = new Rect(Mathf.Round(r.x + (r.width - w * k) / 2), Mathf.Round(r.y + (r.height - h * k) / 2), w * k, h * k);
            GUI.DrawTextureWithTexCoords(dst, tex, uv);
        }

        readonly Dictionary<Sprite, Rect> spriteBounds = new Dictionary<Sprite, Rect>();

        // A unit's portrait: the first idle frame of its rig in the owner's colours and civilization,
        // cropped to the figure so it can be drawn big
        (Texture tex, Rect uv) UnitIcon(string type, string owner)
        {
            var art = UnitArt[type];
            var faction = FactionOf(owner);
            Sprite sp;
            if (!art.rig) sp = GameAssets.Lancer(faction, "idle")[0];
            else
            {
                var civ = CivOf(owner);
                var rig = civ != null && civ != "air" && GameAssets.HasRig($"{art.sheet}_{civ}") ? $"{art.sheet}_{civ}" : art.sheet;
                sp = GameAssets.RigFrames(faction, rig, HairStyles[0], "front", "idle")[0];
            }
            var t = sp.texture;
            if (!spriteBounds.TryGetValue(sp, out var rect))
            {
                // Bounding box of the opaque pixels (one pixel of margin)
                var src = sp.textureRect;
                int x0 = (int)src.x, y0 = (int)src.y, w = (int)src.width, h = (int)src.height;
                var px = t.GetPixels32();
                int minX = w, minY = h, maxX = -1, maxY = -1;
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                        if (px[(y0 + y) * t.width + x0 + x].a > 0) { minX = Mathf.Min(minX, x); maxX = Mathf.Max(maxX, x); minY = Mathf.Min(minY, y); maxY = Mathf.Max(maxY, y); }
                rect = maxX < 0 ? src : new Rect(x0 + minX - 1, y0 + minY - 1, maxX - minX + 3, maxY - minY + 3);
                spriteBounds[sp] = rect;
            }
            return (t, new Rect(rect.x / t.width, rect.y / t.height, rect.width / t.width, rect.height / t.height));
        }

        // Health, then whatever the building is doing: construction, the training queue as portraits
        // with the first one's progress, or research
        void DrawBuildingInfo(Rect r, EntityView b)
        {
            var e = b.s;
            GUI.Box(r, GUIContent.none, Skin.Slot);
            var label = new GUIStyle(Skin.Label) { fontSize = 13, wordWrap = false, alignment = TextAnchor.MiddleLeft };
            float x = r.x + 12, w = r.width - 24, y = r.y + 10;
            Shadowed(new Rect(x, y, w, 18), $"Vida {Mathf.RoundToInt(e.hp)} / {Mathf.RoundToInt(b.MaxHp)}", label, Color.white);
            Bar(new Vector2(x + w / 2, y + 20), w, 6, e.hp / b.MaxHp, GameAssets.Hex(0x7fbf6a));
            y += 34;
            if (!e.built)
            {
                Shadowed(new Rect(x, y, w, 18), $"En construcción {Mathf.FloorToInt(e.buildProgress * 100)}%", label, TextDim);
                Bar(new Vector2(x + w / 2, y + 20), w, 6, e.buildProgress, GameAssets.Hex(0xe0a85a));
                return;
            }
            if (e.ageUpTo > 0)
            {
                Shadowed(new Rect(x, y, w, 18), $"Avanzando a la {Defs.Ages[e.ageUpTo - 1].name}", label, new Color(1f, 0.9f, 0.6f));
                Bar(new Vector2(x + w / 2, y + 20), w, 6, e.ageUpProgress, GameAssets.Hex(0xe2bf5c));
                Shadowed(new Rect(x, y + 30, w, 18), $"{Mathf.FloorToInt(e.ageUpProgress * 100)}%", label, TextDim);
                return;
            }
            if (e.queue.Length > 0)
            {
                Shadowed(new Rect(x, y, w, 18), $"Entrenando {Mathf.FloorToInt(e.trainProgress * 100)}%   ({e.queue.Length}/{C.MaxTrainQueue})", label, TextDim);
                Bar(new Vector2(x + w / 2, y + 20), w, 6, e.trainProgress, GameAssets.Hex(0x8cc2e0));
                for (int i = 0; i < e.queue.Length; i++)
                {
                    var cell = new Rect(x + i * 40, y + 32, 36, 36);
                    Skin.Rect(cell, i == 0 ? new Color(0.93f, 0.76f, 0.35f, 0.9f) : new Color(0.3f, 0.24f, 0.18f, 0.9f));
                    Skin.Rect(new Rect(cell.x + 2, cell.y + 2, cell.width - 4, cell.height - 4), new Color(0.12f, 0.09f, 0.07f, 1));
                    var (tex, uv) = UnitIcon(e.queue[i], myId);
                    DrawFitted(new Rect(cell.x + 3, cell.y + 3, cell.width - 6, cell.height - 6), tex, uv);
                }
                return;
            }
            if (e.researchLevel >= 0)
            {
                Shadowed(new Rect(x, y, w, 18), $"Investigando {Defs.GatherUpgrades[e.researchLevel].name}", label, TextDim);
                Bar(new Vector2(x + w / 2, y + 20), w, 6, e.researchProgress, GameAssets.Hex(0xb39ad6));
                return;
            }
            var stats = b.stats;
            string idle = stats.trains != null ? "Listo para entrenar"
                : stats.population > 0 ? $"Da {stats.population} de población"
                : stats.attack != null ? $"Dispara a enemigos a {stats.attack.range} de distancia"
                : stats.IsFarm ? $"Cosecha: {Mathf.RoundToInt(e.food)} / {stats.farmFood}"
                : "";
            var wrap = new GUIStyle(label) { wordWrap = true, alignment = TextAnchor.UpperLeft };
            Shadowed(new Rect(x, y, w, 60), idle, wrap, TextDim);
        }

        void Train(EntityView b, string type)
        {
            var unit = Defs.UnitStats(type, CivOf(myId));
            if (!Defs.CanAfford(stock, unit.cost)) { ShowMessage("Recursos insuficientes"); return; }
            if (b.s.queueLength >= C.MaxTrainQueue) { ShowMessage("La cola está llena"); return; }
            if (popUsed >= popCap) { ShowMessage(popCap >= C.MaxPopulation ? "Límite de población alcanzado" : "Necesitas más casas"); return; }
            socket.Emit("game:train", new { buildingId = b.s.id, type });
        }

        void Research(EntityView b)
        {
            int level = players.TryGetValue(myId, out var me) ? me.gatherLevel : 0;
            if (level >= Defs.GatherUpgrades.Length) return;
            if (!Defs.CanAfford(stock, Defs.GatherUpgrades[level].cost)) { ShowMessage("Recursos insuficientes"); return; }
            socket.Emit("game:research", new { buildingId = b.s.id });
        }

        void Reseed(EntityView b)
        {
            if (!Defs.CanAfford(stock, b.stats.reseedCost)) { ShowMessage("Recursos insuficientes"); return; }
            socket.Emit("game:reseed", new { buildingId = b.s.id });
        }

        string barHover; // what the pointer is over in the command bar: a building type, "unit:<type>", "research", "reseed"

        int MyAge => AgeOf(myId);

        string IconPath(string type) => type == "wall" ? "models/wall_post" : BuildingModels.TryGetValue(type, out var m) ? m.path : null;
        string BuildIconKey(string type) => IconPath(type) is { } path ? $"{ModelPath(path, myId)}|{ColorOf(myId)}" : null;

        // The next age's town center in our civilization, for the age-up button
        string NextAgeIconPath()
        {
            var civ = CivOf(myId);
            var path = string.IsNullOrEmpty(civ) || civ == "air" ? "models/center" : "models/center_" + civ;
            var next = path + AgeSuffix(Mathf.Min(MyAge + 1, Defs.Ages.Length));
            return GlbLoader.Exists(next) ? next : path;
        }
        string NextAgeIconKey() => $"{NextAgeIconPath()}|{ColorOf(myId)}";

        // Renders the build menu's model pictures once (cameras can't render inside OnGUI)
        string buildIconsFor; // civilization and colour the icons were rendered for
        void PrepareBuildIcons()
        {
            if (!players.ContainsKey(myId)) return;
            var signature = $"{CivOf(myId)}|{ColorOf(myId)}|{MyAge}";
            if (buildIconsFor == signature) return;
            buildIconsFor = signature;
            foreach (var type in Defs.Buildable)
            {
                var key = BuildIconKey(type);
                if (key == null || ModelIcons.TryGet(key, out _)) continue;
                ModelIcons.Render(key, ModelPath(IconPath(type), myId), ColorOf(myId));
            }
            if (!ModelIcons.TryGet(NextAgeIconKey(), out _)) ModelIcons.Render(NextAgeIconKey(), NextAgeIconPath(), ColorOf(myId));
        }

        // ---------- Minimap ----------

        void DrawMinimap(float H)
        {
            const float Size = 190;
            var panel = Block(new Rect(10, H - Size - 60, Size + 28, Size + 52));
            GUI.Box(panel, GUIContent.none, Skin.Panel);
            GUI.Label(new Rect(panel.x + 14, panel.y + 8, Size, 22), "Territorios", Skin.Label);
            var map = new Rect(panel.x + 14, panel.y + 34, Size, Size);
            GUI.DrawTexture(map, territory.Texture);
            // The camera's view of the ground, as a trapezoid of dots
            if (Event.current.type == EventType.Repaint)
            {
                var corners = new List<Vector2>();
                foreach (var v in new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1) })
                {
                    var ray = rts.cam.ViewportPointToRay(v);
                    float t = ray.direction.y < -0.01f ? (0 - ray.origin.y) / ray.direction.y : 200;
                    var p = World.Ground.ToServer(ray.GetPoint(Mathf.Min(t, 200)));
                    corners.Add(new Vector2(map.x + p.x / (mapTiles * C.TileSize) * Size, map.y + p.y / (mapTiles * C.TileSize) * Size));
                }
                GUI.BeginGroup(map);
                for (int i = 0; i < 4; i++)
                {
                    var a = corners[i] - map.position;
                    var b = corners[(i + 1) % 4] - map.position;
                    int steps = Mathf.CeilToInt(Vector2.Distance(a, b) / 2);
                    for (int j = 0; j <= steps; j++)
                    {
                        var p = Vector2.Lerp(a, b, j / (float)Mathf.Max(1, steps));
                        Skin.Rect(new Rect(p.x - 1, p.y - 1, 2, 2), Color.white);
                    }
                }
                GUI.EndGroup();
            }
            var e = Event.current;
            if ((e.type == EventType.MouseDown || e.type == EventType.MouseDrag) && e.button == 0 && map.Contains(e.mousePosition))
            {
                var rel = (e.mousePosition - map.position) / Size * (mapTiles * C.TileSize);
                rts.FocusOn(rel.x, rel.y);
                e.Use();
            }
        }

        // ---------- Messages & tooltip ----------

        void DrawMessage(float W)
        {
            if (message == null || Time.unscaledTime > messageUntil) return;
            var style = Skin.Ribbon(messageNotice ? "blue" : "red", 46);
            float w = Mathf.Min(620, style.CalcSize(new GUIContent(message)).x + 40);
            GUI.Label(new Rect((W - w) / 2, 70, w, 52), message, style);
        }

        void DrawTooltip(float W, float H)
        {
            string text = TooltipText();
            if (text == null) return;
            var content = new GUIContent(text);
            float w = Mathf.Min(420, Skin.Tooltip.CalcSize(content).x + 4);
            float h = Skin.Tooltip.CalcHeight(content, w);
            var m = GuiMouse;
            float x = Mathf.Min(m.x + 16, W - w - 8), y = Mathf.Min(m.y + 16, H - h - 8);
            GUI.Box(new Rect(x, y, w, h), content, Skin.Tooltip);
        }

        string TooltipText()
        {
            if (placing != null)
            {
                var st = Defs.Entity[placing];
                return $"{st.name} — {Defs.FormatCost(st.cost)}\nClic izquierdo para colocar, clic derecho / Esc para cancelar";
            }
            if (PointerOverUI)
            {
                var m = GuiMouse;
                if (barHover == null || m.y < Screen.height / Skin.Scale - (SlotH + BarHeader + BarPad * 2 + 6)) { barHover = null; return null; }
                if (barHover.StartsWith("unit:"))
                {
                    var type = barHover.Substring(5);
                    var u = Defs.UnitStats(type, CivOf(myId));
                    var lines = new List<string> { $"{u.name} — {Defs.FormatCost(u.cost)} · {u.trainTime}s", $"PV {u.hp} · velocidad {u.speed}" };
                    if (u.heal != null) lines.Add($"Cura {u.heal.amount} PV/s a unidades aliadas cercanas");
                    else if (u.attack != null)
                    {
                        lines.Add($"Ataque {u.attack.damage} · {(u.attack.range > 0 ? $"alcance {u.attack.range}" : "cuerpo a cuerpo")}");
                        var ability = AbilityText(u.attack);
                        if (ability != null) lines.Add(ability);
                    }
                    return string.Join("\n", lines);
                }
                if (barHover == "research")
                {
                    int level = players.TryGetValue(myId, out var me) ? me.gatherLevel : 0;
                    if (level >= Defs.GatherUpgrades.Length) return null;
                    var up = Defs.GatherUpgrades[level];
                    return $"{up.name}: recolección x{up.bonus} · {Defs.FormatCost(up.cost)} · {up.time}s";
                }
                if (barHover == "reseed") return "Vuelve a sembrar la granja";
                if (barHover == "ageup")
                {
                    if (MyAge >= Defs.Ages.Length) return null;
                    var next = Defs.Ages[MyAge];
                    var unlocks = Defs.Entity.Where(kv => kv.Value.age == MyAge + 1).Select(kv => kv.Value.name);
                    return $"Avanzar a la {next.name} — {Defs.FormatCost(next.cost)} · {next.time}s\nDesbloquea: {string.Join(", ", unlocks)}\nEl centro urbano no entrena aldeanos mientras tanto";
                }
                if (!Defs.Entity.TryGetValue(barHover, out var b)) return null;
                string what = b.trains != null ? $"Entrena: {string.Join(", ", b.trains.Select(t => Defs.UnitStats(t, CivOf(myId)).name))}"
                    : b.attack != null ? $"Dispara flechas · alcance {b.attack.range}"
                    : b.dropOff ? "Deja aquí cualquier recurso · mejora la recolección"
                    : b.IsFarm ? $"{b.farmFood} comida por siembra · resembrar: {Defs.FormatCost(b.reseedCost)}"
                    : $"+{b.population} población";
                return $"{b.name} — {Defs.FormatCost(b.cost)}\n{what}";
            }
            if (hovered == null) return null;

            if (hovered.kind == PickKind.Resource)
            {
                if (!resources.TryGetValue(hovered.id, out var r)) return null;
                var label = r.r.variant == "bush" ? "Arbusto" : r.r.type == "wood" ? "Árbol" : r.r.type == "gold" ? "Mina de oro" : r.r.type == "stone" ? "Cantera de piedra" : "Oveja";
                var lines = new List<string> { $"{label} — {r.r.amount}/{r.r.max} {Defs.ResourceNames[r.r.type]}" };
                if (r.IsSheep)
                {
                    if (r.owner == null) lines.Add("Acércale una unidad para quedártela");
                    else lines.Add(r.owner == myId ? "Tuya: va hacia tu Centro urbano o Aserradero" : $"De {(players.TryGetValue(r.owner, out var op) ? op.name : "otro jugador")}");
                }
                return string.Join("\n", lines);
            }

            if (!sprites.TryGetValue(hovered.id, out var s)) return null;
            var e = s.s;
            var stats = s.stats;
            string owner = e.owner != null && players.TryGetValue(e.owner, out var pl) ? pl.name : "neutral";
            bool mine = e.owner == myId;
            players.TryGetValue(e.owner ?? "", out var po);
            string name = e.central ? "Fortaleza central" : Defs.UnitStats(e.type, EntityCiv(s)).name;
            var ls = new List<string> { $"{name} ({(mine ? "tú" : owner)}) — PV {Mathf.RoundToInt(e.hp)}/{Mathf.RoundToInt(s.MaxHp)}" };
            if (e.central)
            {
                if (e.hp <= 0) ls.Add("¡Caído! Clic derecho con un aldeano para capturarlo");
                else if (!mine) ls.Add("Baja sus PV a 0 y luego envía un aldeano para capturarlo");
                if (e.owner != null) ls.Add($"Dominado {Defs.FormatTime(e.controlTime)} / {Defs.FormatTime(C.CentralControlTime)} para ganar");
            }
            if (!mine && !e.central) ls.Add("Clic derecho con tus unidades para atacar");

            if (s.isBuilding)
            {
                if (stats.attack != null) ls.Add($"Dispara a unidades enemigas: {stats.attack.damage} daño cada {stats.attack.cooldown}s · alcance {stats.attack.range}");
                if (stats.population > 0) ls.Add($"+{stats.population} población");
                if (stats.dropOff && e.built)
                {
                    ls.Add("Los aldeanos dejan aquí cualquier recurso");
                    int level = e.owner != null && players.TryGetValue(e.owner, out var op) ? op.gatherLevel : 0;
                    if (e.researchLevel >= 0) ls.Add($"Investigando {Defs.GatherUpgrades[e.researchLevel].name}: {Mathf.FloorToInt(e.researchProgress * 100)}%");
                    else if (mine && level < Defs.GatherUpgrades.Length)
                    {
                        var up = Defs.GatherUpgrades[level];
                        ls.Add($"Selecciónalo para investigar {up.name} (recolección x{up.bonus})");
                    }
                    else if (mine) ls.Add("Todas las mejoras investigadas");
                }
                if (stats.IsFarm && e.built)
                {
                    ls.Add($"Siembra: {Mathf.RoundToInt(e.food)}/{stats.farmFood} comida");
                    if (mine && e.food > 0) ls.Add("Clic derecho con aldeanos para cultivar");
                    if (mine && e.food <= 0) ls.Add($"¡Cosecha agotada! Se resiembra sola cuando hay madera, o selecciónala para resembrar: {Defs.FormatCost(stats.reseedCost)}");
                }
                if (!e.built)
                {
                    ls.Add($"En construcción: {Mathf.FloorToInt(e.buildProgress * 100)}%");
                    if (mine) ls.Add("Clic derecho con aldeanos para ayudar a construir");
                }
                else if (mine && stats.trains != null)
                {
                    ls.Add($"Selecciónalo para entrenar: {string.Join(", ", stats.trains.Select(t => Defs.UnitStats(t, po?.civ).name))}");
                    if (e.queueLength > 0) ls.Add($"Cola: {e.queueLength}/{C.MaxTrainQueue} ({Mathf.FloorToInt(e.trainProgress * 100)}%)");
                }
            }
            else if (stats.heal != null)
                ls.Add($"Cura {stats.heal.amount} PV/s a unidades aliadas cercanas{(e.action == "healing" ? " · curando" : "")}");
            else if (e.type != "villager")
            {
                var attack = Defs.UnitStats(e.type, po?.civ).attack;
                ls.Add($"Ataque {attack.damage} · {(attack.range > 0 ? $"alcance {attack.range}" : "cuerpo a cuerpo")}{(e.action == "attacking" ? " · luchando" : "")}");
                var ability = AbilityText(attack);
                if (ability != null) ls.Add(ability);
            }
            else
            {
                if (e.action == "gathering") ls.Add($"Recolectando {Defs.ResourceNames[e.carryType ?? "wood"]}: {e.carryAmount}/{stats.carryCapacity}");
                else if (e.action == "building") ls.Add("Construyendo");
                else if (e.action == "attacking") ls.Add("Atacando");
                else if (e.carryAmount > 0) ls.Add($"Lleva {e.carryAmount} de {Defs.ResourceNames[e.carryType]}");
            }
            return string.Join("\n", ls);
        }

        // ---------- Bars over the world ----------

        // Screen point (GUI coords) of a world position and the size of one game px there
        bool ToGui(Vector3 world, float k, out Vector2 gui, out float pxSize)
        {
            var sp = rts.cam.WorldToScreenPoint(world);
            gui = new Vector2(sp.x / k, (Screen.height - sp.y) / k);
            float unitPx = Screen.height / (2 * sp.z * Mathf.Tan(rts.cam.fieldOfView * 0.5f * Mathf.Deg2Rad));
            pxSize = unitPx * C.PxToUnit / k;
            return sp.z > 0 && sp.x > -50 && sp.y > -50 && sp.x < Screen.width + 50 && sp.y < Screen.height + 50;
        }

        static void Bar(Vector2 center, float width, float height, float fraction, Color color)
        {
            var r = new Rect(center.x - width / 2, center.y, width, height);
            Skin.Rect(r, new Color(0.07f, 0.07f, 0.07f, 0.95f));
            Skin.Rect(new Rect(r.x, r.y, r.width * Mathf.Clamp01(fraction), r.height), color);
        }

        void DrawBars(float k)
        {
            foreach (var s in sprites.Values)
            {
                if (!s.active) continue;
                var e = s.s;
                if (s.isBuilding)
                {
                    float size = Defs.BuildingSize(e.type), half = size / 2;
                    bool fallen = e.central && e.hp <= 0;
                    var front = s.root.transform.position - camFwdFlat * (half + 8) * C.PxToUnit;
                    if (!ToGui(front, k, out var bottom, out var px)) continue;
                    float w = size * px, h = Mathf.Max(3, 5 * px);
                    if (s.stats.IsFarm && e.built) Bar(bottom, w, h, e.food / s.stats.farmFood, GameAssets.Hex(0xe5c04a));
                    if (!e.built) Bar(bottom, w, h, e.buildProgress, GameAssets.Hex(0xf0a030));
                    if (e.central && e.owner != null) Bar(bottom, w, h, e.controlTime / C.CentralControlTime, GameAssets.Hex(ColorOf(e.owner)));
                    if (e.researchLevel >= 0) Bar(bottom, w, h, e.researchProgress, GameAssets.Hex(0xb388ff));
                    if (e.built && e.queueLength > 0)
                    {
                        Bar(bottom, w, h, e.trainProgress, GameAssets.Hex(0x4fc3f7));
                        for (int i = 0; i < e.queueLength; i++)
                            Skin.Rect(new Rect(bottom.x - w / 2 + 2 + i * 9 * px, bottom.y + h + 3 * px, 6 * px, 6 * px), GameAssets.Hex(0x4fc3f7));
                    }
                    if (e.hp < s.MaxHp && e.built && !fallen)
                    {
                        float artH = ArtHeight(s);
                        var topWorld = s.root.transform.position + (s.model != null ? Vector3.up : billboardRot * Vector3.up) * artH;
                        if (ToGui(topWorld, k, out var top, out var px2))
                            Bar(top - new Vector2(0, 8 * px2), size * px2, Mathf.Max(3, 5 * px2), e.hp / s.MaxHp, GameAssets.Hex(0x4caf50));
                    }
                }
                else
                {
                    // Clear of the head: health right above it, the work in progress above that
                    float headH = e.type == "guard" ? 2.0f : 1.4f;
                    if (!ToGui(Feet(s) + Vector3.up * (headH + s.alt * C.PxToUnit), k, out var top, out var px)) continue;
                    float h = Mathf.Max(3, 5 * px);
                    var work = top - new Vector2(0, 8 * px);
                    if (e.action == "gathering") Bar(work, 26 * px, h, e.gatherFill, GameAssets.Hex(ResourceColors.TryGetValue(e.carryType ?? "wood", out var rc) ? rc : 0x8bc34a));
                    if (e.action == "building" && e.buildingId != null && sprites.TryGetValue(e.buildingId.Value, out var b))
                        Bar(work, 26 * px, h, b.s.buildProgress, GameAssets.Hex(0xf0a030));
                    if (e.hp < s.stats.hp) Bar(top, 24 * px, h, e.hp / s.stats.hp, GameAssets.Hex(0x4caf50));
                }
            }
        }
    }
}
