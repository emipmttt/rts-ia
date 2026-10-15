using UnityEngine;
using RTS.World;

// Perspective RTS camera orbiting a focus point on the ground. Zooming in also lowers the pitch so
// close-ups look across the hills; Q/E (or dragging with the middle button) turns it around.
namespace RTS.Game
{
    public class RtsCamera
    {
        public const float MinDistance = 8, MaxDistance = 46;
        public readonly Camera cam;
        readonly Ground ground;
        Vector2 focus; // world x, z
        float focusY;
        float distance = 20, targetDistance = 20;
        float yaw, targetYaw;
        public float Shake;
        public float Yaw => yaw;
        public float Distance => distance;
        public float Pitch => Mathf.Lerp(38, 60, Mathf.InverseLerp(MinDistance, MaxDistance, distance));
        // Billboards lean back by part of the pitch so they read well from above without lying down
        public float SpriteTilt => Pitch * 0.42f;

        public RtsCamera(Camera cam, Ground ground)
        {
            this.cam = cam;
            this.ground = ground;
            focus = new Vector2(ground.N / 2f, -ground.N / 2f);
        }

        // Centre on server px (x, y)
        public void FocusOn(float x, float y)
        {
            focus = new Vector2(x * C.PxToUnit, -y * C.PxToUnit);
            Clamp();
        }

        public Vector2 FocusServer => new Vector2(focus.x * C.TileSize, -focus.y * C.TileSize);

        public void Pan(Vector2 screenDir, float dt)
        {
            // Faster when zoomed out, like the 2D client's screen-space panning
            float speed = distance * 1.1f;
            var right = new Vector2(Mathf.Cos(yaw * Mathf.Deg2Rad), -Mathf.Sin(yaw * Mathf.Deg2Rad));
            var forward = new Vector2(Mathf.Sin(yaw * Mathf.Deg2Rad), Mathf.Cos(yaw * Mathf.Deg2Rad));
            focus += (right * screenDir.x + forward * screenDir.y) * speed * dt;
            Clamp();
        }

        // Drag-pan by a screen-space pixel delta, keeping the ground under the cursor
        public void DragPan(Vector2 pixelDelta)
        {
            float k = distance * 2 * Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad) / Screen.height;
            var right = new Vector2(Mathf.Cos(yaw * Mathf.Deg2Rad), -Mathf.Sin(yaw * Mathf.Deg2Rad));
            var forward = new Vector2(Mathf.Sin(yaw * Mathf.Deg2Rad), Mathf.Cos(yaw * Mathf.Deg2Rad));
            focus -= (right * pixelDelta.x + forward * pixelDelta.y / Mathf.Sin(Pitch * Mathf.Deg2Rad)) * k;
            Clamp();
        }

        // Cinematic shots (menu backdrop): look at server px (x, y) from `yaw` at `dist`; `instant` cuts
        // there, otherwise it eases over like the player's own camera moves
        public void SetShot(float x, float y, float yawDeg, float dist, bool instant)
        {
            focus = new Vector2(x * C.PxToUnit, -y * C.PxToUnit);
            targetYaw = yawDeg;
            targetDistance = Mathf.Clamp(dist, MinDistance * 0.7f, MaxDistance);
            if (instant) { yaw = targetYaw; distance = targetDistance; focusY = Mathf.Max(Ground.WaterLevel, ground.HeightAtTile(focus.x, -focus.y)); }
        }

        public void Zoom(float factor) => targetDistance = Mathf.Clamp(targetDistance / factor, MinDistance, MaxDistance);
        public void Rotate(float degrees) => targetYaw += degrees;

        void Clamp()
        {
            float n = ground.N;
            focus.x = Mathf.Clamp(focus.x, -2, n + 2);
            focus.y = Mathf.Clamp(focus.y, -n - 2, 2);
        }

        public void Update(float dt)
        {
            distance = Mathf.Lerp(distance, targetDistance, 1 - Mathf.Exp(-dt * 12));
            yaw = Mathf.LerpAngle(yaw, targetYaw, 1 - Mathf.Exp(-dt * 10));
            float groundY = Mathf.Max(Ground.WaterLevel, ground.HeightAtTile(focus.x, -focus.y));
            focusY = Mathf.Lerp(focusY, groundY, 1 - Mathf.Exp(-dt * 6));
            var rot = Quaternion.Euler(Pitch, yaw, 0);
            var target = new Vector3(focus.x, focusY, focus.y);
            var pos = target - rot * Vector3.forward * distance;
            if (Shake > 0)
            {
                Shake -= dt;
                pos += Random.insideUnitSphere * Mathf.Max(0, Shake) * 0.45f;
            }
            cam.transform.SetPositionAndRotation(pos, rot);
        }

        // Point on the ground under a screen position (riverbeds count as the water surface)
        public bool GroundPoint(Vector2 screen, out Vector3 point)
        {
            var ray = cam.ScreenPointToRay(screen);
            point = default;
            if (Physics.Raycast(ray, out var hit, 2000))
            {
                point = hit.point;
                if (point.y < Ground.WaterLevel && ray.direction.y < 0)
                {
                    float t = (Ground.WaterLevel - ray.origin.y) / ray.direction.y;
                    point = ray.origin + ray.direction * t;
                }
                return true;
            }
            if (ray.direction.y >= 0) return false;
            float d = (Ground.WaterLevel - ray.origin.y) / ray.direction.y;
            point = ray.origin + ray.direction * d;
            return true;
        }
    }
}
