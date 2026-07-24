// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/projectneon';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-123';
const NEON_PASSWORD = process.env.NEON_PASSWORD || 'pnshooter888Qcod5';
const NEON_HASH = bcrypt.hashSync(NEON_PASSWORD, 10);

// Модели Mongoose
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  is_neon: { type: Boolean, default: false },
  wins: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

const MapSchema = new mongoose.Schema({
  name: String,
  author_id: mongoose.Schema.Types.ObjectId,
  data: Object,
  created_at: { type: Date, default: Date.now }
});
const Map = mongoose.model('Map', MapSchema);

// Подключение к MongoDB
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB OK');
    if (!await User.findOne({ is_neon: true })) {
      await User.create({ username: 'Neon', password: NEON_HASH, is_neon: true });
    }
  } catch (err) {
    console.error('MongoDB error:', err.message);
  }
}

app.use(express.json());
app.use(express.static('client'));

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// API
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Fields required' });
    if (await User.findOne({ username })) return res.status(409).json({ error: 'Exists' });
    const user = await User.create({ username, password: bcrypt.hashSync(password, 10) });
    res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET), user: { id: user._id, username, is_neon: false } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Bad credentials' });
    res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET), user: { id: user._id, username, is_neon: user.is_neon } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const top = await User.find({}, 'username wins').sort({ wins: -1 }).limit(50);
    res.json(top);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/maps', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user?.is_neon) return res.status(403).json({ error: 'Neon only' });
    await Map.create({ name: req.body.name, author_id: req.userId, data: req.body.data });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maps', auth, async (req, res) => {
  try {
    res.json(await Map.find({}, 'name created_at'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maps/:id', auth, async (req, res) => {
  try {
    const map = await Map.findById(req.params.id);
    if (!map) return res.status(404).json({ error: 'Not found' });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// ==================== WebSocket (лёгкий) ====================
const clients = new Map();      // ws -> { user, lobbyId }
const lobbies = new Map();      // id -> { host, players[], state }

// Отправка списка лобби только по запросу, без таймера
function sendLobbyList(ws) {
  const list = [];
  for (const [id, l] of lobbies) {
    if (l.state === 'waiting') list.push({ id, host: l.players[0]?.username, players: l.players.length });
  }
  try { ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list })); } catch (e) {}
}

// Рассылка обновления состава конкретного лобби
function updateLobbyPlayers(lobby) {
  const players = lobby.players.map(p => ({ id: p.id, username: p.username }));
  for (const p of lobby.players) {
    try { p.ws.send(JSON.stringify({ type: 'lobby_update', players })); } catch (e) {}
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      switch (msg.type) {
        case 'auth': {
          const dec = jwt.verify(msg.token, JWT_SECRET);
          User.findById(dec.id).then(user => {
            if (!user) return ws.send(JSON.stringify({ type: 'error', text: 'User not found' }));
            clients.set(ws, { user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon }, lobbyId: null });
            ws.send(JSON.stringify({ type: 'auth_ok', user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon } }));
            sendLobbyList(ws);
          }).catch(() => ws.send(JSON.stringify({ type: 'error', text: 'DB error' })));
          break;
        }
        case 'lobby_list': {
          sendLobbyList(ws);
          break;
        }
        case 'create_lobby': {
          const client = clients.get(ws);
          if (!client) return;
          // Проверка на дубликат
          for (const [id, l] of lobbies) {
            if (l.host === client.user.id && l.state !== 'finished') {
              return ws.send(JSON.stringify({ type: 'error', text: 'У вас уже есть лобби' }));
            }
          }
          const lobbyId = uuidv4().slice(0, 6);
          const lobby = {
            id: lobbyId,
            host: client.user.id,
            players: [{ id: client.user.id, username: client.user.username, ws }],
            state: 'waiting'
          };
          lobbies.set(lobbyId, lobby);
          client.lobbyId = lobbyId;
          ws.send(JSON.stringify({ type: 'lobby_created', lobbyId }));
          updateLobbyPlayers(lobby);
          break;
        }
        case 'join_lobby': {
          const client = clients.get(ws);
          if (!client) return;
          const lobby = lobbies.get(msg.lobbyId);
          if (!lobby || lobby.state !== 'waiting') {
            return ws.send(JSON.stringify({ type: 'error', text: 'Лобби недоступно' }));
          }
          if (lobby.players.length >= 10) {
            return ws.send(JSON.stringify({ type: 'error', text: 'Лобби заполнено' }));
          }
          lobby.players.push({ id: client.user.id, username: client.user.username, ws });
          client.lobbyId = lobby.id;
          updateLobbyPlayers(lobby);
          break;
        }
        case 'leave_lobby': {
          const client = clients.get(ws);
          if (!client?.lobbyId) return;
          const lobby = lobbies.get(client.lobbyId);
          if (lobby) {
            lobby.players = lobby.players.filter(p => p.ws !== ws);
            if (lobby.players.length === 0) lobbies.delete(client.lobbyId);
            else updateLobbyPlayers(lobby);
          }
          client.lobbyId = null;
          break;
        }
        case 'start_game': {
          const client = clients.get(ws);
          if (!client?.lobbyId) return;
          const lobby = lobbies.get(client.lobbyId);
          if (!lobby || lobby.host !== client.user.id || lobby.players.length < 2) return;
          lobby.state = 'starting';
          for (const p of lobby.players) {
            try { p.ws.send(JSON.stringify({ type: 'game_starting', delay: 5 })); } catch (e) {}
          }
          break;
        }
      }
    } catch (err) {
      console.error('WS error:', err.message);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.lobbyId) {
      const lobby = lobbies.get(client.lobbyId);
      if (lobby) {
        lobby.players = lobby.players.filter(p => p.ws !== ws);
        if (lobby.players.length === 0) lobbies.delete(client.lobbyId);
        else updateLobbyPlayers(lobby);
      }
    }
    clients.delete(ws);
  });
});

// Запуск
connectDB().then(() => {
  server.listen(process.env.PORT || 3000, () => console.log('Server running'));
});
