// Vertex-coloured, alpha-blended and unlit: pixel particles, ground overlays (rings, ghost tiles,
// markers) and glowing sprites (fire, explosions). _ZBias pulls ground overlays above the terrain;
// _FogOfWar = 0 keeps the player's own overlays (rings, markers, placement preview) bright in the fog.
Shader "RTS/Unlit"
{
    Properties
    {
        [PerRendererData] _MainTex ("Texture", 2D) = "white" {}
        _Color ("Tint", Color) = (1,1,1,1)
        _ZBias ("Depth offset", Float) = 0
        [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("ZTest", Float) = 4
        _FogOfWar ("Darken under fog of war", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" "RenderPipeline"="UniversalPipeline" "IgnoreProjector"="True" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        ZTest [_ZTest]
        Cull Off
        Offset [_ZBias], [_ZBias]
        Pass
        {
            Name "Unlit"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "FogOfWar.hlsl"
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4 _Color;
                float _ZBias;
                float _ZTest;
                half _FogOfWar;
            CBUFFER_END
            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; half fog : TEXCOORD1; float3 positionWS : TEXCOORD2; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.uv = v.uv;
                o.color = v.color * _Color;
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                half4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv) * i.color;
                c.rgb = MixFog(c.rgb, i.fog);
                if (_FogOfWar > 0.5) c.rgb = ApplyFogOfWar(c.rgb, i.positionWS);
                return c;
            }
            ENDHLSL
        }
    }
}
