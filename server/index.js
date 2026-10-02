import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Server } from 'socket.io';
import { PORT } from '../shared/constants.js';
import { Lobby } from './Lobby.js';

const app = express();
app.use(express.static('dist'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const lobby = new Lobby(io);

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.emit('lobby:rooms', lobby.list());

  // Lobby / rooms
  socket.on('lobby:list', () => socket.emit('lobby:rooms', lobby.list()));
  socket.on('room:create', (data) => lobby.create(socket, data ?? {}));
  socket.on('room:join', (data) => lobby.join(socket, data ?? {}));
  socket.on('room:leave', () => lobby.leave(socket));
  socket.on('room:start', () => lobby.start(socket));
  socket.on('chat', (text) => lobby.roomOf(socket)?.handleChat(socket.id, text));

  // In-game commands
  socket.on('game:move', (order) => lobby.roomOf(socket)?.handleMove(socket.id, order ?? {}));
  socket.on('game:gather', (order) => lobby.roomOf(socket)?.handleGather(socket.id, order ?? {}));
  socket.on('game:build', (order) => lobby.roomOf(socket)?.handleBuild(socket.id, order ?? {}));
  socket.on('game:construct', (order) => lobby.roomOf(socket)?.handleConstruct(socket.id, order ?? {}));
  socket.on('game:train', (order) => lobby.roomOf(socket)?.handleTrain(socket.id, order ?? {}));
  socket.on('game:attack', (order) => lobby.roomOf(socket)?.handleAttack(socket.id, order ?? {}));

  socket.on('disconnect', () => {
    lobby.leave(socket);
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
