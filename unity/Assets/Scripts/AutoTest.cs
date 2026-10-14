using System;
using System.Collections;
using System.IO;
using UnityEngine;
using RTS.Game;

// Smoke test driven from the command line: `-autotest <screenshot dir>` creates a room, starts a
// match alone, gives a few orders, saves screenshots and quits.
namespace RTS
{
    public static class AutoTest
    {
        static string dir;
        public static bool Enabled
        {
            get
            {
                if (dir != null) return dir.Length > 0;
                var args = Environment.GetCommandLineArgs();
                int i = Array.IndexOf(args, "-autotest");
                dir = i >= 0 && i + 1 < args.Length ? args[i + 1] : "";
                return dir.Length > 0;
            }
        }

        static IEnumerator Shot(string name)
        {
            yield return new WaitForEndOfFrame();
            var path = Path.Combine(dir, name + ".png");
            ScreenCapture.CaptureScreenshot(path);
            Debug.Log($"AUTOTEST screenshot {path}");
            yield return new WaitForSeconds(0.5f);
        }

        public static IEnumerator Lobby(Action createRoom)
        {
            yield return new WaitForSeconds(2);
            yield return Shot("0_lobby");
            createRoom();
            yield return new WaitForSeconds(0.05f);
            yield return Shot("0_room");
        }

        public static IEnumerator Run(GameView game)
        {
            yield return new WaitForSeconds(5);
            yield return Shot("1_base");
            game.DebugOrders();
            yield return new WaitForSeconds(4);
            yield return Shot("2_orders");
            game.DebugCamera(10, 50);
            yield return new WaitForSeconds(2);
            yield return Shot("3_closeup");
            game.DebugCamera(40, -20);
            yield return new WaitForSeconds(2);
            yield return Shot("4_wide");
            game.DebugTrain();
            yield return new WaitForSeconds(12);
            yield return Shot("5_later");
            Debug.Log("AUTOTEST done");
            Application.Quit();
        }
    }
}
