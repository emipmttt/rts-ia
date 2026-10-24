// Ground: the baked pixel-art ground texture (grass, sand, riverbed) on the heightmap mesh, with
// Lambert sun + sky light, cast and received shadows and a little darkening on steep slopes.
// _Emission adds a share of the albedo that ignores the light (the spirit crystals' glow). _Haze > 0
// fades the surface into _HazeColor by (1 - vertex alpha) after the fog of war (_HazeFixed: by a fixed
// amount, for models hung in the void), so the spirit void's walls sink into a white mist that stays
// white in unexplored ground.
Shader "RTS/Terrain"
{
    Properties
    {
        _MainTex ("Ground", 2D) = "white" {}
        _Color ("Tint", Color) = (1,1,1,1)
        _VertexColor ("Use vertex colours", Float) = 1
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 2
        _SlopeDark ("Slope darkening", Range(0,1)) = 0.35
        [Normal] _BumpMap ("Normal map (models)", 2D) = "bump" {}
        _OutlineColor ("Outline when outlines are on (alpha 0 = none)", Color) = (0,0,0,0)
        _Emission ("Self-lit share of the albedo", Range(0,1)) = 0
        _Haze ("Fade into the haze colour by 1 - vertex alpha", Range(0,1)) = 0
        _HazeColor ("Haze colour", Color) = (1,1,1,1)
        _HazeFixed ("Fade into the haze colour by this much everywhere", Range(0,1)) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" "RenderPipeline"="UniversalPipeline" }
        Cull [_Cull]
        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
        TEXTURE2D(_BumpMap); SAMPLER(sampler_BumpMap);
        CBUFFER_START(UnityPerMaterial)
            float4 _MainTex_ST;
            half4 _Color;
            half _VertexColor;
            float _Cull;
            half _SlopeDark;
            half4 _OutlineColor;
            half _Emission;
            half _Haze;
            half4 _HazeColor;
            half _HazeFixed;
        CBUFFER_END
        float _OutlinesOn; // global: the player's "outlines" setting
        ENDHLSL
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
            #pragma multi_compile _ _CLUSTER_LIGHT_LOOP
            #pragma multi_compile_fog
            #pragma multi_compile_local _ _NORMALMAP
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "FogOfWar.hlsl"
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float4 tangentOS : TANGENT; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; float3 positionWS : TEXCOORD1;
                float3 normalWS : TEXCOORD2; half4 color : COLOR; half fog : TEXCOORD3; float4 tangentWS : TEXCOORD4;
            };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                o.tangentWS = float4(TransformObjectToWorldDir(v.tangentOS.xyz), v.tangentOS.w * GetOddNegativeScale());
                o.uv = v.uv;
                o.color = v.color;
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                half3 albedo = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).rgb;
                float3 n = normalize(i.normalWS);
                albedo *= lerp(half3(1, 1, 1), i.color.rgb, _VertexColor) * _Color.rgb;
                #if defined(_NORMALMAP)
                // Model relief from the normal map, in the mesh's tangent space
                float3 t = normalize(i.tangentWS.xyz);
                float3 b = cross(n, t) * i.tangentWS.w;
                half3 nTS = UnpackNormal(SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, i.uv));
                n = normalize(nTS.x * t + nTS.y * b + nTS.z * n);
                #endif
                albedo *= lerp(1, 1 - _SlopeDark, saturate((1 - n.y) * 3));
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                half ao = 1;
                #if defined(_SCREEN_SPACE_OCCLUSION)
                AmbientOcclusionFactor aof = GetScreenSpaceAmbientOcclusion(GetNormalizedScreenSpaceUV(i.positionCS));
                ao = aof.indirectAmbientOcclusion;
                sun.color *= aof.directAmbientOcclusion;
                #endif
                half3 light = sun.color * saturate(dot(n, sun.direction)) * sun.shadowAttenuation + SampleSH(n) * ao;
                #if defined(_ADDITIONAL_LIGHTS)
                uint count = GetAdditionalLightsCount();
                #if USE_CLUSTER_LIGHT_LOOP
                InputData inputData = (InputData)0;
                inputData.positionWS = i.positionWS;
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                #endif
                LIGHT_LOOP_BEGIN(count)
                    Light l = GetAdditionalLight(lightIndex, i.positionWS);
                    light += l.color * l.distanceAttenuation * saturate(dot(n, l.direction));
                LIGHT_LOOP_END
                #endif
                half3 col = MixFog(albedo * (light + _Emission), i.fog);
                col = ApplyFogOfWar(col, i.positionWS);
                col = lerp(col, _HazeColor.rgb, saturate(_Haze * (1 - i.color.a) + _HazeFixed));
                return half4(col, 1);
            }
            ENDHLSL
        }
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode"="ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
            float3 _LightDirection;
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
            float4 vert (Attributes v) : SV_POSITION
            {
                float3 posWS = TransformObjectToWorld(v.positionOS.xyz);
                float4 cs = TransformWorldToHClip(ApplyShadowBias(posWS, TransformObjectToWorldNormal(v.normalOS), _LightDirection));
                #if UNITY_REVERSED_Z
                cs.z = min(cs.z, UNITY_NEAR_CLIP_VALUE);
                #else
                cs.z = max(cs.z, UNITY_NEAR_CLIP_VALUE);
                #endif
                return cs;
            }
            half4 frag () : SV_Target { return 0; }
            ENDHLSL
        }
        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode"="DepthNormals" }
            ZWrite On
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 normalWS : TEXCOORD0; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                return o;
            }
            half4 frag (Varyings i) : SV_Target { return half4(normalize(i.normalWS), 0); }
            ENDHLSL
        }
        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode"="DepthOnly" }
            ZWrite On ColorMask R
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float4 vert (float4 positionOS : POSITION) : SV_POSITION { return TransformObjectToHClip(positionOS.xyz); }
            half4 frag () : SV_Target { return 0; }
            ENDHLSL
        }

        // Outline mask (Core/Outlines.cs): the model's silhouette in its outline colour, where it is
        // visible (depth-tested against the scene); nothing unless outlines are on and it has a colour
        Pass
        {
            Name "OutlineMask"
            Tags { "LightMode"="OutlineMask" }
            ZWrite Off ZTest LEqual
            Offset -1, -1
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "FogOfWar.hlsl"
            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; half fog : TEXCOORD1; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = _OutlinesOn > 0.5 && _OutlineColor.a > 0 ? TransformWorldToHClip(o.positionWS) : float4(0, 0, 0, 1);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                return half4(ApplyFogOfWar(MixFog(_OutlineColor.rgb, i.fog), i.positionWS), 1);
            }
            ENDHLSL
        }
    }
}
