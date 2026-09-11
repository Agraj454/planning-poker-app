const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store.
// rooms = {
//   [roomCode]: {
//     story: string,
//     phase: 'voting' | 'revealed',
//     participants: { [socketId]: { name: string, vote: string|null, joinedAt: number } }
//   }
// }
const rooms = {};

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = { story: '', phase: 'voting', participants: {} };
  }
  return rooms[code];
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('room-update', { roomCode: code, ...room });
}

function cleanupIfEmpty(code) {
  const room = rooms[code];
  if (room && Object.keys(room.participants).length === 0) {
    delete rooms[code];
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ roomCode, name }) => {
    if (!roomCode || !name) return;
    const code = String(roomCode).trim().toLowerCase();
    const cleanName = String(name).trim().slice(0, 20);
    if (!code || !cleanName) return;

    currentRoom = code;
    socket.join(code);

    const room = getOrCreateRoom(code);
    room.participants[socket.id] = {
      name: cleanName,
      vote: null,
      joinedAt: Date.now(),
    };

    broadcastRoom(code);
  });

  socket.on('set-story', (story) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].story = String(story || '').slice(0, 200);
    broadcastRoom(currentRoom);
  });

  socket.on('vote', (card) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase === 'revealed') return;
    const me = room.participants[socket.id];
    if (!me) return;
    me.vote = card;
    broadcastRoom(currentRoom);
  });

  socket.on('reveal', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const anyVotes = Object.values(room.participants).some((p) => p.vote !== null);
    if (!anyVotes) return;
    room.phase = 'revealed';
    broadcastRoom(currentRoom);
  });

  socket.on('new-round', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.phase = 'voting';
    Object.values(room.participants).forEach((p) => (p.vote = null));
    broadcastRoom(currentRoom);
  });

  socket.on('leave', () => {
    leaveCurrentRoom();
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].participants[socket.id];
      socket.leave(currentRoom);
      broadcastRoom(currentRoom);
      cleanupIfEmpty(currentRoom);
    }
    currentRoom = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Planning poker server listening on port ${PORT}`);
});
