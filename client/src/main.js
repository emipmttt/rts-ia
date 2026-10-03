import { io } from 'socket.io-client';
import { Game } from './game.js';

// Secret per-browser token: after a dropped connection, a reload or reopening the browser the server
// recognises this player and puts them back in their game
const newToken = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let token;
try {
  token = localStorage.getItem('playerToken');
  if (!token) localStorage.setItem('playerToken', token = newToken());
} catch { token = newToken(); }
const socket = io(import.meta.env.DEV ? `http://${location.hostname}:3001` : undefined, { auth: { token } });
let myId = null; // public player id, sent by the server on connect
socket.on('session', ({ playerId }) => { myId = playerId; });
const $ = (id) => document.getElementById(id);
const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

let currentRoom = null;
let game = null;

const show = (screen) => {
  for (const id of ['lobby', 'room', 'game']) $(id).classList.toggle('hidden', id !== screen);
};

// Remember the player's name between visits
const nameInput = $('player-name');
try { nameInput.value = localStorage.getItem('playerName') ?? ''; } catch { /* storage unavailable */ }
if (!nameInput.value) nameInput.value = `Jugador${Math.floor(Math.random() * 1000)}`;
nameInput.addEventListener('change', () => {
  try { localStorage.setItem('playerName', nameInput.value); } catch { /* storage unavailable */ }
});
const playerName = () => nameInput.value.trim();

// ---- Flag editor ----
// The player draws a shape in black; the game receives it as white on transparent so it can be tinted
// with the colour the player gets in each match. Saved between visits.
const flagCanvas = $('flag-canvas');
const flagCtx = flagCanvas.getContext('2d');
const FLAG_BRUSH = 6;
try {
  const saved = localStorage.getItem('flagDrawing');
  if (saved) {
    const img = new Image();
    img.onload = () => flagCtx.drawImage(img, 0, 0);
    img.src = saved;
  }
} catch { /* storage unavailable */ }
let drawingFlag = null; // last point while the pointer is down
const flagPoint = (e) => {
  const rect = flagCanvas.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) / rect.width) * flagCanvas.width, y: ((e.clientY - rect.top) / rect.height) * flagCanvas.height };
};
flagCanvas.addEventListener('pointerdown', (e) => {
  flagCanvas.setPointerCapture(e.pointerId);
  drawingFlag = flagPoint(e);
  flagCtx.fillStyle = '#000';
  flagCtx.beginPath();
  flagCtx.arc(drawingFlag.x, drawingFlag.y, FLAG_BRUSH / 2, 0, Math.PI * 2);
  flagCtx.fill();
});
flagCanvas.addEventListener('pointermove', (e) => {
  if (!drawingFlag) return;
  const p = flagPoint(e);
  flagCtx.strokeStyle = '#000';
  flagCtx.lineWidth = FLAG_BRUSH;
  flagCtx.lineCap = 'round';
  flagCtx.beginPath();
  flagCtx.moveTo(drawingFlag.x, drawingFlag.y);
  flagCtx.lineTo(p.x, p.y);
  flagCtx.stroke();
  drawingFlag = p;
});
const endFlagStroke = () => {
  if (!drawingFlag) return;
  drawingFlag = null;
  try { localStorage.setItem('flagDrawing', flagCanvas.toDataURL('image/png')); } catch { /* storage unavailable */ }
};
flagCanvas.addEventListener('pointerup', endFlagStroke);
flagCanvas.addEventListener('pointercancel', endFlagStroke);
$('flag-clear').addEventListener('click', () => {
  flagCtx.clearRect(0, 0, flagCanvas.width, flagCanvas.height);
  try { localStorage.removeItem('flagDrawing'); } catch { /* storage unavailable */ }
});

// The drawing as white on transparent, or null when nothing was drawn
function exportFlag() {
  const { data } = flagCtx.getImageData(0, 0, flagCanvas.width, flagCanvas.height);
  if (!data.some((v, i) => i % 4 === 3 && v > 0)) return null;
  const out = document.createElement('canvas');
  out.width = flagCanvas.width;
  out.height = flagCanvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(flagCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ---- Lobby ----
$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('room:create', { roomName: $('room-name').value, playerName: playerName(), flag: exportFlag() });
  $('room-name').value = '';
});

socket.on('lobby:rooms', (rooms) => {
  const list = $('room-list');
  list.replaceChildren();
  if (!rooms.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Aún no hay salas — ¡crea una!';
    list.append(li);
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const status = { playing: '(en partida)', finished: '(terminada)' }[room.status] ?? '';
    label.textContent = `${room.name} — ${room.players}/${room.max} ${status}`;
    const btn = document.createElement('button');
    btn.textContent = 'Unirse';
    btn.disabled = room.status !== 'waiting' || room.players >= room.max;
    btn.addEventListener('click', () => socket.emit('room:join', { roomId: room.id, playerName: playerName(), flag: exportFlag() }));
    li.append(label, btn);
    list.append(li);
  }
});

socket.on('lobby:error', ({ message }) => {
  $(currentRoom ? 'room-error' : 'lobby-error').textContent = message;
});

