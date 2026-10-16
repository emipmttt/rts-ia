using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace RTS.Net
{
    // Minimal socket.io v4 client over a raw WebSocket (Engine.IO v4, websocket transport only):
    //   server "0{...}" open  -> client "40{auth}" connect -> server "40{sid}"
    //   "42[event, data]" events both ways, server ping "2" -> client pong "3".
    // Messages are parsed on the socket thread and dispatched on Unity's main thread from Update().
    // Reconnects by itself with the same auth token, like socket.io-client.
    public class SocketIO : IDisposable
    {
        readonly string url;
        readonly object auth;
        readonly Dictionary<string, Action<JToken>> handlers = new Dictionary<string, Action<JToken>>();
        readonly ConcurrentQueue<Action> mainThread = new ConcurrentQueue<Action>();
        readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
        ClientWebSocket ws;
        CancellationTokenSource cts;
        bool disposed;
        public bool Connected { get; private set; }
        public event Action OnConnect;
        public event Action OnDisconnect;

        public SocketIO(string hostAndPort, object auth)
        {
            var host = hostAndPort.Trim();
            if (host.StartsWith("http://")) host = host.Substring(7);
            if (host.StartsWith("ws://")) host = host.Substring(5);
            host = host.TrimEnd('/');
            if (!host.Contains(":")) host += ":" + C.DefaultPort;
            url = $"ws://{host}/socket.io/?EIO=4&transport=websocket";
            this.auth = auth;
        }

        public void On(string evt, Action<JToken> handler) => handlers[evt] = handler;
        // game:state has its own streaming reader (see StateMsg)
        public Action<StateMsg> OnState;

        public void Emit(string evt, object data = null)
        {
            var arr = data == null ? new JArray(evt) : new JArray(evt, data is JToken t ? t : JToken.FromObject(data));
            outbox.Enqueue("42" + arr.ToString(Formatting.None));
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        // WebGL: no threads or .NET sockets; the browser's WebSocket (Plugins/WebGL/WebSocketBridge.jslib)
        // is polled from Pump, reconnecting with backoff like the threaded version
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void WsOpen(string url);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern int WsState();
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void WsSend(string msg);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern IntPtr WsPoll();
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void WsFree(IntPtr p);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void WsClose();
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern IntPtr PageHost();
        float retryAt, retryDelay = 1;
        bool started;

        public static string PageHostName()
        {
            var p = PageHost();
            var s = System.Runtime.InteropServices.Marshal.PtrToStringUTF8(p);
            WsFree(p);
            return s;
        }

        public void Start()
        {
            started = true;
            WsOpen(url);
        }

        void PumpWeb()
        {
            if (!started || disposed) return;
            IntPtr p;
            while ((p = WsPoll()) != IntPtr.Zero)
            {
                var msg = System.Runtime.InteropServices.Marshal.PtrToStringUTF8(p);
                WsFree(p);
                Handle(msg);
            }
            if (WsState() == 1)
            {
                retryDelay = 1;
                while (outbox.TryDequeue(out var m)) WsSend(m);
            }
            else if (WsState() == 2)
            {
                if (Connected) { Connected = false; OnDisconnect?.Invoke(); }
                if (retryAt == 0) retryAt = Time.realtimeSinceStartup + retryDelay;
                else if (Time.realtimeSinceStartup >= retryAt)
                {
                    retryAt = 0;
                    retryDelay = Math.Min(retryDelay * 2, 5);
                    while (outbox.TryDequeue(out _)) { }
                    WsOpen(url);
                }
            }
        }

        void Abort() => WsClose();
#else
        public static string PageHostName() => null;

        public void Start()
        {
            cts = new CancellationTokenSource();
            Task.Run(() => RunLoop(cts.Token));
        }

        void PumpWeb() { }
        void Abort() => ws?.Abort();
#endif

        const string StatePrefix = "[\"game:state\",";
        string latestState;

        // Called every frame from a MonoBehaviour
        public void Pump()
        {
            PumpWeb();
            while (mainThread.TryDequeue(out var a))
            {
                try { a(); } catch (Exception e) { Debug.LogException(e); }
            }
            var state = Interlocked.Exchange(ref latestState, null);
            if (state != null && OnState != null)
            {
                try { OnState(StateMsg.Read(state)); } catch (Exception e) { Debug.LogException(e); }
            }
        }

        async Task RunLoop(CancellationToken ct)
        {
            var delay = 1000;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Session(ct);
                    delay = 1000;
                }
                catch (Exception e) when (!(e is OperationCanceledException))
                {
                    Debug.Log($"[socket] {e.Message}");
                }
                if (Connected)
                {
                    Connected = false;
                    mainThread.Enqueue(() => OnDisconnect?.Invoke());
                }
                if (ct.IsCancellationRequested) break;
                try { await Task.Delay(delay, ct); } catch { break; }
                delay = Math.Min(delay * 2, 5000);
            }
        }

        async Task Session(CancellationToken ct)
        {
            ws?.Dispose();
            ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.Zero;
            await ws.ConnectAsync(new Uri(url), ct);
            while (outbox.TryDequeue(out _)) { } // orders from a previous connection are stale
            var sender = SendLoop(ct);
            var buffer = new byte[64 * 1024];
            using (var ms = new MemoryStream())
            {
                while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    ms.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                        if (result.MessageType == WebSocketMessageType.Close) return;
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);
                    if (result.MessageType != WebSocketMessageType.Text) continue;
                    Handle(Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length));
                }
            }
            await sender;
        }

        async Task SendLoop(CancellationToken ct)
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                if (outbox.TryDequeue(out var msg))
                {
                    var bytes = Encoding.UTF8.GetBytes(msg);
                    try { await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct); }
                    catch { return; }
                }
                else
                {
                    try { await Task.Delay(5, ct); } catch { return; }
                }
            }
        }

        void SendRaw(string msg) => outbox.Enqueue(msg);

        void Handle(string msg)
        {
            if (msg.Length == 0) return;
            switch (msg[0])
            {
                case '0': // Engine.IO open: connect to the default namespace with our auth
                    SendRaw("40" + JsonConvert.SerializeObject(auth));
                    break;
                case '2': // ping
                    SendRaw("3");
                    break;
                case '1': // close
                    Abort();
                    break;
                case '4':
                    HandleSocketIO(msg.Substring(1));
                    break;
            }
        }

        void HandleSocketIO(string packet)
        {
            if (packet.Length == 0) return;
            char type = packet[0];
            var body = packet.Substring(1);
            if (type == '0')
            {
                Connected = true;
                mainThread.Enqueue(() => OnConnect?.Invoke());
            }
            else if (type == '1' || type == '4')
            {
                Debug.LogWarning($"[socket] {body}");
                Abort();
            }
            else if (type == '2')
            {
                // Game states replace each other: only the newest is kept and parsed (in Pump), so a
                // slow frame never leaves a backlog of old states that makes this player lag behind
                if (body.StartsWith(StatePrefix))
                {
                    Interlocked.Exchange(ref latestState, body);
                    return;
                }
                // Optional namespace / ack id before the array are not used by this server
                int start = body.IndexOf('[');
                if (start < 0) return;
                var arr = JArray.Parse(body.Substring(start));
                var evt = (string)arr[0];
                var data = arr.Count > 1 ? arr[1] : null;
                if (!handlers.TryGetValue(evt, out var h)) return;
                mainThread.Enqueue(() => h(data));
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            cts?.Cancel();
            try { Abort(); } catch { }
            ws?.Dispose();
        }
    }
}
