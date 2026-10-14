// Grass tufts: two crossed pixel-art quads per tuft, batched in big meshes (GrassField.cs). The tips
// sway in the wind and bend away from units walking through them, shaking harder while they pass.
// Pushers come from GameView every frame as world (x, z, radius, strength). Alpha-clipped and lit
// like the sprites; they receive shadows but cast none (thousands of tiny casters aren't worth it).
Shader "RTS/Grass"
{
    Properties
    {
        _MainTex ("Tuft", 2D) = "white" {}
        _Cutoff ("Alpha cutoff", Range(0,1)) = 0.5
        _Sway ("Wind sway (world units)", Float) = 0.045
        _Push ("Bend away from units (world units)", Float) = 0.22
        _Shake ("Shake while units pass (world units)", Float) = 0.07
    }
    SubShader
    {
        Tags { "RenderType"="TransparentCutout" "Queue"="AlphaTest" "RenderPipeline"="UniversalPipeline" }
        Cull Off
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "FogOfWar.hlsl"

            #define MAX_PUSHERS 32
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half _Cutoff;
                float _Sway, _Push, _Shake;
            CBUFFER_END
            float4 _GrassPushers[MAX_PUSHERS];
            float _GrassPusherCount;

            // uv0: tuft art (y = 0 at the roots, 1 at the tips); uv1: root x, root z, phase 0..1
            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; float4 root : TEXCOORD1; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; float3 positionWS : TEXCOORD1; half fog : TEXCOORD2; };

            Varyings vert (Attributes v)
            {
                Varyings o;
                float3 p = TransformObjectToWorld(v.positionOS.xyz);
                float2 root = v.root.xy;
                float phase = v.root.z * 6.2832;
                float t = _Time.y;
                // Wind: two slow waves rolling across the field plus a little flutter per tuft
                float gust = sin(t * 1.3 + root.x * 0.35 + root.y * 0.2) * 0.65 + sin(t * 2.9 + phase) * 0.35;
                float2 bend = float2(0.8, 0.6) * gust * _Sway;
                float lower = 0;
                for (int k = 0; k < MAX_PUSHERS; k++)
                {
                    if (k >= (int)_GrassPusherCount) break;
                    float4 u = _GrassPushers[k];
                    float2 d = root - u.xy;
                    float dist = length(d);
                    float f = saturate(1 - dist / u.z) * u.w;
                    if (f <= 0) continue;
                    float2 away = dist > 0.001 ? d / dist : float2(0, 1);
                    bend += away * f * _Push;
                    bend += float2(sin(t * 17 + phase), cos(t * 13 + phase * 1.7)) * f * _Shake;
                    lower = max(lower, f);
                }
                // Only the upper part moves; bent tips also drop a little
                float w = v.uv.y * v.uv.y;
                p.xz += bend * w;
                p.y -= lower * 0.12 * w;
                o.positionWS = p;
                o.positionCS = TransformWorldToHClip(p);
                o.uv = v.uv;
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                clip(tex.a - _Cutoff);
                // Lit like the ground under it (mostly from above), darker toward the roots
                float3 n = float3(0, 1, 0);
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                half3 light = sun.color * saturate(dot(n, sun.direction)) * sun.shadowAttenuation + SampleSH(n);
                half3 col = tex.rgb * light * lerp(0.78, 1.0, i.uv.y);
                col = MixFog(col, i.fog);
                return half4(ApplyFogOfWar(col, i.positionWS), 1);
            }
            ENDHLSL
        }
    }
}
