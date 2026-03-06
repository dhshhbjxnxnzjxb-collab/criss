const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Room storage ──────────────────────────────────────────────
// rooms[code] = { code, hostId, players: { socketId: { id, name, avatar, score, ready } }, state, countdown }
const rooms = {};

function genCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms[code]);
  return code;
}

function roomPublic(room) {
  return {
    code:    room.code,
    state:   room.state,
    players: Object.values(room.players).map(p => ({
      id:     p.id,
      name:   p.name,
      avatar: p.avatar,
      score:  p.score,
      isHost: p.id === room.hostId,
    })),
  };
}

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── Create Room ──
  socket.on('create_room', ({ name, avatar }, cb) => {
    const code = genCode();
    rooms[code] = {
      code,
      hostId:    socket.id,
      state:     'waiting',    // waiting | countdown | playing | ended
      countdown: null,
      players: {
        [socket.id]: { id: socket.id, name, avatar, score: 0, ready: false }
      }
    };
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, roomData: roomPublic(rooms[code]) });
    console.log('Room created', code);
  });

  // ── Join Room ──
  socket.on('join_room', ({ code, name, avatar }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Oda bulunamadı!' });
    if (Object.keys(room.players).length >= 2) return cb({ ok: false, error: 'Oda dolu!' });
    if (room.state !== 'waiting') return cb({ ok: false, error: 'Oyun başladı!' });

    room.players[socket.id] = { id: socket.id, name, avatar, score: 0, ready: false };
    socket.join(code);
    socket.data.roomCode = code;

    io.to(code).emit('room_update', roomPublic(room));
    cb({ ok: true, code, roomData: roomPublic(room) });

    // 2 players → start countdown
    if (Object.keys(room.players).length === 2) {
      startCountdown(code);
    }
  });

  // ── Score update ──
  socket.on('score_update', ({ score }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.players[socket.id]) {
      room.players[socket.id].score = score;
      io.to(code).emit('room_update', roomPublic(room));
    }
  });

  // ── Close Room (host only) ──
  socket.on('close_room', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.hostId !== socket.id) return;
    io.to(code).emit('room_closed');
    deleteRoom(code);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      deleteRoom(code);
    } else {
      // Assign new host if host left
      if (room.hostId === socket.id) {
        room.hostId = Object.keys(room.players)[0];
      }
      if (room.state === 'playing' || room.state === 'countdown') {
        room.state = 'waiting';
        if (room.countdownInterval) clearInterval(room.countdownInterval);
      }
      io.to(code).emit('player_left', { id: socket.id });
      io.to(code).emit('room_update', roomPublic(room));
    }
  });
});

function startCountdown(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'countdown';
  io.to(code).emit('room_update', roomPublic(room));

  let count = 3;
  io.to(code).emit('countdown', count);

  room.countdownInterval = setInterval(() => {
    count--;
    if (count > 0) {
      io.to(code).emit('countdown', count);
    } else {
      clearInterval(room.countdownInterval);
      room.state = 'playing';
      io.to(code).emit('game_start');
      io.to(code).emit('room_update', roomPublic(room));
    }
  }, 1000);
}

function deleteRoom(code) {
  if (rooms[code]) {
    if (rooms[code].countdownInterval) clearInterval(rooms[code].countdownInterval);
    delete rooms[code];
    console.log('Room deleted', code);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Block Blast server running on http://localhost:${PORT}`));
