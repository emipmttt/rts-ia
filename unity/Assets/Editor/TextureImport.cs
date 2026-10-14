using UnityEditor;
using UnityEngine;

// Every game texture is pixel art read by the code (slicing, recolouring): point filtered,
// uncompressed, readable, at its original size. Ground tiles repeat; everything else clamps.
public class TextureImport : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Resources/")) return;
        var importer = (TextureImporter)assetImporter;
        importer.textureType = TextureImporterType.Default;
        importer.isReadable = true;
        importer.filterMode = FilterMode.Point;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.mipmapEnabled = false;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.alphaIsTransparency = true;
        importer.sRGBTexture = true;
        importer.maxTextureSize = 8192;
        bool tile = assetPath.EndsWith("_tile.png");
        importer.wrapMode = tile ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
    }
}
