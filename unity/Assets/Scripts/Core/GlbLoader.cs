using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;

// Minimal binary glTF (.glb) loader for the game's static models: meshes with POSITION / NORMAL /
// TEXCOORD_0 and indices, node TRS hierarchies and one embedded base-colour texture per material.
// glTF is right-handed (+Z forward); Unity is left-handed, so X is mirrored and triangles flipped.
// Models live in Resources as `.bytes` (e.g. Resources/models/center.bytes).
namespace RTS
{
    public static class GlbLoader
    {
        public class Model
        {
            public List<(Mesh mesh, Matrix4x4 matrix, int material)> parts = new List<(Mesh, Matrix4x4, int)>();
            public List<Texture2D> materialTextures = new List<Texture2D>();
            public List<Texture2D> materialNormals = new List<Texture2D>();
            public List<bool> materialDoubleSided = new List<bool>();
            public Bounds bounds;
            public Vector3 top;         // highest vertex (tip of the tallest spire)
        }

        static readonly Dictionary<string, Model> cache = new Dictionary<string, Model>();

        public static Model Load(string resource)
        {
            if (cache.TryGetValue(resource, out var m)) return m;
            var asset = Resources.Load<TextAsset>(resource);
            if (asset == null) { Debug.LogWarning($"Missing model {resource}"); return null; }
            m = Parse(asset.bytes);
            cache[resource] = m;
            return m;
        }

        static readonly Dictionary<string, bool> exists = new Dictionary<string, bool>();

        public static bool Exists(string resource)
        {
            if (!exists.TryGetValue(resource, out var found)) exists[resource] = found = Resources.Load<TextAsset>(resource) != null;
            return found;
        }

        static Model Parse(byte[] glb)
        {
            if (BitConverter.ToUInt32(glb, 0) != 0x46546C67) throw new Exception("Not a GLB file");
            int jsonLen = BitConverter.ToInt32(glb, 12);
            var json = JObject.Parse(Encoding.UTF8.GetString(glb, 20, jsonLen));
            int binStart = 20 + jsonLen + 8;

            var views = (JArray)json["bufferViews"];
            var accessors = (JArray)json["accessors"];
            int ViewOffset(int view) => binStart + ((int?)views[view]["byteOffset"] ?? 0);

            float[] Floats(int accessor, int comps)
            {
                var a = accessors[accessor];
                int count = (int)a["count"];
                int view = (int)a["bufferView"];
                int stride = (int?)views[view]["byteStride"] ?? comps * 4;
                int start = ViewOffset(view) + ((int?)a["byteOffset"] ?? 0);
                var r = new float[count * comps];
                for (int i = 0; i < count; i++)
                    for (int c = 0; c < comps; c++)
                        r[i * comps + c] = BitConverter.ToSingle(glb, start + i * stride + c * 4);
                return r;
            }

            int[] Indices(int accessor)
            {
                var a = accessors[accessor];
                int count = (int)a["count"];
                int type = (int)a["componentType"];
                int start = ViewOffset((int)a["bufferView"]) + ((int?)a["byteOffset"] ?? 0);
                var r = new int[count];
                for (int i = 0; i < count; i++)
                    r[i] = type == 5125 ? (int)BitConverter.ToUInt32(glb, start + i * 4)
                        : type == 5123 ? BitConverter.ToUInt16(glb, start + i * 2)
                        : glb[start + i];
                return r;
            }

            var model = new Model();

            // Materials: base colour texture (embedded PNG/JPEG) and double-sidedness
            var images = (JArray)json["images"];
            var textures = (JArray)json["textures"];
            var imageCache = new Dictionary<int, Texture2D>();
            Texture2D Image(int? texIndex, bool linear)
            {
                if (texIndex == null) return null;
                int img = (int)textures[texIndex.Value]["source"];
                if (imageCache.TryGetValue(img, out var tex)) return tex;
                var view = (int)images[img]["bufferView"];
                var bytes = new byte[(int)views[view]["byteLength"]];
                Buffer.BlockCopy(glb, ViewOffset(view), bytes, 0, bytes.Length);
                // The game's models are pixel art: sharp texels, no mipmap blur. Normal maps are linear data
                tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, linear) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Point };
                tex.LoadImage(bytes, false);
                tex.filterMode = FilterMode.Point;
                return imageCache[img] = tex;
            }
            foreach (var mat in (JArray)json["materials"] ?? new JArray())
            {
                model.materialTextures.Add(Image((int?)mat["pbrMetallicRoughness"]?["baseColorTexture"]?["index"], false));
                model.materialNormals.Add(Image((int?)mat["normalTexture"]?["index"], true));
                model.materialDoubleSided.Add((bool?)mat["doubleSided"] ?? false);
            }

