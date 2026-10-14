import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync, gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { PORT } from '../shared/constants.js';
import { Lobby } from './Lobby.js';

const app = express();
// The game page: the Unity web build (unity/Web) when present, else the old built web client (dist).
// Resolved from this file so the server can be started from any directory.
const unityWeb = fileURLToPath(new URL('../unity/Web', import.meta.url));
if (existsSync(unityWeb)) {
  // Unity's brotli files (.br): browsers only take brotli over HTTPS, so for plain http they're
  // decompressed once at startup and sent gzipped instead
  const TYPES = { '.js': 'application/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
  const build = `${unityWeb}/Build`;
  const cache = new Map();
  for (const f of readdirSync(build).filter((n) => n.endsWith('.br'))) {
    const br = readFileSync(`${build}/${f}`);
    cache.set(f, { br, gz: gzipSync(brotliDecompressSync(br)), type: TYPES[f.slice(0, -3).match(/\.[a-z]+$/)?.[0]] ?? 'application/octet-stream' });
  }
  app.get('/Build/:file', (req, res, next) => {
    const entry = cache.get(req.params.file);
    if (!entry) return next();
    const brotli = req.secure && req.acceptsEncodings('br') === 'br';
    res.set({ 'Content-Type': entry.type, 'Content-Encoding': brotli ? 'br' : 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' });
    res.send(brotli ? entry.br : entry.gz);
  });
  app.use(express.static(unityWeb));
} else {
  app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
}
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const lobby = new Lobby(io);

// Each browser tab keeps a secret token across reconnects; the public player id is derived from it,
// so a dropped player gets their village back and nobody can claim someone else's id
const playerIdFor = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16);

io.on('connection', (socket) => {
  const { token } = socket.handshake.auth ?? {};
  const valid = typeof token === 'string' && token.length >= 16 && token.length <= 100;
  const playerId = playerIdFor(valid ? token : randomUUID());
  socket.data.playerId = playerId;
  socket.join(playerId);
  console.log(`Socket connected: ${socket.id} (player ${playerId})`);
  socket.emit('session', { playerId });
  socket.emit('lobby:rooms', lobby.list());
  lobby.reconnect(socket);

  // Lobby / rooms
  socket.on('lobby:list', () => socket.emit('lobby:rooms', lobby.list()));
  socket.on('room:create', (data) => lobby.create(socket, data ?? {}));
  socket.on('room:join', (data) => lobby.join(socket, data ?? {}));
  socket.on('room:leave', () => lobby.leave(socket));
  socket.on('room:start', () => lobby.start(socket));
  socket.on('room:civ', (civ) => lobby.civ(socket, civ));
  socket.on('room:settings', (settings) => lobby.settings(socket, settings ?? {}));
  socket.on('chat', (text) => lobby.roomOf(socket)?.handleChat(socket.data.playerId, text));

  // In-game commands
  socket.on('game:move', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'move', order ?? {}));
  socket.on('game:gather', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'gather', order ?? {}));
  socket.on('game:build', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'build', order ?? {}));
  socket.on('game:construct', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'construct', order ?? {}));
  socket.on('game:train', (order) => lobby.roomOf(socket)?.handleTrain(socket.data.playerId, order ?? {}));
  socket.on('game:farm', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'farm', order ?? {}));
  socket.on('game:reseed', (order) => lobby.roomOf(socket)?.handleReseed(socket.data.playerId, order ?? {}));
  socket.on('game:research', (order) => lobby.roomOf(socket)?.handleResearch(socket.data.playerId, order ?? {}));
  socket.on('game:attack', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'attack', order ?? {}));
  socket.on('game:wall', (order) => lobby.roomOf(socket)?.order(socket.data.playerId, 'wall', order ?? {}));
  socket.on('game:ageup', (order) => lobby.roomOf(socket)?.handleAgeUp(socket.data.playerId, order ?? {}));

  socket.on('disconnect', () => {
    // Another tab/socket of the same player may still be connected
    if (!io.sockets.adapter.rooms.get(playerId)?.size) lobby.disconnect(socket);
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process (lsof -i :${PORT}) or run with PORT=<port>.`);
    process.exit(1);
  }
  throw err;
});

// Local network addresses of this machine (on a VPS this is usually the public IP)
function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// Public IP as seen from the internet, for VPSs behind NAT (e.g. AWS/GCP); null if offline
async function publicAddress() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000) });
    return res.ok ? (await res.text()).trim() : null;
  } catch {
    return null;
  }
}

// In dev the page is served by Vite (CLIENT_PORT); with `npm start` the server serves the built page itself
const PAGE_PORT = Number(process.env.CLIENT_PORT) || PORT;

httpServer.listen(PORT, '0.0.0.0', async () => {
  const ips = new Set(localAddresses());
  const publicIp = await publicAddress();
  if (publicIp) ips.add(publicIp);

  console.log(`\nRTS game server running (socket port ${PORT})`);
  console.log('Open the game in your browser:');
  console.log(`  ➜  http://localhost:${PAGE_PORT}`);
  for (const ip of ips) console.log(`  ➜  http://${ip}:${PAGE_PORT}${ip === publicIp ? '  (public IP)' : ''}`);
  console.log(`Make sure ports ${[...new Set([PAGE_PORT, PORT])].join(' and ')} are open in the VPS firewall.\n`);
});
