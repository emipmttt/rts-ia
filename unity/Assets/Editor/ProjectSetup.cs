using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

// One-time project setup (run from the menu or with -executeMethod ProjectSetup.Run): creates the
// URP pipeline with soft shadows, SSAO, and the Main scene that boots the game. The scene opens by
// itself when the editor starts.
[InitializeOnLoad]
public static class ProjectSetup
{
    const string ScenePath = "Assets/Scenes/Main.unity";
    const string SettingsDir = "Assets/Settings";

    static ProjectSetup()
    {
        EditorApplication.delayCall += () =>
        {
            if (Application.isBatchMode || EditorApplication.isPlayingOrWillChangePlaymode) return;
            if (!File.Exists(ScenePath)) Run();
            if (SceneManager.GetActiveScene().path != ScenePath) EditorSceneManager.OpenScene(ScenePath);
        };
    }

    [MenuItem("RTS/Configurar proyecto")]
    public static void Run()
    {
        Directory.CreateDirectory(SettingsDir);
        Directory.CreateDirectory("Assets/Scenes");

        // Renderer + pipeline asset
        var rendererPath = $"{SettingsDir}/RTS_Renderer.asset";
        var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(rendererPath);
        if (renderer == null)
        {
            renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(renderer, rendererPath);
            ResourceReloader.TryReloadAllNullIn(renderer, UniversalRenderPipelineAsset.packagePath);
            // Screen-space ambient occlusion grounds buildings and trees on the terrain
            var ssaoType = Type.GetType("UnityEngine.Rendering.Universal.ScreenSpaceAmbientOcclusion, Unity.RenderPipelines.Universal.Runtime");
            if (ssaoType != null)
            {
                var ssao = (ScriptableRendererFeature)ScriptableObject.CreateInstance(ssaoType);
                ssao.name = "SSAO";
                AssetDatabase.AddObjectToAsset(ssao, renderer);
                renderer.rendererFeatures.Add(ssao);
                var so = new SerializedObject(renderer);
                var map = so.FindProperty("m_RendererFeatureMap");
                if (map != null)
                {
                    map.arraySize++;
                    AssetDatabase.TryGetGUIDAndLocalFileIdentifier(ssao, out _, out long id);
                    map.GetArrayElementAtIndex(map.arraySize - 1).longValue = id;
                }
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            EditorUtility.SetDirty(renderer);
        }

        var pipelinePath = $"{SettingsDir}/RTS_URP.asset";
        var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(pipelinePath);
        if (pipeline == null)
        {
            pipeline = UniversalRenderPipelineAsset.Create(renderer);
            AssetDatabase.CreateAsset(pipeline, pipelinePath);
        }
        var p = new SerializedObject(pipeline);
        void Set(string name, Action<SerializedProperty> set) { var prop = p.FindProperty(name); if (prop != null) set(prop); }
        Set("m_MainLightShadowsSupported", s => s.boolValue = true);
        Set("m_MainLightShadowmapResolution", s => s.intValue = 4096);
        Set("m_AdditionalLightsRenderingMode", s => s.intValue = 1); // per pixel
        Set("m_AdditionalLightsPerObjectLimit", s => s.intValue = 8);
        Set("m_ShadowDistance", s => s.floatValue = 70f);
        Set("m_ShadowCascadeCount", s => s.intValue = 2);
        Set("m_Cascade2Split", s => s.floatValue = 0.3f);
        Set("m_SoftShadowsSupported", s => s.boolValue = true);
        Set("m_SoftShadowQuality", s => s.intValue = 3);
        Set("m_ShadowDepthBias", s => s.floatValue = 0.6f);
        Set("m_ShadowNormalBias", s => s.floatValue = 0.4f);
        Set("m_SupportsHDR", s => s.boolValue = true);
        Set("m_MSAA", s => s.intValue = 4);
        Set("m_RequireDepthTexture", s => s.boolValue = true);
        p.ApplyModifiedPropertiesWithoutUndo();
        EditorUtility.SetDirty(pipeline);

        GraphicsSettings.defaultRenderPipeline = pipeline;
        var levels = QualitySettings.names.Length;
        var current = QualitySettings.GetQualityLevel();
        for (int i = 0; i < levels; i++)
        {
            QualitySettings.SetQualityLevel(i, false);
            QualitySettings.renderPipeline = pipeline;
        }
        QualitySettings.SetQualityLevel(current, false);

        // Shaders the game loads by name must ship with builds
        var always = new SerializedObject(AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("ProjectSettings/GraphicsSettings.asset"));
        var list = always.FindProperty("m_AlwaysIncludedShaders");
        foreach (var name in new[] { "RTS/SpriteLit", "RTS/Unlit", "RTS/Water", "RTS/Terrain", "Skybox/Procedural" })
        {
            var shader = Shader.Find(name);
            if (shader == null) continue;
            bool found = false;
            for (int i = 0; i < list.arraySize; i++) if (list.GetArrayElementAtIndex(i).objectReferenceValue == shader) found = true;
            if (found) continue;
            list.arraySize++;
            list.GetArrayElementAtIndex(list.arraySize - 1).objectReferenceValue = shader;
        }
        always.ApplyModifiedPropertiesWithoutUndo();

        PlayerSettings.colorSpace = ColorSpace.Linear;
        PlayerSettings.productName = "Age of Elemental Wars";
        PlayerSettings.runInBackground = true;

        // Scene: an empty scene with the bootstrap object (everything else is built at runtime)
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        new GameObject("RTS").AddComponent<RTS.App>();
        EditorSceneManager.SaveScene(scene, ScenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };

        AssetDatabase.SaveAssets();
        Debug.Log("RTS project configured");
    }
}
