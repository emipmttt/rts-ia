// Pixel-art billboard lit by the sun and point lights: alpha-clipped so it casts and receives real
// shadows. Normals lean toward the sky so a sprite never goes black when the sun is behind it.
Shader "RTS/SpriteLit"
{
    Properties
    {
        [PerRendererData] _MainTex ("Sprite", 2D) = "white" {}
        _Color ("Tint", Color) = (1,1,1,1)
        _Cutoff ("Alpha cutoff", Range(0,1)) = 0.5
        _Wrap ("Light wrap", Range(0,1)) = 0.55
        _Emission ("Emission", Range(0,4)) = 0
        _XrayColor ("Silhouette where hidden behind buildings (alpha 0 = none)", Color) = (0,0,0,0)
        _OutlineColor ("Outline when outlines are on (alpha 0 = none)", Color) = (0,0,0,0)
    }
    SubShader
    {
        Tags { "RenderType"="TransparentCutout" "Queue"="AlphaTest" "RenderPipeline"="UniversalPipeline" }
        Cull Off

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
        CBUFFER_START(UnityPerMaterial)
            float4 _MainTex_ST;
            half4 _Color;
            half _Cutoff;
            half _Wrap;
            half _Emission;
            half4 _XrayColor;
            half4 _OutlineColor;
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
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHT_SHADOWS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile _ _CLUSTER_LIGHT_LOOP
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "FogOfWar.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                half4 color : COLOR;
                float3 positionWS : TEXCOORD1;
                half fog : TEXCOORD2;
            };

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
                half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv) * i.color;
                if (tex.a < _Cutoff)
                {
                    // Outline: an empty pixel touching the figure takes the owner's colour
                    if (_OutlinesOn > 0.5 && _OutlineColor.a > 0)
                    {
                        float2 size;
                        _MainTex.GetDimensions(size.x, size.y);
                        float2 t = 1.0 / size;
                        half n = max(max(SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv + float2(t.x, 0)).a, SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv - float2(t.x, 0)).a),
                                     max(SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv + float2(0, t.y)).a, SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv - float2(0, t.y)).a));
                        if (n * i.color.a >= _Cutoff) return half4(ApplyFogOfWar(MixFog(_OutlineColor.rgb, i.fog), i.positionWS), 1);
                    }
                    discard;
                }
                float3 toCam = normalize(GetCameraPositionWS() - i.positionWS);
                float3 n = normalize(float3(toCam.x, 0, toCam.z) * 0.6 + float3(0, 1, 0));

                float4 shadowCoord = TransformWorldToShadowCoord(i.positionWS);
                Light sun = GetMainLight(shadowCoord);
                half ndl = saturate((dot(n, sun.direction) + _Wrap) / (1 + _Wrap));
                half3 light = sun.color * ndl * sun.shadowAttenuation;
                light += SampleSH(n);

                #if defined(_ADDITIONAL_LIGHTS)
                uint count = GetAdditionalLightsCount();
                #if USE_CLUSTER_LIGHT_LOOP
                InputData inputData = (InputData)0;
                inputData.positionWS = i.positionWS;
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                #endif
                LIGHT_LOOP_BEGIN(count)
                    Light l = GetAdditionalLight(lightIndex, i.positionWS);
                    half nl = saturate((dot(n, l.direction) + 0.8) / 1.8);
                    light += l.color * l.distanceAttenuation * nl;
                LIGHT_LOOP_END
                #endif

                half3 col = tex.rgb * light + tex.rgb * _Emission;
                col = MixFog(col, i.fog);
                return half4(ApplyFogOfWar(col, i.positionWS), 1);
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
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
            float3 _LightDirection;
            float3 _LightPosition;

            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half alpha : TEXCOORD1; };

            Varyings vert (Attributes v)
            {
                Varyings o;
                float3 posWS = TransformObjectToWorld(v.positionOS.xyz);
                #if _CASTING_PUNCTUAL_LIGHT_SHADOW
                float3 dir = normalize(_LightPosition - posWS);
                #else
                float3 dir = _LightDirection;
                #endif
                // Billboards have no meaningful normal: bias along the light direction only
                float4 cs = TransformWorldToHClip(ApplyShadowBias(posWS, dir, dir));
                #if UNITY_REVERSED_Z
                cs.z = min(cs.z, UNITY_NEAR_CLIP_VALUE);
                #else
                cs.z = max(cs.z, UNITY_NEAR_CLIP_VALUE);
                #endif
                o.positionCS = cs;
                o.uv = v.uv;
                o.alpha = v.color.a * _Color.a;
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                clip(SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * i.alpha - _Cutoff);
                return 0;
            }
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
            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half alpha : TEXCOORD1; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.uv = v.uv;
                o.alpha = v.color.a * _Color.a;
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                clip(SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * i.alpha - _Cutoff);
                return 0;
            }
            ENDHLSL
        }

        // Units and sheep hidden behind a building (or a hill) show through it as a silhouette in
        // their owner's colour. Drawn after the sprite, only where something nearer covers it.
        Pass
        {
            Name "Xray"
            Tags { "LightMode"="SRPDefaultUnlit" }
            ZTest Greater
            ZWrite Off
            Blend SrcAlpha OneMinusSrcAlpha
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half alpha : TEXCOORD1; };
            Varyings vert (Attributes v)
            {
                Varyings o;
                // Materials without a silhouette (trees, buildings) collapse to nothing here
                // Same math as the lit pass so the unit never covers itself
                o.positionCS = _XrayColor.a > 0 ? TransformWorldToHClip(TransformObjectToWorld(v.positionOS.xyz)) : float4(0, 0, 0, 1);
                o.uv = v.uv;
                o.alpha = v.color.a * _Color.a;
                return o;
            }
            half4 frag (Varyings i) : SV_Target
            {
                clip(SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * i.alpha - _Cutoff);
                return _XrayColor;
            }
            ENDHLSL
        }
    }
}
