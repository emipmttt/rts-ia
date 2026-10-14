using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// An immediate-mode batch of coloured quads rebuilt every frame into one mesh: the 3D equivalent of
// the 2D client's Graphics layers. Billboard pixels face the camera (wind, embers, sparks); ground
// quads lie on the terrain (selection rings, building footprints, order markers, range circles).
namespace RTS.World
{
    public class PixelBatch : MonoBehaviour
    {
        readonly List<Vector3> verts = new List<Vector3>();
        readonly List<Color32> colors = new List<Color32>();
        readonly List<int> tris = new List<int>();
        Mesh mesh;
        public Ground ground;
        public Camera cam;

        public static PixelBatch Create(string name, Transform parent, Material material, Ground ground, Camera cam)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var b = go.AddComponent<PixelBatch>();
            b.ground = ground;
            b.cam = cam;
            b.mesh = new Mesh { indexFormat = IndexFormat.UInt32, name = name };
            b.mesh.MarkDynamic();
            go.AddComponent<MeshFilter>().sharedMesh = b.mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = material;
            mr.shadowCastingMode = ShadowCastingMode.Off;
            mr.receiveShadows = false;
            return b;
        }

        void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, Color32 col)
        {
            int i = verts.Count;
            verts.Add(a); verts.Add(b); verts.Add(c); verts.Add(d);
            colors.Add(col); colors.Add(col); colors.Add(col); colors.Add(col);
            tris.Add(i); tris.Add(i + 1); tris.Add(i + 2);
            tris.Add(i); tris.Add(i + 2); tris.Add(i + 3);
        }

        // A square pixel of side `size` (world units) facing the camera
        public void Pixel(Vector3 p, float size, Color col)
        {
            var t = cam.transform;
            var r = t.right * (size / 2);
            var u = t.up * (size / 2);
            Quad(p - r - u, p - r + u, p + r + u, p + r - u, col);
        }

        // Axis-aligned rectangle on the ground; (x, y) server px, size in px. Follows the slope.
        public void GroundRect(float x, float y, float w, float h, Color col, float lift = 0.03f)
        {
            var a = ground.ToWorld(x, y, lift);
            var b = ground.ToWorld(x + w, y, lift);
            var c = ground.ToWorld(x + w, y + h, lift);
            var d = ground.ToWorld(x, y + h, lift);
            Quad(a, b, c, d, col);
        }

        // A whole tile, subdivided so it hugs the terrain
        public void GroundTile(int tx, int ty, Color col)
        {
            const int Sub = 3;
            float s = C.TileSize / (float)Sub;
            for (int j = 0; j < Sub; j++)
                for (int i = 0; i < Sub; i++)
                    GroundRect(tx * C.TileSize + i * s, ty * C.TileSize + j * s, s, s, col);
        }

        // Pixel-art drawn flat on the ground, centred on (cx, cy) px with art pixels of `px` px
        public void GroundArt(string[] art, float cx, float cy, float px, Color col)
        {
            float x0 = cx - art[0].Length * px / 2, y0 = cy - art.Length * px / 2;
            for (int y = 0; y < art.Length; y++)
                for (int x = 0; x < art[y].Length; x++)
                    if (art[y][x] == '#') GroundRect(x0 + x * px, y0 + y * px, px, px, col);
        }

        // Ellipse outline on the ground made of square pixels
        public void GroundRing(float cx, float cy, float rx, float ry, float px, Color col)
        {
            int n = Mathf.Max(8, Mathf.RoundToInt(Mathf.Max(rx, ry) * 2 * Mathf.PI / (px * 1.4f)));
            for (int i = 0; i < n; i++)
            {
                float a = i * Mathf.PI * 2 / n;
                GroundRect(cx + Mathf.Cos(a) * rx - px / 2, cy + Mathf.Sin(a) * ry - px / 2, px, px, col);
            }
        }

        // A thin line between two world points, facing the camera
        public void Line(Vector3 a, Vector3 b, float width, Color col)
        {
            var dir = (b - a).normalized;
            var side = Vector3.Cross(dir, cam.transform.forward).normalized * (width / 2);
            Quad(a - side, a + side, b + side, b - side, col);
        }

        void LateUpdate()
        {
            mesh.Clear();
            if (verts.Count > 0)
            {
                mesh.SetVertices(verts);
                mesh.SetColors(colors);
                mesh.SetTriangles(tris, 0, false);
                mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100000);
            }
            verts.Clear();
            colors.Clear();
            tris.Clear();
        }
    }
}
