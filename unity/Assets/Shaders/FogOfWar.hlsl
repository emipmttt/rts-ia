// Fog of war shared by every world shader. _FogOfWarTex holds one value per half tile (set from
// FogOfWar.cs): 0 = never explored (black), 0.5 = explored but out of sight (dark and greyish),
// 1 = in sight of the player's units. Bilinear sampling softens the edges. Applied after the
// distance fog so unexplored ground stays black.
#ifndef RTS_FOG_OF_WAR
#define RTS_FOG_OF_WAR

TEXTURE2D(_FogOfWarTex); SAMPLER(sampler_FogOfWarTex);
float4 _FogOfWarParams; // x = 1 / map side in tiles, y = 1 while a game with fog is running

half3 ApplyFogOfWar(half3 col, float3 positionWS)
{
    if (_FogOfWarParams.y < 0.5) return col;
    float2 uv = float2(positionWS.x, -positionWS.z) * _FogOfWarParams.x;
    half v = SAMPLE_TEXTURE2D(_FogOfWarTex, sampler_FogOfWarTex, uv).r;
    half explored = saturate(v * 2);
    half sight = saturate(v * 2 - 1);
    half lum = dot(col, half3(0.3, 0.59, 0.11));
    half3 remembered = lerp(lum.xxx, col, 0.55) * 0.42;
    return lerp(remembered, col, sight) * explored;
}

#endif
