// Second pass of the outlines (Core/Outlines.cs): a pixel outside every outlined figure, with one of
// them within OUTLINE_PX pixels, takes that figure's colour from the mask; the rest is left alone.
// Only the outer edge of what is visible gets a line, like an outline drawn around 2D art.
Shader "Hidden/RTS/OutlineComposite"
{
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        ZWrite Off ZTest Always Cull Off
        Blend SrcAlpha OneMinusSrcAlpha
        Pass
        {
            Name "OutlineComposite"
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"
            #define OUTLINE_PX 2
            float4 _MaskTexel; // 1 / mask size in pixels (set by Core/Outlines.cs)

            // Rings of 8 directions at 1 and 2 pixels; the nearer ring is read last so it wins
            static const float2 Dirs[8] = { float2(1, 0), float2(-1, 0), float2(0, 1), float2(0, -1), float2(1, 1), float2(-1, 1), float2(1, -1), float2(-1, -1) };

            half4 frag (Varyings i) : SV_Target
            {
                float2 uv = i.texcoord;
                float2 t = _MaskTexel.xy;
                half inside = SAMPLE_TEXTURE2D_X_LOD(_BlitTexture, sampler_PointClamp, uv, 0).a;
                half4 found = half4(0, 0, 0, 0);
                [unroll] for (int r = OUTLINE_PX; r >= 1; r--)
                {
                    [unroll] for (int k = 0; k < 8; k++)
                    {
                        half4 m = SAMPLE_TEXTURE2D_X_LOD(_BlitTexture, sampler_PointClamp, uv + Dirs[k] * r * t, 0);
                        found = m.a > 0.5 ? half4(m.rgb, 1) : found;
                    }
                }
                // Inside a figure: leave it alone
                found.a *= inside > 0.5 ? 0 : 1;
                return found;
            }
            ENDHLSL
        }
    }
}