// ---- Room ----
socket.on('room:update', (room) => {
  currentRoom = room;
  $('lobby-error').textContent = '';
  $('room-title').textContent = room.name;
  const isHost = room.hostId === myId;
  $('room-info').textContent = isHost
    ? 'Eres el anfitrión. Inicia la partida cuando estén todos.'
    : 'Esperando a que el anfitrión inicie la partida…';

  const list = $('player-list');
  list.replaceChildren();
  for (const p of room.players) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = hex(p.color);
    name.append(swatch, `${p.name}${p.id === myId ? ' (tú)' : ''}`);
    const tag = document.createElement('span');
    tag.className = 'muted';
    tag.textContent = p.id === room.hostId ? 'anfitrión' : '';
    li.append(name, tag);
    list.append(li);
  }

  $('start-btn').classList.toggle('hidden', !isHost);
  if (room.status === 'waiting') show('room');
});

$('start-btn').addEventListener('click', () => socket.emit('room:start'));
$('leave-btn').addEventListener('click', () => socket.emit('room:leave'));

socket.on('room:left', () => {
  currentRoom = null;
  $('game-over').classList.add('hidden');
  game?.destroy();
  game = null;
  show('lobby');
});

// ---- Game ----
socket.on('game:start', async (data) => {
  show('game');
  $('game-over').classList.add('hidden');
  game?.destroy();
  game = new Game(socket, myId, $('game'), {
    hud: $('hud'), tooltip: $('tooltip'), buildMenu: $('build-menu'), message: $('message'),
  });
  await game.init(data);
});

socket.on('game:state', (state) => game?.applyState(state));
socket.on('game:resources', (changes) => game?.applyResourceChanges(changes));
socket.on('game:shots', (shots) => game?.addShots(shots));
socket.on('game:error', ({ message }) => game?.showMessage(message));
socket.on('game:notice', ({ message }) => game?.showMessage(message, 'notice'));

const formatDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Gold and faction-coloured confetti raining down on a win
function launchConfetti(colors) {
  const box = $('confetti');
  box.replaceChildren(...Array.from({ length: 120 }, () => {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${2.5 + Math.random() * 3}s`;
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    return piece;
  }));
}

function renderStats(players, winnerId) {
  const table = $('end-stats');
  table.replaceChildren();
  if (!players?.length) return;
  const head = document.createElement('tr');
  for (const h of ['Jugador', 'Entrenadas', 'Bajas', 'Perdidas', 'Recolectado']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  table.append(head);
  for (const p of players) {
    const tr = document.createElement('tr');
    tr.classList.toggle('winner', p.id === winnerId);
    const name = document.createElement('td');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = hex(p.color);
    name.append(swatch, `${p.id === winnerId ? '👑 ' : ''}${p.name}`);
    tr.append(name, ...[p.stats.trained, p.stats.kills, p.stats.lost, p.stats.gathered].map((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      return td;
    }));
    table.append(tr);
  }
}

const showEndScreen = ({
  title, text, won, faction, canSpectate, duration, players, winnerId,
}) => {
  const overlay = $('game-over');
  // Restart the CSS entrance animations
  overlay.classList.add('hidden');
  void overlay.offsetWidth;
  overlay.classList.toggle('lost', !won);
  const color = faction ?? (won ? 'yellow' : 'black');
  $('end-ribbon').style.borderImageSource = `url('/assets/ui/ribbon_${won ? 'yellow' : color}.png')`;
  $('sword-left').src = `/assets/ui/sword_${color}.png`;
  $('sword-right').src = `/assets/ui/sword_${color}.png`;
  $('game-over-title').textContent = title;
  $('game-over-text').textContent = text;
  $('game-over-time').textContent = duration ? `Duración de la partida: ${formatDuration(duration)}` : '';
  renderStats(players, winnerId);
  if (won) launchConfetti(['#ffd34d', '#fff3c4', '#f0a030', '#3b82f6', '#e74c3c', '#ffffff']);
  else $('confetti').replaceChildren();
  $('spectate-btn').classList.toggle('hidden', !canSpectate);
  overlay.classList.remove('hidden');
};
socket.on('game:defeated', () => showEndScreen({
  title: 'DERROTA', text: 'Todos tus Centros urbanos fueron destruidos.', won: false, canSpectate: true,
}));
socket.on('game:over', ({
  winnerId, winnerName, winnerFaction, reason, duration, players,
}) => {
  const won = winnerId === myId;
  const text = winnerName ? `¡${won ? 'Tu reino' : winnerName} ${reason}!` : `Sin ganador: ${reason}.`;
  showEndScreen({
    title: won ? '¡VICTORIA!' : (winnerName ? 'FIN DE LA PARTIDA' : 'EMPATE'),
    text, won, faction: winnerFaction, canSpectate: false, duration, players, winnerId,
  });
});
$('spectate-btn').addEventListener('click', () => $('game-over').classList.add('hidden'));
$('back-btn').addEventListener('click', () => socket.emit('room:leave'));

socket.on('disconnect', () => {
  currentRoom = null;
  game?.destroy();
  game = null;
  show('lobby');
  $('lobby-error').textContent = 'Desconectado del servidor. Reconectando…';
});
socket.on('connect', () => { $('lobby-error').textContent = ''; });
