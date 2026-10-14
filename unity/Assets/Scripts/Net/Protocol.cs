using System.Collections.Generic;
using System.Linq;
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
        public static RoomSummary Parse(JToken t) => new RoomSummary
        {
            id = (string)t["id"], name = (string)t["name"], status = (string)t["status"],
            players = (int?)t["players"] ?? 0, max = (int?)t["max"] ?? 5,
            central = (bool?)t["settings"]?["central"] ?? true,
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
        public float gatherFill;

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
                e.built = (bool?)t["built"] ?? true;
                e.buildProgress = (float?)t["buildProgress"] ?? 1;
                e.trainProgress = (float?)t["trainProgress"] ?? 0;
                e.central = (bool?)t["central"] ?? false;
                e.controlTime = (float?)t["controlTime"] ?? 0;
                e.food = (float?)t["food"] ?? 0;
                e.maxHp = (float?)t["maxHp"];
                e.queue = (t["queue"] as JArray)?.Select(q => (string)q).ToArray() ?? System.Array.Empty<string>();
                e.queueLength = e.queue.Length;
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
}
