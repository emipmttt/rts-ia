using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Messages from the server (see server/GameRoom.js: details(), startPayload(), serialize(), tick()).
namespace RTS.Net
{
    public class PlayerInfo
    {
        public string id, name, faction, civ, flag;
        public int color;
        public Dictionary<string, int> stock = new Dictionary<string, int>();
        public bool defeated, connected = true;
        public int pop, popCap, gatherLevel, score;
        public int team;                 // 0 = alone, 1..4
        public int age = 1;
        public int trained, lost, kills, gathered;

        public static PlayerInfo Parse(JToken t)
        {
            var p = new PlayerInfo
            {
                id = (string)t["id"], name = (string)t["name"], faction = (string)t["faction"], civ = (string)t["civ"],
                flag = (string)t["flag"], color = (int?)t["color"] ?? 0x9e9e9e,
                defeated = (bool?)t["defeated"] ?? false, connected = (bool?)t["connected"] ?? true,
                pop = (int?)t["pop"] ?? 0, popCap = (int?)t["popCap"] ?? 0, gatherLevel = (int?)t["gatherLevel"] ?? 0, age = (int?)t["age"] ?? 1,
                score = (int?)t["score"] ?? 0, team = (int?)t["team"] ?? 0,
            };
            if (t["stock"] is JObject stock) foreach (var kv in stock) p.stock[kv.Key] = (int)(double)kv.Value;
            if (t["stats"] is JObject s)
            {
                p.trained = (int?)s["trained"] ?? 0; p.lost = (int?)s["lost"] ?? 0;
                p.kills = (int?)s["kills"] ?? 0; p.gathered = (int)((double?)s["gathered"] ?? 0);
            }
            return p;
        }
    }

    public class RoomSummary
    {
        public string id, name, status;
        public int players, max;
        public bool central = true;
        public string map = "classic";   // look of the map (shared/constants.js MAP_THEMES)
        public static RoomSummary Parse(JToken t) => new RoomSummary
        {
            id = (string)t["id"], name = (string)t["name"], status = (string)t["status"],
            players = (int?)t["players"] ?? 0, max = (int?)t["max"] ?? 5,
            central = (bool?)t["settings"]?["central"] ?? true, map = (string)t["settings"]?["map"] ?? "classic",
        };
    }

    public class RoomDetails : RoomSummary
    {
        public string hostId;
        public List<PlayerInfo> playerList = new List<PlayerInfo>();
        public static new RoomDetails Parse(JToken t)
        {
            var r = new RoomDetails
            {
                id = (string)t["id"], name = (string)t["name"], status = (string)t["status"],
                max = (int?)t["max"] ?? 5, central = (bool?)t["settings"]?["central"] ?? true, hostId = (string)t["hostId"],
                map = (string)t["settings"]?["map"] ?? "classic",
            };
            foreach (var p in (JArray)t["players"]) r.playerList.Add(PlayerInfo.Parse(p));
            r.players = r.playerList.Count;
            return r;
        }
    }

    public class ResourceInfo
    {
        public int id, tx, ty, amount, max;
        public string type, variant;
        public static ResourceInfo Parse(JToken t) => new ResourceInfo
        {
            id = (int)t["id"], type = (string)t["type"], variant = (string)t["variant"],
            tx = (int)t["tx"], ty = (int)t["ty"], amount = (int)(double)t["amount"], max = (int)(double)t["max"],
        };
    }

    public class SheepInfo
    {
        public int id, amount;
        public float x, y;
        public string owner;
    }

    public class EntityState
    {
        public int id;
        public string type, owner;
        public float x, y, hp;
        public bool burning, chilled;
        // Buildings
        public int tx, ty;
        public int cells;                // partial wall piece: bit (y - ty) * 2 + (x - tx) per tile it takes (0 = whole)
        public bool built, central;
        public float buildProgress, trainProgress, controlTime, food;
        public float? maxHp;
        public int queueLength;
        public string civ;               // neutral units and the central fortress: their own civilization
        public string[] queue = System.Array.Empty<string>(); // unit types waiting, first in training
        public int researchLevel = -1;
        public float researchProgress;
        public int ageUpTo;              // town center advancing its owner to this age (0 = not)
        public float ageUpProgress;
        // Units
        public string task, action, carryType;
        public int? buildingId, targetId, resourceId;
        public int carryAmount;
        public List<UnityEngine.Vector2> orders; // queued orders' spots (server px), our own units only
        public UnityEngine.Vector2? rally;       // building: where its new units head (server px)
        public float gatherFill;

