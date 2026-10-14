using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// Pictures of the 3D building models for the UI (build menu): the model is placed far below the map
// for one frame, lit by the sun, and rendered from the front-left by a hidden orthographic camera
// into a transparent texture that is kept and reused.
namespace RTS
{
    public static class ModelIcons
    {
        const int Size = 160;
        const int Layer = 31;
        static readonly Vector3 Stage = new Vector3(0, -2000, 0);
        static readonly Dictionary<string, RenderTexture> cache = new Dictionary<string, RenderTexture>();
        static Camera cam;

        public static bool TryGet(string key, out Texture texture)
        {
            RenderTexture rt = null;
            bool ok = key != null && cache.TryGetValue(key, out rt) && rt != null && rt.IsCreated();
            texture = rt;
            return ok;
        }

        // Renders `path` with team green swapped for `teamColor`; call outside OnGUI (from Update)
        public static Texture Render(string key, string path, int teamColor)
        {
            if (TryGet(key, out var existing)) return existing;
            var model = GlbLoader.Load(path);
            if (model == null) return null;
            var holder = new GameObject("Icon " + key);
            holder.transform.position = Stage;
            var go = GlbLoader.Instantiate(model, holder.transform, 1, (tex, normal, ds) => Materials.Model(GameAssets.TeamRecolor(tex, teamColor), normal, ds));
            go.transform.localRotation = Quaternion.Euler(0, 180, 0); // front toward the camera, as in game
            var renderers = go.GetComponentsInChildren<Renderer>();
            foreach (var r in renderers) { r.gameObject.layer = Layer; r.shadowCastingMode = ShadowCastingMode.Off; }

            if (cam == null)
            {
                var camGo = new GameObject("Icon camera");
                cam = camGo.AddComponent<Camera>();
                cam.enabled = false;
                cam.orthographic = true;
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = new Color(0, 0, 0, 0);
                cam.cullingMask = 1 << Layer;
                cam.nearClipPlane = 0.1f;
                cam.farClipPlane = 50;
                Object.DontDestroyOnLoad(camGo);
            }
            // Frame the model from the front-left and above, like the game camera
            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);
            cam.transform.rotation = Quaternion.Euler(30, 25, 0);
            cam.transform.position = bounds.center - cam.transform.forward * 20;
            float extent = 0;
            for (int c = 0; c < 8; c++)
            {
                var corner = bounds.center + Vector3.Scale(bounds.extents, new Vector3(c & 1, (c >> 1) & 1, (c >> 2) & 1) * 2 - Vector3.one);
                var local = cam.transform.InverseTransformPoint(corner);
                extent = Mathf.Max(extent, Mathf.Abs(local.x), Mathf.Abs(local.y));
            }
            cam.orthographicSize = extent * 1.06f;

            var rt = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32) { name = "Icon " + key, antiAliasing = 4 };
            rt.Create();
            cam.targetTexture = rt;
            // No fog of war down here
            var fog = Shader.GetGlobalVector("_FogOfWarParams");
            Shader.SetGlobalVector("_FogOfWarParams", Vector4.zero);
            cam.Render();
            Shader.SetGlobalVector("_FogOfWarParams", fog);
            cam.targetTexture = null;
            // Destroy only happens at the end of the frame: hide it now or the next icon rendered
            // this frame would show this model too
            holder.SetActive(false);
            Object.Destroy(holder);
            cache[key] = rt;
            return rt;
        }
    }
}
