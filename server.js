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

// ==================== Модели Mongoose ====================
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  is_neon: { type: Boolean, default: false },
  wins: { type: Number, default: 0 }
});

const MapSchema = new mongoose.Schema({
  name: { type: String, required: true },
  author_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  data: { type: Object, required: true },
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Map = mongoose.model('Map', MapSchema);

// ==================== Подключение к MongoDB ====================
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB подключена');
    const neon = await User.findOne({ is_neon: true });
    if (!neon) {
      await User.create({ username: 'Neon', password: NEON_HASH, is_neon: true, wins: 0 });
      console.log('Аккаунт Neon создан');
    }
  } catch (err) {
    console.error('Ошибка подключения к MongoDB:', err);
    process.exit(1);
  }
}
connectDB();

// ==================== Middleware ====================
app.use(express.json());
app.use(express.static('client'));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const dec = jwt.verify(token, JWT_SECRET);
    req.userId = dec.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== REST API ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Fields required' });
    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username exists' });
    const hash = bcrypt.hashSync(password, 10);
    const user = await User.create({ username, password: hash });
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username: user.username, is_neon: user.is_neon } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Bad credentials' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username: user.username, is_neon: user.is_neon } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/maps', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.is_neon) return res.status(403).json({ error: 'Neon only' });
    const { name, data } = req.body;
    const map = await Map.create({ name, author_id: req.userId, data });
    res.json({ success: true, id: map._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/maps', auth, async (req, res) => {
  try {
    const maps = await Map.find({}, 'name author_id created_at');
    res.json(maps);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/maps/:id', auth, async (req, res) => {
  try {
    const map = await Map.findById(req.params.id);
    if (!map) return res.status(404).json({ error: 'Not found' });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const top = await User.find({}, 'username wins').sort({ wins: -1 }).limit(50);
    res.json(top);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/win', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { $inc: { wins: 1 } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// ==================== Управление лобби (Железобетонная версия) ====================
class LobbyManager {
  constructor() {
    this._lobbies = {}; 
  }

  getAll() {
    return this._lobbies;
  }

  get(id) {
    return this._lobbies[id] || null;
  }

  set(id, lobby) {
    if (typeof this._lobbies !== 'object' || this._lobbies === null) {
      this._lobbies = {};
    }
    this._lobbies[id] = lobby;
  }

  delete(id) {
    if (this._lobbies && this._lobbies[id]) {
      delete this._lobbies[id];
    }
  }

  has(id) {
    return !!(this._lobbies && this._lobbies[id]);
  }

  getWaitingList() {
    const list = [];
    if (typeof this._lobbies !== 'object' || this._lobbies === null) {
      return list;
    }

    const keys = Object.keys(this._lobbies);
    for (const id of keys) {
      const lobby = this._lobbies[id];
      if (lobby && lobby.state === 'waiting') {
        list.push({
          id: id,
          host: (lobby.players && lobby.players[0]) ? lobby.players[0].username : 'Unknown',
          players: lobby.players ? lobby.players.length : 0
        });
      }
    }
    return list;
  }

  forEach(callback) {
    if (typeof this._lobbies !== 'object' || this._lobbies === null) return;
    Object.keys(this._lobbies).forEach(id => {
      callback(this._lobbies[id], id);
    });
  }

  isValid() {
    return typeof this._lobbies === 'object' && this._lobbies !== null;
  }
}

const lobbyManager = new LobbyManager();

// ==================== Функции рассылки списков лобби ====================
function sendLobbyList(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'lobby_list',
      lobbies: lobbyManager.getWaitingList()
    }));
  }
}

function broadcastLobbyList() {
  const payload = JSON.stringify({
    type: 'lobby_list',
    lobbies: lobbyManager.getWaitingList()
  });

  for (const [ws, client] of clients.entries()) {
    if (client && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// Периодическое обновление списка для всех клиентов
setInterval(broadcastLobbyList, 4000);

// ==================== WebSocket Сервер ====================
const clients = new Map(); // ws -> { user, lobbyId, peerId }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'auth': {
        try {
          const dec = jwt.verify(msg.token, JWT_SECRET);
          User.findById(dec.id).then(user => {
            if (!user) {
              ws.send(JSON.stringify({ type: 'error', text: 'User not found' }));
              return;
            }
            clients.set(ws, {
              user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon },
              lobbyId: null,
              peerId: null
            });
            ws.send(JSON.stringify({
              type: 'auth_ok',
              user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon }
            }));
            sendLobbyList(ws);
          });
        } catch {
          ws.send(JSON.stringify({ type: 'error', text: 'Auth failed' }));
        }
        break;
      }

      case 'create_lobby': {
        const client = clients.get(ws);
        if (!client) return;

        let alreadyHas = false;
        lobbyManager.forEach((lobby) => {
          if (lobby.host === client.user.id && lobby.state !== 'finished') {
            alreadyHas = true;
          }
        });

        if (alreadyHas) {
          ws.send(JSON.stringify({ type: 'error', text: 'У вас уже есть активное лобби' }));
          break;
        }

        const lobbyId = uuidv4();
        const newLobby = {
          id: lobbyId,
          host: client.user.id,
          state: 'waiting',
          players: [{ id: client.user.id, username: client.user.username, ws }]
        };

        lobbyManager.set(lobbyId, newLobby);
        client.lobbyId = lobbyId;
        
        ws.send(JSON.stringify({ type: 'lobby_created', lobbyId }));
        broadcastLobbyList();
        break;
      }

      case 'join_lobby': {
        const client = clients.get(ws);
        if (!client || !msg.lobbyId) return;

        const lobby = lobbyManager.get(msg.lobbyId);
        if (!lobby || lobby.state !== 'waiting') {
          ws.send(JSON.stringify({ type: 'error', text: 'Лобби недоступно' }));
          break;
        }

        lobby.players.push({ id: client.user.id, username: client.user.username, ws });
        client.lobbyId = msg.lobbyId;

        ws.send(JSON.stringify({ type: 'joined_lobby', lobbyId: msg.lobbyId }));
        broadcastLobbyList();
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.lobbyId) {
      const lobby = lobbyManager.get(client.lobbyId);
      if (lobby) {
        lobby.players = lobby.players ? lobby.players.filter(p => p.id !== client.user.id) : [];
        if (lobby.players.length === 0 || lobby.host === client.user.id) {
(client.lobbyId);}}}clients.delete(ws);broadcastLobbyList();});});
// ==================== Старт сервера ====================
const PORT = process.env.PORT || 3000;server.listen(PORT, () => {console.log(Сервер запущен на порту ${PORT});});