        // Streaming twin of Parse(), the reader on the entity's StartObject; same defaults
        public static EntityState Read(JsonReader r)
        {
            var e = new EntityState();
            bool hasBuilt = false, hasProgress = false;
            while (r.Read() && r.TokenType == JsonToken.PropertyName)
            {
                var k = (string)r.Value;
                r.Read();
                switch (k)
                {
                    case "id": e.id = J.Int(r); break;
                    case "type": e.type = J.Str(r); break;
                    case "owner": e.owner = J.Str(r); break;
                    case "x": e.x = J.Float(r); break;
                    case "y": e.y = J.Float(r); break;
                    case "hp": e.hp = J.Float(r); break;
                    case "burning": e.burning = J.Bool(r); break;
                    case "chilled": e.chilled = J.Bool(r); break;
                    case "civ": e.civ = J.Str(r); break;
                    case "tx": e.tx = J.Int(r); break;
                    case "ty": e.ty = J.Int(r); break;
                    case "cells": e.cells = J.Int(r); break;
                    case "built": e.built = J.Bool(r); hasBuilt = true; break;
                    case "buildProgress": e.buildProgress = J.Float(r); hasProgress = true; break;
                    case "trainProgress": e.trainProgress = J.Float(r); break;
                    case "central": e.central = J.Bool(r); break;
                    case "controlTime": e.controlTime = J.Float(r); break;
                    case "food": e.food = J.Float(r); break;
                    case "maxHp": e.maxHp = r.TokenType == JsonToken.Null ? (float?)null : J.Float(r); break;
                    case "queue":
                        if (r.TokenType == JsonToken.StartArray)
                        {
                            var q = new List<string>();
                            while (r.Read() && r.TokenType != JsonToken.EndArray) q.Add(J.Str(r));
                            e.queue = q.ToArray();
                        }
                        break;
                    case "research":
                        if (r.TokenType != JsonToken.StartObject) break;
                        e.researchLevel = 0;
                        while (r.Read() && r.TokenType == JsonToken.PropertyName)
                        {
                            var rk = (string)r.Value; r.Read();
                            if (rk == "level") e.researchLevel = J.Int(r);
                            else if (rk == "progress") e.researchProgress = J.Float(r);
                            else r.Skip();
                        }
                        break;
                    case "ageUp":
                        if (r.TokenType != JsonToken.StartObject) break;
                        while (r.Read() && r.TokenType == JsonToken.PropertyName)
                        {
                            var ak = (string)r.Value; r.Read();
                            if (ak == "to") e.ageUpTo = J.Int(r);
                            else if (ak == "progress") e.ageUpProgress = J.Float(r);
                            else r.Skip();
                        }
                        break;
                    case "task": e.task = J.Str(r); break;
                    case "action": e.action = J.Str(r); break;
                    case "buildingId": e.buildingId = J.IntOrNull(r); break;
                    case "targetId": e.targetId = J.IntOrNull(r); break;
                    case "resourceId": e.resourceId = J.IntOrNull(r); break;
                    case "rally":
                        if (r.TokenType != JsonToken.StartArray) break;
                        r.Read(); float rx = J.Float(r);
                        r.Read(); float ry = J.Float(r);
                        while (r.Read() && r.TokenType != JsonToken.EndArray) { }
                        e.rally = new UnityEngine.Vector2(rx, ry);
                        break;
                    case "orders":
                        if (r.TokenType != JsonToken.StartArray) break;
                        e.orders = new List<UnityEngine.Vector2>();
                        while (r.Read() && r.TokenType == JsonToken.StartArray)
                        {
                            r.Read(); float ox = J.Float(r);
                            r.Read(); float oy = J.Float(r);
                            while (r.Read() && r.TokenType != JsonToken.EndArray) { }
                            e.orders.Add(new UnityEngine.Vector2(ox, oy));
                        }
                        break;
                    case "carry":
                        if (r.TokenType != JsonToken.StartObject) break;
                        while (r.Read() && r.TokenType == JsonToken.PropertyName)
                        {
                            var ck = (string)r.Value; r.Read();
                            if (ck == "type") e.carryType = J.Str(r);
                            else if (ck == "amount") e.carryAmount = J.Int(r);
                            else r.Skip();
                        }
                        break;
                    case "gatherFill": e.gatherFill = J.Float(r); break;
                    default: r.Skip(); break;
                }
            }
            if (Defs.IsBuilding(e.type))
            {
                if (!hasBuilt) e.built = true;
                if (!hasProgress) e.buildProgress = 1;
                e.queueLength = e.queue.Length;
            }
            else
            {
                // Units: Parse() leaves the building-only fields at their defaults
                e.tx = 0; e.ty = 0;
            }
            return e;
        }

