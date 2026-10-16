using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using UnityEngine.Rendering.RenderGraphModule;
using UnityEngine.Rendering.Universal;

// The "outlines" setting drawn like 2D art: a ring of a few screen pixels in the owner's colour around
// what is seen of each unit and building, never across its inside or where one figure overlaps
// another. Two passes on the game camera:
//   1. mask: every renderer with an "OutlineMask" pass (models and unit sprites with an outline
//      colour) draws that colour into a mask, depth-tested against the scene so hidden parts don't count
//   2. composite: each screen pixel outside the mask that has mask within OutlinePx of it takes that
//      colour (Hidden/RTS/OutlineComposite)
// Added from code each frame (no renderer asset to edit); only on the camera given to Attach.
namespace RTS
{
    public static class Outlines
    {
        static Camera target;
        static OutlinePass pass;

        public static void Attach(Camera cam)
        {
            target = cam;
            if (pass != null) return;
            var shader = Shader.Find("Hidden/RTS/OutlineComposite");
            if (shader == null) { Debug.LogWarning("Outline composite shader missing"); return; }
            pass = new OutlinePass(new Material(shader));
            RenderPipelineManager.beginCameraRendering += (ctx, cam) =>
            {
                // Never on a device whose GPU can't run the composite shader: no outline beats a broken frame
                if (cam != target || !Materials.Outlines || !pass.Supported) return;
                cam.GetUniversalAdditionalCameraData().scriptableRenderer.EnqueuePass(pass);
            };
        }

        class OutlinePass : ScriptableRenderPass
        {
            static readonly ShaderTagId MaskTag = new ShaderTagId("OutlineMask");
            static readonly int MaskTexel = Shader.PropertyToID("_MaskTexel");
            readonly Material composite;

            class MaskData { public RendererListHandle list; }
            class CompositeData { public TextureHandle mask; public Material material; }

            public bool Supported => composite != null && composite.shader.isSupported;

            public OutlinePass(Material composite)
            {
                this.composite = composite;
                renderPassEvent = RenderPassEvent.BeforeRenderingTransparents;
            }

            public override void RecordRenderGraph(RenderGraph rg, ContextContainer frameData)
            {
                var resources = frameData.Get<UniversalResourceData>();
                var rendering = frameData.Get<UniversalRenderingData>();
                var camera = frameData.Get<UniversalCameraData>();
                var light = frameData.Get<UniversalLightData>();
                if (resources.isActiveTargetBackBuffer) return;

                var desc = rg.GetTextureDesc(resources.activeColorTexture);
                desc.name = "OutlineMask";
                desc.format = GraphicsFormat.R8G8B8A8_UNorm;
                desc.clearBuffer = true;
                desc.clearColor = Color.clear;
                var mask = rg.CreateTexture(desc);
                composite.SetVector(MaskTexel, new Vector4(1f / desc.width, 1f / desc.height, 0, 0));

                using (var builder = rg.AddRasterRenderPass<MaskData>("Outline mask", out var data))
                {
                    var drawing = RenderingUtils.CreateDrawingSettings(MaskTag, rendering, camera, light, SortingCriteria.CommonOpaque);
                    var filtering = new FilteringSettings(RenderQueueRange.all);
                    data.list = rg.CreateRendererList(new RendererListParams(rendering.cullResults, drawing, filtering));
                    builder.UseRendererList(data.list);
                    builder.SetRenderAttachment(mask, 0, AccessFlags.Write);
                    builder.SetRenderAttachmentDepth(resources.activeDepthTexture, AccessFlags.Read);
                    builder.SetRenderFunc((MaskData d, RasterGraphContext ctx) => ctx.cmd.DrawRendererList(d.list));
                }

                using (var builder = rg.AddRasterRenderPass<CompositeData>("Outline composite", out var data))
                {
                    data.mask = mask;
                    data.material = composite;
                    builder.UseTexture(mask, AccessFlags.Read);
                    builder.SetRenderAttachment(resources.activeColorTexture, 0, AccessFlags.Write);
                    builder.SetRenderFunc((CompositeData d, RasterGraphContext ctx) =>
                        Blitter.BlitTexture(ctx.cmd, d.mask, new Vector4(1, 1, 0, 0), d.material, 0));
                }
            }
        }
    }
}
