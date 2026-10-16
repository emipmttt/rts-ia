using UnityEngine;

// Sky, ambient light and distance fog for the map's look: the classic valley's clear blue day, or
// the spirit dimension's pale violet light. The classic values are the ones App sets up at launch.
namespace RTS.World
{
    public static class Atmosphere
    {
        public static void Set(bool spirit)
        {
            var sky = RenderSettings.skybox;
            if (sky != null)
            {
                sky.SetColor("_SkyTint", spirit ? new Color(0.62f, 0.42f, 0.72f) : new Color(0.5f, 0.66f, 0.82f));
                sky.SetColor("_GroundColor", spirit ? new Color(0.22f, 0.16f, 0.26f) : new Color(0.4f, 0.48f, 0.46f));
            }
            RenderSettings.ambientSkyColor = spirit ? new Color(0.72f, 0.64f, 0.84f) : new Color(0.68f, 0.76f, 0.86f);
            RenderSettings.ambientEquatorColor = spirit ? new Color(0.62f, 0.56f, 0.68f) : new Color(0.62f, 0.68f, 0.68f);
            RenderSettings.ambientGroundColor = spirit ? new Color(0.3f, 0.26f, 0.36f) : new Color(0.38f, 0.4f, 0.38f);
            RenderSettings.fogColor = spirit ? new Color(0.66f, 0.6f, 0.76f) : new Color(0.76f, 0.83f, 0.87f);
            DynamicGI.UpdateEnvironment();
        }
    }
}
