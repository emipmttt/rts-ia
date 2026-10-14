using UnityEditor;
using UnityEngine;

// Batch-mode checks: run with -executeMethod Verify.Shaders
public static class Verify
{
    public static void Shaders()
    {
        foreach (var name in new[] { "RTS/SpriteLit", "RTS/Unlit", "RTS/Water", "RTS/Terrain" })
        {
            var s = Shader.Find(name);
            if (s == null) { Debug.LogError($"VERIFY missing {name}"); continue; }
            foreach (var m in ShaderUtil.GetShaderMessages(s))
                Debug.Log($"VERIFY {name}: {m.severity} {m.message} line {m.line}");
            Debug.Log($"VERIFY {name} hasError={ShaderUtil.ShaderHasError(s)}");
        }
    }

    public static void Build()
    {
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Scenes/Main.unity" },
            locationPathName = "Build/RTS.app",
            target = BuildTarget.StandaloneOSX,
            options = BuildOptions.Development,
        });
        Debug.Log($"VERIFY build {report.summary.result} errors={report.summary.totalErrors}");
    }
}