        static int? Id(JToken t) => t == null || t.Type == JTokenType.Null ? (int?)null : (int)t;

        public static EntityState Parse(JToken t)
        {
            var e = new EntityState
            {
                id = (int)t["id"], type = (string)t["type"], owner = (string)t["owner"],
                x = (float)t["x"], y = (float)t["y"], hp = (float)t["hp"], burning = (bool?)t["burning"] ?? false,
                chilled = (bool?)t["chilled"] ?? false, civ = (string)t["civ"],
            };
            if (Defs.IsBuilding(e.type))
            {
                e.tx = (int)t["tx"]; e.ty = (int)t["ty"];
                e.cells = (int?)t["cells"] ?? 0;
                e.built = (bool?)t["built"] ?? true;
                e.buildProgress = (float?)t["buildProgress"] ?? 1;
                e.trainProgress = (float?)t["trainProgress"] ?? 0;
                e.central = (bool?)t["central"] ?? false;
                e.controlTime = (float?)t["controlTime"] ?? 0;
                e.food = (float?)t["food"] ?? 0;
                e.maxHp = (float?)t["maxHp"];
                e.queue = (t["queue"] as JArray)?.Select(q => (string)q).ToArray() ?? System.Array.Empty<string>();
                e.queueLength = e.queue.Length;
                if (t["rally"] is JArray ra) e.rally = new UnityEngine.Vector2((float)ra[0], (float)ra[1]);
                if (t["research"] is JObject r)
                {
                    e.researchLevel = (int?)r["level"] ?? 0;
                    e.researchProgress = (float?)r["progress"] ?? 0;
                }
                if (t["ageUp"] is JObject a)
                {
                    e.ageUpTo = (int?)a["to"] ?? 0;
                    e.ageUpProgress = (float?)a["progress"] ?? 0;
                }
            }
            else
            {
                e.task = (string)t["task"];
                e.action = (string)t["action"];
                e.buildingId = Id(t["buildingId"]);
                e.targetId = Id(t["targetId"]);
                if (t["orders"] is JArray queued) e.orders = queued.Select(q => new UnityEngine.Vector2((float)q[0], (float)q[1])).ToList();
                e.resourceId = Id(t["resourceId"]);
                if (t["carry"] is JObject c)
                {
                    e.carryType = (string)c["type"];
                    e.carryAmount = (int)((double?)c["amount"] ?? 0);
                }
                e.gatherFill = (float?)t["gatherFill"] ?? 0;
            }
            return e;
        }
    }

    public class Shot
    {
        public float x, y, radius;
        public float? tx, ty;           // end of a geomancer's line of spikes
        public int? targetId, attackerId;
        public string kind, element;    // element: the attacker's civilization (blasts)
        public bool fire;
        public static Shot Parse(JToken t) => new Shot
        {
            x = (float)t["x"], y = (float)t["y"], targetId = (int?)t["targetId"], attackerId = (int?)t["attackerId"],
            kind = (string)t["kind"], radius = (float?)t["radius"] ?? 0, fire = (bool?)t["fire"] ?? false,
            tx = (float?)t["tx"], ty = (float?)t["ty"], element = (string)t["element"],
        };
    }

