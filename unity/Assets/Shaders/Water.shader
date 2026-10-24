// Water (classic rivers and the spirit shallows): the pixel-art water tile (two animation frames
// swapped from script) on a surface that swells gently (vertex waves), wobbled and lit by layered
// procedural waves, tinted and made more opaque with depth (_DepthTex: water depth per terrain vertex,
// baked by Ground), with foam lapping at the shore, a sky reflection at grazing angles, pixel glints
// of sun and the rings spreading from units wading through it (_WaterRipples, set by GameView).
// Everything is evaluated per art pixel (16 per tile) so it stays crisp like the rest of the art.
Shader "RTS/Water"
{
    Properties
    {
        _MainTex ("Water tile", 2D) = "white" {}
        _Color ("Tint", Color) = (1,1,1,0.82)
        _Tiles ("Tiles per unit", Float) = 1
        _Gloss ("Glint", Range(0,1)) = 0.6
        _DepthTex ("Water depth (R, x _DepthRange)", 2D) = "black" {}
        _DepthST ("Depth uv scale (xy) and offset (zw)", Vector) = (1,1,0,0)
        _DepthRange ("Depth stored at 1", Float) = 1.2
        _DeepAt ("Depth that looks fully deep", Float) = 1
        _Shallow ("Shallow tint", Color) = (1.08,1.12,1.08,1)
        _Deep ("Deep tint", Color) = (0.55,0.7,0.92,1)
        _Foam ("Foam", Color) = (0.94,0.98,1,1)
        _WaveAmp ("Swell height", Float) = 0.04
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent-10" "RenderPipeline"="UniversalPipeline" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Pass
        {
            Name "Water"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "FogOfWar.hlsl"
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            TEXTURE2D(_DepthTex); SAMPLER(sampler_DepthTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4 _Color;
                float _Tiles;
                half _Gloss;
                float4 _DepthST;
                float _DepthRange, _DeepAt;
                half4 _Shallow, _Deep, _Foam;
                float _WaveAmp;
            CBUFFER_END
            // Rings from wading units: (x, z, age s, strength), the first _WaterRippleCount used
            #define MAX_RIPPLES 32
            float4 _WaterRipples[MAX_RIPPLES];
            float _WaterRippleCount;

            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; half fog : TEXCOORD1; };

            // Slow swell: long waves rolling across, the surface rises and falls a few hundredths
            float Swell(float2 p, float t)
            {
                return sin(p.x * 0.9 + t * 1.1) * 0.5 + sin(p.y * 1.3 - t * 0.8 + p.x * 0.4) * 0.35 + sin((p.x + p.y) * 2.1 + t * 1.9) * 0.15;
            }

            // Gradient of a * sin(dot(k, p) + w t)
            float2 WaveGrad(float2 p, float2 k, float w, float a, float t) { return a * k * cos(dot(k, p) + w * t); }

            Varyings vert (Attributes v)
            {
                Varyings o;
                float3 wp = TransformObjectToWorld(v.positionOS.xyz);
                wp.y += Swell(wp.xz, _Time.y) * _WaveAmp;
                o.positionWS = wp;
                o.positionCS = TransformWorldToHClip(wp);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                float t = _Time.y;
                // One art pixel: everything below is constant across it
                float2 p = (floor(i.positionWS.xz * 16) + 0.5) / 16;
                float depth = SAMPLE_TEXTURE2D(_DepthTex, sampler_DepthTex, float2(p.x, -p.y) * _DepthST.xy + _DepthST.zw).r * _DepthRange;
                float deep = saturate(depth / _DeepAt);

                // Surface slope: the swell plus three short chop layers crossing it
                float2 g = 0;
                g += WaveGrad(p, float2(0.9, 0), 1.1, 0.5, t) * 0.25;
                g += WaveGrad(p, float2(3.1, 2.3), 2.3, 0.05, t);
                g += WaveGrad(p, float2(-2.7, 3.9), 2.9, 0.04, t);
                g += WaveGrad(p, float2(5.3, -1.7), 3.7, 0.025, t);

                // Rings around wading units: a bright crest that spreads and fades, a weaker one inside
                half ripple = 0;
                int count = (int)_WaterRippleCount;
                for (int r = 0; r < MAX_RIPPLES; r++)
                {
                    if (r >= count) break;
                    float4 rp = _WaterRipples[r];
                    float2 d = p - rp.xy;
                    float dist = length(d);
                    float age = rp.z, life = saturate(1 - age / 1.3);
                    float rad = 0.12 + age * 0.9;
                    float crest = saturate(1 - abs(dist - rad) / 0.06) + saturate(1 - abs(dist - rad * 0.55) / 0.05) * 0.5;
                    float k = crest * life * life * rp.w;
                    ripple += k;
                    g += d / max(dist, 0.001) * k * 0.5;
                }
                float3 n = normalize(float3(-g.x, 1, -g.y));

                // The pixel tile, wobbled by the waves
                float2 uv = i.positionWS.xz * _Tiles + g * 0.06;
                half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv) * _Color;
                tex.rgb *= lerp(_Shallow.rgb, _Deep.rgb, deep);

                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                float3 v = normalize(GetCameraPositionWS() - i.positionWS);
                half shadow = lerp(0.55, 1, sun.shadowAttenuation);
                half3 col = tex.rgb * (sun.color * saturate(dot(n, sun.direction)) * 0.7 + SampleSH(n)) * shadow;
                // Sky in the water at grazing angles
                half fres = pow(1 - saturate(dot(n, v)), 4);
                col = lerp(col, SampleSH(reflect(-v, n)) * 1.15, fres * 0.45);
                // Sun glints, hard-edged like the pixel art
                float3 h = normalize(sun.direction + v);
                half spec = pow(saturate(dot(n, h)), 120);
                col += saturate((spec - 0.3) * 5) * _Gloss * sun.color * sun.shadowAttenuation;

                // Foam: a wavering line where the water meets the bank and thin bands rolling in toward it
                float wob = sin(t * 1.7 + p.x * 3.1 + p.y * 2.3) * 0.025;
                half edge = step(depth, 0.07 + wob);
                float band = frac(depth * 5 - t * 0.35 + sin(p.x * 1.3 + p.y * 1.7) * 0.3);
                half bands = step(band, 0.1) * step(depth, 0.3) * (1 - depth / 0.3);
                half foam = saturate(max(edge, bands * 0.6) + step(0.45, ripple) * 0.85 + ripple * 0.25);
                col = lerp(col, _Foam.rgb * (sun.color * 0.6 + SampleSH(float3(0, 1, 0))) * shadow, foam);

                // Clearer over the shallows so the bed shows; fades out right at the waterline
                half alpha = lerp(_Color.a * 0.55, _Color.a, saturate(depth / max(0.05, _DeepAt * 0.6)));
                alpha = max(alpha, foam * 0.9) * smoothstep(0.0, 0.025, depth);

                col = MixFog(col, i.fog);
                return half4(ApplyFogOfWar(col, i.positionWS), alpha);
            }
            ENDHLSL
        }
    }
}
