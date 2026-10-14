using UnityEditor;

// Scripts edited while the game runs are compiled once Play mode ends: reloading them mid-game
// would wipe the running game's state (camera, map, connection) and break it until restarted.
[InitializeOnLoad]
static class PlayModeCompile
{
    const string Key = "ScriptCompilationDuringPlay";
    const int RecompileAfterFinishedPlaying = 1;

    static PlayModeCompile()
    {
        if (EditorPrefs.GetInt(Key, 0) != RecompileAfterFinishedPlaying) EditorPrefs.SetInt(Key, RecompileAfterFinishedPlaying);
    }
}