    public static class Parse
    {
        public static List<SheepInfo> Sheep(JToken t)
        {
            var list = new List<SheepInfo>();
            if (t is JArray arr)
                foreach (var s in arr)
                    list.Add(new SheepInfo { id = (int)s["id"], x = (float)s["x"], y = (float)s["y"], owner = (string)s["owner"], amount = (int)(double)s["amount"] });
            return list;
        }
    }

    // One game:state. Read straight from the JSON text (no JToken tree for the entities): a big battle
    // sends hundreds of entities 20 times a second, and building the tree made the garbage collector
    // stall the web build.
    public class StateMsg
    {
        public List<PlayerInfo> players = new List<PlayerInfo>();
        public List<SheepInfo> sheep = new List<SheepInfo>();
        public List<EntityState> entities = new List<EntityState>();

        // From an already parsed object (the menu backdrop builds its states as JSON)
        public static StateMsg From(JToken state)
        {
            var m = new StateMsg { sheep = Parse.Sheep(state["sheep"]) };
            foreach (var p in (JArray)state["players"]) m.players.Add(PlayerInfo.Parse(p));
            foreach (var t in (JArray)state["entities"]) m.entities.Add(EntityState.Parse(t));
            return m;
        }

        // From the raw socket.io frame body: ["game:state",{players,sheep,entities}]
        public static StateMsg Read(string frame)
        {
            var m = new StateMsg();
            using var r = new JsonTextReader(new System.IO.StringReader(frame));
            r.Read(); // [
            r.Read(); // "game:state"
            r.Read(); // {
            while (r.Read() && r.TokenType == JsonToken.PropertyName)
            {
                var name = (string)r.Value;
                r.Read();
                if (name == "entities" && r.TokenType == JsonToken.StartArray)
                {
                    m.entities.Capacity = 256;
                    while (r.Read() && r.TokenType == JsonToken.StartObject) m.entities.Add(EntityState.Read(r));
                }
                else if (name == "players" && r.TokenType == JsonToken.StartArray)
                {
                    foreach (var p in (JArray)JToken.ReadFrom(r)) m.players.Add(PlayerInfo.Parse(p));
                }
                else if (name == "sheep" && r.TokenType == JsonToken.StartArray)
                {
                    while (r.Read() && r.TokenType == JsonToken.StartObject)
                    {
                        var sh = new SheepInfo();
                        while (r.Read() && r.TokenType == JsonToken.PropertyName)
                        {
                            var k = (string)r.Value;
                            r.Read();
                            switch (k)
                            {
                                case "id": sh.id = J.Int(r); break;
                                case "x": sh.x = J.Float(r); break;
                                case "y": sh.y = J.Float(r); break;
                                case "owner": sh.owner = J.Str(r); break;
                                case "amount": sh.amount = J.Int(r); break;
                                default: r.Skip(); break;
                            }
                        }
                        m.sheep.Add(sh);
                    }
                }
                else r.Skip();
            }
            return m;
        }
    }

    // Value helpers for a JsonTextReader positioned on a value
    static class J
    {
        public static float Float(JsonReader r) => r.TokenType switch
        {
            JsonToken.Integer => (long)r.Value,
            JsonToken.Float => (float)(double)r.Value,
            _ => 0,
        };
        public static int Int(JsonReader r) => r.TokenType switch
        {
            JsonToken.Integer => (int)(long)r.Value,
            JsonToken.Float => (int)(double)r.Value,
            _ => 0,
        };
        public static int? IntOrNull(JsonReader r) => r.TokenType == JsonToken.Null ? (int?)null : Int(r);
        public static bool Bool(JsonReader r) => r.TokenType == JsonToken.Boolean && (bool)r.Value;
        public static string Str(JsonReader r) => r.TokenType == JsonToken.String ? (string)r.Value : null;
    }
}
