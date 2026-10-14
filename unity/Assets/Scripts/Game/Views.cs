using UnityEngine;
using RTS.Net;

// Scene objects for things the server sends: units and buildings (EntityView) and resources
// (ResourceView). Each keeps the latest server state plus everything needed to draw it.
namespace RTS.Game
{
    public class EntityView
    {
        public EntityState s;           // latest server state
        public float gx, gy;            // interpolated position (server px)
        public bool isBuilding;
        public Stats stats;

        // Fog of war and culling
        public bool inSight;            // the player sees it right now (always for their own)
        public bool seen;               // a building spotted once stays on the map as last seen
        public bool gone;               // destroyed out of sight: kept as last seen until looked at
        public bool active = true;      // drawn (in sight, or a building remembered as last seen)
        public float push;              // how hard it bends the grass it stands in (eased)

        public GameObject root;         // on the ground at (gx, gy)
        public Transform billboard;     // faces the camera
        public SpriteRenderer sprite;

        // Animation
        public Sprite[] frames;
        public float animTime, frameDuration = 0.1f;
        public int frame, lastFrame = -1;
        public int? stepFrame;          // stepped animations (flyer takeoff/attack) follow game timing
        public string anim = "", view = "front", shownView = "";
        public int facing = 1;
        public float hitAt = -10;
        public float lastSound;

        // Flyer
        public float alt;
        public string flyAnim = "idle";
        public string lastAction;       // last frame's action (sounds when one starts)
        public bool wasChilled, doorWasOpen;
        public bool wasFlying, launched;
        public float takeoffAt = -10, lastBlast = -10;

        // Earth/water surfer
        public GameObject slab;         // rock or ice slab it rides
        public Vector3 rideDir = Vector3.forward;

        // Buildings
        public SpriteRenderer fire;
        public Light fireLight;
        public Sprite[] fireFrames;
        public bool? wasBuilt;
        public GameObject fields;
        public Material fieldsMaterial;
        public Texture2D fieldsTexture;
        public string fieldsKey;
        public SpriteRenderer crown;
        public string textureName, shownFaction;
        public GameObject model;        // 3D model replacing the sprite (town center)
        public float modelHeight;
        public Vector3 modelTop;        // tip of its tallest spire in the model's local space (flag)
        public int modelColor;          // team colour its roofs are painted in
        public string modelPath;        // resource it was built from (per civilization)
        public Renderer[] modelRenderers;
        public MaterialPropertyBlock modelProps;
        public float ageAnimAt = -10;   // when it was rebuilt in its owner's new age
        public int wallMask = -1;       // walls: joined neighbours (GameView.WallMask)
        public Transform door;          // gates: the door node, sinking to open
        public Vector3 doorBase;
        public float doorOpen;

        // Flag
        public GameObject flag;
        public Transform flagCloth;
        public string flagOwner;

        public float Radius => isBuilding ? Defs.BuildingSize(s.type) / 2 : stats.radius;
        public float MaxHp => s.maxHp ?? stats.hp;
    }

    public class ResourceView
    {
        public ResourceInfo r;
        public float x, y;              // server px (sheep move)
        public float gx, gy;            // interpolated (sheep)
        public string owner;            // sheep only
        public GameObject root;
        public Transform billboard;
        public SpriteRenderer sprite;
        public Sprite[] frames;
        public float animTime, fps;
        public bool crossed;            // two sprites in a cross (bushes) instead of a billboard
        public GameObject model;        // 3D model instead of the sprite (gold and stone)
        public Renderer[] modelRenderers;
        public bool active = true;      // explored (sheep: in sight) and so drawn
        public bool IsSheep => r.variant == "sheep";
    }
}
