import { randomUUID } from 'node:crypto';
import { GameRoom, RoomStatus } from './GameRoom.js';

const cleanName = (value, fallback, max = 20) => String(value ?? '').trim().slice(0, max) || fallback;

export class Lobby {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> GameRoom
    this.playerRoom = new Map(); // socketId -> roomId
  }

  list() { return [...this.rooms.values()].map((r) => r.summary()); }

  broadcastRooms() { this.io.emit('lobby:rooms', this.list()); }

  roomOf(socket) { return this.rooms.get(this.playerRoom.get(socket.id)); }

  create(socket, { roomName, playerName } = {}) {
    this.leave(socket);
    const id = randomUUID().slice(0, 8);
    const room = new GameRoom(this.io, id, cleanName(roomName, `Sala ${id}`, 30), socket.id);
    room.onStatusChange = () => this.broadcastRooms();
    this.rooms.set(id, room);
    this.enter(socket, room, playerName);
  }

  join(socket, { roomId, playerName } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return socket.emit('lobby:error', { message: 'Sala no encontrada' });
    if (room === this.roomOf(socket)) return;
    if (room.status !== RoomStatus.WAITING) return socket.emit('lobby:error', { message: 'La partida ya comenzó' });
    if (room.isFull) return socket.emit('lobby:error', { message: 'La sala está llena' });
    this.leave(socket);
    this.enter(socket, room, playerName);
  }

  enter(socket, room, playerName) {
    room.addPlayer(socket, cleanName(playerName, 'Jugador'));
    this.playerRoom.set(socket.id, room.id);
    this.broadcastRooms();
  }

  leave(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    room.removePlayer(socket);
    this.playerRoom.delete(socket.id);
    socket.emit('room:left');
    if (room.isEmpty) {
      room.destroy();
      this.rooms.delete(room.id);
    }
    this.broadcastRooms();
  }

  start(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('lobby:error', { message: 'Solo el anfitrión puede iniciar la partida' });
    room.start();
    this.broadcastRooms();
  }
}
