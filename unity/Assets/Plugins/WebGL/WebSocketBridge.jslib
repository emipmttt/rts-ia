// Browser WebSocket for the WebGL build (System.Net.WebSockets doesn't run there). One socket at a
// time; incoming text is queued and polled by SocketIO.Pump each frame.
mergeInto(LibraryManager.library, {
  WsOpen: function (urlPtr) {
    var url = UTF8ToString(urlPtr);
    if (Module.rtsWs) { try { Module.rtsWs.close(); } catch (e) {} }
    Module.rtsQueue = [];
    Module.rtsState = 0; // 0 connecting, 1 open, 2 closed
    var ws = new WebSocket(url);
    Module.rtsWs = ws;
    ws.onopen = function () { if (Module.rtsWs === ws) Module.rtsState = 1; };
    ws.onmessage = function (e) { if (Module.rtsWs === ws && typeof e.data === 'string') Module.rtsQueue.push(e.data); };
    ws.onclose = ws.onerror = function () { if (Module.rtsWs === ws) Module.rtsState = 2; };
  },
  WsState: function () { return Module.rtsWs ? Module.rtsState : 2; },
  WsSend: function (msgPtr) {
    if (Module.rtsWs && Module.rtsState === 1) Module.rtsWs.send(UTF8ToString(msgPtr));
  },
  WsPoll: function () {
    if (!Module.rtsQueue || !Module.rtsQueue.length) return 0;
    var s = Module.rtsQueue.shift();
    var size = lengthBytesUTF8(s) + 1;
    var buf = _malloc(size);
    stringToUTF8(s, buf, size);
    return buf;
  },
  WsFree: function (ptr) { _free(ptr); },
  WsClose: function () { if (Module.rtsWs) { try { Module.rtsWs.close(); } catch (e) {} Module.rtsWs = null; } },
  PageHost: function () {
    var s = window.location.host;
    var size = lengthBytesUTF8(s) + 1;
    var buf = _malloc(size);
    stringToUTF8(s, buf, size);
    return buf;
  },
});
