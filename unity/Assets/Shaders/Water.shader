// River water: the pixel-art water tile (two animation frames swapped from script) tinted, a little
// transparent so the sandy riverbed shows near the banks, with sun glints and received shadows.
Shader "RTS/Water"
{
    Properties
    {
        _MainTex ("Water tile", 2D) = "white" {}
        _Color ("Tint", Color) = (1,1,1,0.82)
        _Tiles ("Tiles per unit", Float) = 1
        _Gloss ("Glint", Range(0,1)) = 0.6
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
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4 _Color;
                float _Tiles;
                half _Gloss;
            CBUFFER_END
            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; half fog : TEXCOORD1; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                float2 uv = i.positionWS.xz * _Tiles;
                half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv) * _Color;
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                float3 v = normalize(GetCameraPositionWS() - i.positionWS);
                // Gentle procedural ripples for the glint
                float t = _Time.y;
                float3 n = normalize(float3(sin(i.positionWS.x * 2.1 + t * 1.3) * 0.08, 1, cos(i.positionWS.z * 1.7 + t * 1.1) * 0.08));
                float3 h = normalize(sun.direction + v);
                half spec = pow(saturate(dot(n, h)), 90) * _Gloss;
                half shadow = lerp(0.55, 1, sun.shadowAttenuation);
                half3 col = tex.rgb * (sun.color * saturate(dot(n, sun.direction)) * 0.7 + SampleSH(n)) * shadow + spec * sun.color * sun.shadowAttenuation;
                col = MixFog(col, i.fog);
                return half4(ApplyFogOfWar(col, i.positionWS), tex.a);
            }
            ENDHLSL
        }
    }
}
