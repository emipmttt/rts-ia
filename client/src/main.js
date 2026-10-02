import { io } from 'socket.io-client';
import { Game } from './game.js';

const socket = io(import.meta.env.DEV ? `http://${location.hostname}:3001` : undefined);
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
if (!nameInput.value) nameInput.value = `Player${Math.floor(Math.random() * 1000)}`;
nameInput.addEventListener('change', () => {
  try { localStorage.setItem('playerName', nameInput.value); } catch { /* storage unavailable */ }
});
const playerName = () => nameInput.value.trim();

// ---- Lobby ----
$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('room:create', { roomName: $('room-name').value, playerName: playerName() });
  $('room-name').value = '';
});

socket.on('lobby:rooms', (rooms) => {
  const list = $('room-list');
  list.replaceChildren();
  if (!rooms.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No rooms yet — create one!';
    list.append(li);
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const status = { playing: '(in game)', finished: '(finished)' }[room.status] ?? '';
    label.textContent = `${room.name} — ${room.players}/${room.max} ${status}`;
    const btn = document.createElement('button');
    btn.textContent = 'Join';
    btn.disabled = room.status !== 'waiting' || room.players >= room.max;
    btn.addEventListener('click', () => socket.emit('room:join', { roomId: room.id, playerName: playerName() }));
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
  const isHost = room.hostId === socket.id;
  $('room-info').textContent = isHost
    ? 'You are the host. Start the game when everyone is in.'
    : 'Waiting for the host to start the game…';

  const list = $('player-list');
  list.replaceChildren();
  for (const p of room.players) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = hex(p.color);
    name.append(swatch, `${p.name}${p.id === socket.id ? ' (you)' : ''}`);
    const tag = document.createElement('span');
    tag.className = 'muted';
    tag.textContent = p.id === room.hostId ? 'host' : '';
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
  game = new Game(socket, $('game'), {
    hud: $('hud'), tooltip: $('tooltip'), buildMenu: $('build-menu'), message: $('message'),
  });
  await game.init(data);
});

socket.on('game:state', (state) => game?.applyState(state));
socket.on('game:resources', (changes) => game?.applyResourceChanges(changes));
socket.on('game:shots', (shots) => game?.addShots(shots));
socket.on('game:error', ({ message }) => game?.showMessage(message));
socket.on('game:notice', ({ message }) => game?.showMessage(message, 'notice'));

const showEndScreen = (title, text, canSpectate) => {
  $('game-over-title').textContent = title;
  $('game-over-text').textContent = text;
  $('spectate-btn').classList.toggle('hidden', !canSpectate);
  $('game-over').classList.remove('hidden');
};
socket.on('game:defeated', () => showEndScreen('Defeated', 'All your Town Centers were destroyed.', true));
socket.on('game:over', ({ winnerId, winnerName, reason }) => {
  const won = winnerId === socket.id;
  const text = winnerName ? `${won ? 'You' : winnerName} ${reason}.` : `No winner: ${reason}.`;
  showEndScreen(won ? 'Victory!' : 'Game over', text, false);
});
$('spectate-btn').addEventListener('click', () => $('game-over').classList.add('hidden'));
$('back-btn').addEventListener('click', () => socket.emit('room:leave'));

socket.on('disconnect', () => {
  currentRoom = null;
  game?.destroy();
  game = null;
  show('lobby');
  $('lobby-error').textContent = 'Disconnected from server. Reconnecting…';
});
socket.on('connect', () => { $('lobby-error').textContent = ''; });
