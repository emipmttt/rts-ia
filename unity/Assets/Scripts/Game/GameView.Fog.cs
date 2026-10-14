using System.Collections.Generic;
using UnityEngine;
using RTS.World;

// Fog of war and culling. What the player's units and buildings see is lit; enemy units elsewhere
// are hidden, enemy buildings stay as they were last seen (even after being destroyed, until the
// spot is looked at again), trees and mines show once explored. Anything hidden is deactivated
// (sprites, models, shadows, particles); things off screen just skip their per-frame animation.
namespace RTS.Game
{
    public partial class GameView
    {
        const float CullMargin = 2; // world units around the view still drawn
        const float UnfinishedSight = 0.6f;

        FogOfWar fog;
        readonly Plane[] frustum = new Plane[6];
        readonly List<int> forgotten = new List<int>();

        bool Spectating => !players.TryGetValue(myId, out var me) || me.defeated;

        // Recompute what the player sees (a few times per second) and ease the fog toward it
        void UpdateFog(float dt)
        {
            GeometryUtility.CalculateFrustumPlanes(rts.cam, frustum);
            if (fog.Due)
            {
                fog.RevealAll = Spectating;
                fog.Begin();
                foreach (var s in sprites.Values)
                {
                    if (s.s.owner != myId || s.gone) continue;
                    float sight = Defs.Sight(s.s.type);
                    if (s.isBuilding && !s.s.built) sight *= UnfinishedSight;
                    fog.Reveal(s.gx, s.gy, sight);
                }
                foreach (var r in resources.Values)
                    if (r.IsSheep && r.owner == myId) fog.Reveal(r.gx, r.gy, Defs.SheepSight);
                fog.End();
                RefreshSight();
            }
            fog.Animate(dt);
        }

        void RefreshSight()
        {
            forgotten.Clear();
            foreach (var kv in sprites)
            {
                var s = kv.Value;
                s.inSight = s.s.owner == myId && !s.gone
                    || (s.isBuilding ? fog.VisibleArea(s.s.x, s.s.y, Defs.BuildingSize(s.s.type) / 2) : fog.Visible(s.gx, s.gy));
                // The central town center is everyone's objective: always on the map, like a wonder
                if (s.isBuilding && (s.inSight || s.s.central)) s.seen = true;
                // A building destroyed out of sight disappears once the player looks there again
                if (s.gone && s.inSight) forgotten.Add(kv.Key);
                else if (!s.inSight && !s.isBuilding) selected.Remove(kv.Key);
            }
            foreach (var id in forgotten)
            {
                UnregisterWall(sprites[id]);
                Destroy(sprites[id].root);
                sprites.Remove(id);
                selected.Remove(id);
            }
            // Trees, mines and bushes once explored; sheep only while in sight (or ours)
            foreach (var r in resources.Values)
            {
                bool show = r.IsSheep ? r.owner == myId || fog.Visible(r.gx, r.gy) : fog.Explored(r.gx, r.gy);
                if (show == r.active) continue;
                r.active = show;
                r.root.SetActive(show);
            }
        }

        // On the map for the player: in sight, or a building remembered as last seen
        bool Known(EntityView s) => s.inSight || s.isBuilding && s.seen;

        // Box around a world point inside (or just around) the camera view, stretched over the shadow
        // it casts so shadows falling into view don't pop as the camera pans
        bool NearView(Vector3 center, Vector3 size)
        {
            var b = new Bounds(center, size + Vector3.one * (CullMargin * 2));
            var sun = RenderSettings.sun;
            if (sun != null && sun.transform.forward.y < -0.1f)
            {
                var top = center + Vector3.up * size.y / 2;
                var l = sun.transform.forward;
                b.Encapsulate(top + l * ((top.y - (center.y - size.y / 2)) / -l.y));
            }
            return GeometryUtility.TestPlanesAABB(frustum, b);
        }

        bool NearView(EntityView s)
        {
            if (s.isBuilding)
            {
                float w = Defs.BuildingSize(s.s.type) * C.PxToUnit * 2;
                float h = ArtHeight(s) + 3;
                return NearView(s.root.transform.position + Vector3.up * h / 2, new Vector3(w, h, w));
            }
            return NearView(ground.ToWorld(s.gx, s.gy) + Vector3.up * (1 + s.alt * C.PxToUnit), new Vector3(1.5f, 2.5f, 1.5f));
        }

        // Shows or hides the whole object (sprite, model, flag, fire, slab, shadows)
        static void SetActive(EntityView s, bool show)
        {
            if (s.active == show) return;
            s.active = show;
            s.root.SetActive(show);
        }

        // Effects and sounds only happen where the player can see (server px / world position)
        bool InSight(float x, float y) => fog == null || fog.Visible(x, y);
        bool InSight(Vector3 world)
        {
            var p = Ground.ToServer(world);
            return InSight(p.x, p.y);
        }

        // Buildings can only be placed on explored ground
        bool FootprintExplored(string type, int tx, int ty)
        {
            foreach (var (x, y) in Defs.Footprint(type, tx, ty))
                if (!fog.ExploredTile(x, y)) return false;
            return true;
        }
    }
}
