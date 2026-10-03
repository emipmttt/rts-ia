import { randomUUID } from 'node:crypto';
import { GameRoom, RoomStatus } from './GameRoom.js';

const cleanName = (value, fallback, max = 20) => String(value ?? '').trim().slice(0, max) || fallback;
const CLEANUP_INTERVAL_MS = 30 * 1000;

// Players are identified by socket.data.playerId, which survives reconnects (see index.js).
// Every socket of a player joins a socket.io room named after that id.
export class Lobby {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> GameRoom
    this.playerRoom = new Map(); // playerId -> roomId
    // Close running games whose players all left and never came back
    setInterval(() => {
      for (const room of this.rooms.values()) if (room.abandoned) this.closeRoom(room);
    }, CLEANUP_INTERVAL_MS).unref();
  }

  list() { return [...this.rooms.values()].map((r) => r.summary()); }

  broadcastRooms() { this.io.emit('lobby:rooms', this.list()); }

  roomOf(socket) { return this.rooms.get(this.playerRoom.get(socket.data.playerId)); }

  create(socket, { roomName, playerName, flag } = {}) {
    this.leave(socket);
    const id = randomUUID().slice(0, 8);
    const room = new GameRoom(this.io, id, cleanName(roomName, `Sala ${id}`, 30), socket.data.playerId);
    room.onStatusChange = () => this.broadcastRooms();
    this.rooms.set(id, room);
    this.enter(socket, room, playerName, flag);
  }

  join(socket, { roomId, playerName, flag } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return socket.emit('lobby:error', { message: 'Sala no encontrada' });
    if (room === this.roomOf(socket)) return;
    if (room.status !== RoomStatus.WAITING) return socket.emit('lobby:error', { message: 'La partida ya comenzó' });
    if (room.isFull) return socket.emit('lobby:error', { message: 'La sala está llena' });
    this.leave(socket);
    this.enter(socket, room, playerName, flag);
  }

  enter(socket, room, playerName, flag) {
    const { playerId } = socket.data;
    this.io.in(playerId).socketsJoin(room.id);
    room.addPlayer(playerId, cleanName(playerName, 'Jugador'), flag);
    this.playerRoom.set(playerId, room.id);
    this.broadcastRooms();
  }

  // Explicit leave: the player and their village are removed
  leave(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    const { playerId } = socket.data;
    room.removePlayer(playerId);
    this.playerRoom.delete(playerId);
    this.io.in(playerId).socketsLeave(room.id);
    this.io.to(playerId).emit('room:left');
    if (room.isEmpty) this.closeRoom(room);
    this.broadcastRooms();
  }

  closeRoom(room) {
    room.destroy();
    for (const id of room.players.keys()) this.playerRoom.delete(id);
    this.io.in(room.id).socketsLeave(room.id);
    this.rooms.delete(room.id);
    this.broadcastRooms();
  }

  // A socket connected: if its player is still in a room, put them back where they were
  reconnect(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    const { playerId } = socket.data;
    if (room.status === RoomStatus.FINISHED) { this.leave(socket); return; }
    socket.join(room.id);
    socket.emit('room:update', room.details());
    if (room.status === RoomStatus.PLAYING) {
      room.setConnected(playerId, true);
      socket.emit('game:start', room.startPayload());
      if (room.players.get(playerId)?.defeated) socket.emit('game:defeated');
    }
  }

  // The player's last socket went away. In a running game their village stays so they can come back;
  // in a waiting room they simply leave.
  disconnect(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    if (room.status === RoomStatus.PLAYING) room.setConnected(socket.data.playerId, false);
    else this.leave(socket);
  }

  start(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('lobby:error', { message: 'Solo el anfitrión puede iniciar la partida' });
    room.start();
    this.broadcastRooms();
  }
}