            // Meshes, one Unity mesh per primitive
            var meshes = new List<List<(Mesh, int)>>();
            foreach (var mesh in (JArray)json["meshes"])
            {
                var prims = new List<(Mesh, int)>();
                foreach (var p in (JArray)mesh["primitives"])
                {
                    var attr = p["attributes"];
                    var pos = Floats((int)attr["POSITION"], 3);
                    int n = pos.Length / 3;
                    var verts = new Vector3[n];
                    for (int i = 0; i < n; i++) verts[i] = new Vector3(-pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                    var m = new Mesh { name = (string)mesh["name"], indexFormat = n > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
                    m.vertices = verts;
                    if (attr["NORMAL"] != null)
                    {
                        var nr = Floats((int)attr["NORMAL"], 3);
                        var normals = new Vector3[n];
                        for (int i = 0; i < n; i++) normals[i] = new Vector3(-nr[i * 3], nr[i * 3 + 1], nr[i * 3 + 2]);
                        m.normals = normals;
                    }
                    if (attr["TEXCOORD_0"] != null)
                    {
                        var uv = Floats((int)attr["TEXCOORD_0"], 2);
                        var uvs = new Vector2[n];
                        for (int i = 0; i < n; i++) uvs[i] = new Vector2(uv[i * 2], 1 - uv[i * 2 + 1]);
                        m.uv = uvs;
                    }
                    var white = new Color32[n];
                    for (int i = 0; i < n; i++) white[i] = new Color32(255, 255, 255, 255);
                    m.colors32 = white;
                    int[] idx;
                    if (p["indices"] != null) idx = Indices((int)p["indices"]);
                    else { idx = new int[n]; for (int i = 0; i < n; i++) idx[i] = i; }
                    for (int i = 0; i + 2 < idx.Length; i += 3) (idx[i + 1], idx[i + 2]) = (idx[i + 2], idx[i + 1]);
                    m.triangles = idx;
                    if (attr["NORMAL"] == null) m.RecalculateNormals();
                    if (attr["TEXCOORD_0"] != null) m.RecalculateTangents();
                    m.SetUVs(3, SmoothNormals(m));
                    m.RecalculateBounds();
                    prims.Add((m, (int?)p["material"] ?? -1));
                }
                meshes.Add(prims);
            }

            // Nodes: walk the scene hierarchy accumulating transforms
            var nodes = (JArray)json["nodes"];
            bool first = true;
            model.top = new Vector3(0, float.MinValue, 0);
            void Walk(int index, Matrix4x4 parent)
            {
                var node = nodes[index];
                Matrix4x4 local;
                if (node["matrix"] is JArray mat)
                {
                    local = new Matrix4x4();
                    for (int i = 0; i < 16; i++) local[i % 4, i / 4] = (float)mat[i];
                    // Mirror X on both sides: S * M * S
                    var s = Matrix4x4.Scale(new Vector3(-1, 1, 1));
                    local = s * local * s;
                }
                else
                {
                    var t = node["translation"] is JArray ta ? new Vector3(-(float)ta[0], (float)ta[1], (float)ta[2]) : Vector3.zero;
                    var r = node["rotation"] is JArray ra ? new Quaternion((float)ra[0], -(float)ra[1], -(float)ra[2], (float)ra[3]) : Quaternion.identity;
                    var sc = node["scale"] is JArray sa ? new Vector3((float)sa[0], (float)sa[1], (float)sa[2]) : Vector3.one;
                    local = Matrix4x4.TRS(t, r, sc);
                }
                var world = parent * local;
                if (node["mesh"] != null)
                    foreach (var (mesh, material) in meshes[(int)node["mesh"]])
                    {
                        model.parts.Add((mesh, world, material));
                        foreach (var vtx in mesh.vertices)
                        {
                            var p = world.MultiplyPoint3x4(vtx);
                            if (p.y > model.top.y) model.top = p;
                        }
                        var b = mesh.bounds;
                        for (int c = 0; c < 8; c++)
                        {
                            var corner = world.MultiplyPoint3x4(b.center + Vector3.Scale(b.extents, new Vector3(c & 1, (c >> 1) & 1, (c >> 2) & 1) * 2 - Vector3.one));
                            if (first) { model.bounds = new Bounds(corner, Vector3.zero); first = false; }
                            else model.bounds.Encapsulate(corner);
                        }
                    }
                if (node["children"] is JArray children) foreach (var c in children) Walk((int)c, world);
            }
            var scene = json["scenes"][(int?)json["scene"] ?? 0];
            foreach (var n in (JArray)scene["nodes"]) Walk((int)n, Matrix4x4.identity);
            return model;
        }

        // The faces are flat-shaded (corners are split per face): normals averaged over every corner at
        // the same spot, for the outline shell to grow without gaps (stored in UV channel 3)
        static List<Vector3> SmoothNormals(Mesh m)
        {
            var verts = m.vertices;
            var normals = m.normals;
            var sums = new Dictionary<Vector3Int, Vector3>();
            Vector3Int Key(Vector3 v) => new Vector3Int(Mathf.RoundToInt(v.x * 1000), Mathf.RoundToInt(v.y * 1000), Mathf.RoundToInt(v.z * 1000));
            for (int i = 0; i < verts.Length; i++)
            {
                var k = Key(verts[i]);
                sums[k] = (sums.TryGetValue(k, out var s) ? s : Vector3.zero) + normals[i];
            }
            var result = new List<Vector3>(verts.Length);
            for (int i = 0; i < verts.Length; i++)
            {
                var n = sums[Key(verts[i])];
                result.Add(n.sqrMagnitude > 1e-6f ? n.normalized : normals[i]);
            }
            return result;
        }

        // Instantiates the model under `parent`, scaled so its widest side measures `width` units,
        // centred on the parent with its base on the parent's origin
        public static GameObject Instantiate(Model model, Transform parent, float width, Func<Texture2D, Texture2D, bool, Material> materialFor)
        {
            var root = new GameObject("Model");
            root.transform.SetParent(parent, false);
            var fit = Fit(model, width);
            var materials = new Dictionary<int, Material>();
            foreach (var (mesh, matrix, material) in model.parts)
            {
                var m = fit * matrix;
                var go = new GameObject(mesh.name);
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = m.GetColumn(3);
                go.transform.localRotation = m.rotation;
                go.transform.localScale = m.lossyScale;
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                var mr = go.AddComponent<MeshRenderer>();
                if (!materials.TryGetValue(material, out var mat))
                {
                    var tex = material >= 0 ? model.materialTextures[material] : null;
                    var normal = material >= 0 ? model.materialNormals[material] : null;
                    bool doubleSided = material >= 0 && model.materialDoubleSided[material];
                    materials[material] = mat = materialFor(tex, normal, doubleSided);
                }
                mr.sharedMaterial = mat;
                mr.shadowCastingMode = ShadowCastingMode.On;
                mr.receiveShadows = true;
            }
            return root;
        }

        // Model space -> the instance's local space: scaled to `width`, centred, base at y = 0
        static Matrix4x4 Fit(Model model, float width)
        {
            var b = model.bounds;
            float scale = width / Mathf.Max(b.size.x, b.size.z);
            return Matrix4x4.Scale(Vector3.one * scale) * Matrix4x4.Translate(new Vector3(-b.center.x, -b.min.y, -b.center.z));
        }

        // Tip of the model in the instance's local space (where a flag goes)
        public static Vector3 Top(Model model, float width) => Fit(model, width).MultiplyPoint3x4(model.top);

        public static float Height(Model model, float width) => model.bounds.size.y * width / Mathf.Max(model.bounds.size.x, model.bounds.size.z);
    }
}
