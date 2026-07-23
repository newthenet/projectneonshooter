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

// ==================== Хранилище лобби с защитой ====================
let lobbies = new Map(); // Объявляем как let, чтобы можно было пересоздать

// Функция для безопасной итерации по лобби
function forEachLobby(callback) {
  // Если вдруг lobbies перестала быть Map – пересоздаём
  if (!(lobbies instanceof Map)) {
    console.warn('⚠️ lobbies переопределена! Пересоздаём Map.');
    lobbies = new Map();
  }
  for (const [id, lobby] of lobbies) {
    callback(id, lobby);
  }
}

// Получить список ожидающих лобби для трансляции
function getWaitingLobbies() {
  if (!(lobbies instanceof Map)) {
    console.warn('⚠️ lobbies не Map в getWaitingLobbies, пересоздаём');
    lobbies = new Map();
  }
  const list = [];
  for (const [id, lobby] of lobbies) {
    if (lobby.state === 'waiting') {
      list.push({
        id,
        host: lobby.players[0]?.username || 'Unknown',
        players: lobby.players.length
      });
    }
  }
  return list;
}

// ==================== WebSocket ====================
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

        // Проверяем, нет ли уже активного лобби у этого пользователя
        let alreadyHas = false;
        forEachLobby((id, lobby) => {
          if (lobby.host === client.user.id && lobby.state !== 'finished') {
            alreadyHas = true;
          }
        });
        if (alreadyHas) {
          ws.send(JSON.stringify({ type: 'error', text: 'У вас уже есть активное лобби' }));
          return;
        }

        const lobbyId = uuidv4().slice(0, 6);
        const lobby = {
          id: lobbyId,
          host: client.user.id,
          players: [{ id: client.user.id, username: client.user.username, ws }],
          state: 'waiting',
          mapData: null,
          round: 0
        };
        lobbies.set(lobbyId, lobby);
        client.lobbyId = lobbyId;
        client.peerId = client.user.id;

        ws.send(JSON.stringify({ type: 'lobby_created', lobbyId }));
        ws.send(JSON.stringify({
          type: 'lobby_update',
          players: lobby.players.map(p => ({ id: p.id, username: p.username }))
        }));
        broadcastLobbyList();
        break;
      }

      case 'join_lobby': {
        const client = clients.get(ws);
        if (!client) return;

        const lobby = lobbies.get(msg.lobbyId);
        if (!lobby || lobby.state !== 'waiting') {
          ws.send(JSON.stringify({ type: 'error', text: 'Лобби недоступно' }));
          return;
        }
        if (lobby.players.length >= 10) {
          ws.send(JSON.stringify({ type: 'error', text: 'Лобби заполнено' }));
          return;
        }
        if (lobby.players.some(p => p.id === client.user.id)) {
          ws.send(JSON.stringify({ type: 'error', text: 'Вы уже в этом лобби' }));
          return;
        }

        lobby.players.push({ id: client.user.id, username: client.user.username, ws });
        client.lobbyId = lobby.id;
        client.peerId = client.user.id;

        lobby.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'lobby_update',
          players: lobby.players.map(p => ({ id: p.id, username: p.username }))
        })));
        broadcastLobbyList();
        break;
      }

      case 'set_map': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.host !== client.user.id) return;
        lobby.mapData = msg.mapData;
        break;
      }

      case 'start_game': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.host !== client.user.id || lobby.players.length < 2) {
          ws.send(JSON.stringify({ type: 'error', text: 'Недостаточно игроков или вы не хост' }));
          return;
        }
        lobby.state = 'starting';
        lobby.players.forEach(p => p.ws.send(JSON.stringify({ type: 'game_starting', delay: 5 })));

        setTimeout(() => {
          if (lobby.state !== 'starting') return;
          lobby.state = 'playing';
          lobby.round = 1;
          lobby.players.forEach((p, i) => {
            p.team = i % 2 === 0 ? 't' : 'ct';
          });
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'game_started',
            players: lobby.players.map(p => ({ id: p.id, username: p.username, team: p.team })),
            mapData: lobby.mapData
          })));
          broadcastLobbyList();
        }, 5000);
        break;
      }

      case 'signal': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby) return;
        const target = lobby.players.find(p => p.id === msg.target);
        if (target) {
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: client.user.id,
            data: msg.data
          }));
        }
        break;
      }

      case 'leave_lobby': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby) return;

        lobby.players = lobby.players.filter(p => p.ws !== ws);
        if (lobby.players.length === 0) {
          lobbies.delete(client.lobbyId);
        } else {
          if (lobby.host === client.user.id) lobby.host = lobby.players[0].id;
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'lobby_update',
            players: lobby.players.map(p => ({ id: p.id, username: p.username }))
          })));
        }
        client.lobbyId = null;
        broadcastLobbyList();
        break;
      }

      case 'game_over': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby) return;

        if (msg.winnerTeam) {
          lobby.players.forEach(p => {
            if (p.team === msg.winnerTeam) {
              User.findByIdAndUpdate(p.id, { $inc: { wins: 1 } }).exec();
            }
          });
        }
        lobby.state = 'finished';
        lobbies.delete(client.lobbyId);
        broadcastLobbyList();
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.lobbyId) {
      const lobby = lobbies.get(client.lobbyId);
      if (lobby) {
        lobby.players = lobby.players.filter(p => p.ws !== ws);
        if (lobby.players.length === 0) {
          lobbies.delete(client.lobbyId);
        } else {
          if (lobby.host === client.user.id) lobby.host = lobby.players[0].id;
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'lobby_update',
            players: lobby.players.map(p => ({ id: p.id, username: p.username }))
          })));
        }
      }
    }
    clients.delete(ws);
  });
});

// ==================== Функции трансляции (с защитой) ====================
function broadcastLobbyList() {
  try {
    // Гарантируем, что lobbies – это Map
    if (!(lobbies instanceof Map)) {
      console.warn('⚠️ broadcastLobbyList: lobbies не Map, пересоздаём');
      lobbies = new Map();
    }
    const list = getWaitingLobbies();

    for (const [ws, client] of clients) {
      if (client.user && !client.lobbyId) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
        }
      }
    }
  } catch (err) {
    console.error('❌ Ошибка в broadcastLobbyList:', err);
  }
}

function sendLobbyList(ws) {
  try {
    if (!(lobbies instanceof Map)) {
      console.warn('⚠️ sendLobbyList: lobbies не Map, пересоздаём');
      lobbies = new Map();
    }
    const list = getWaitingLobbies();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
    }
  } catch (err) {
    console.error('❌ Ошибка в sendLobbyList:', err);
  }
}

// ==================== Запуск сервера ====================
connectDB().then(() => {
  server.listen(process.env.PORT || 3000, () => {
    console.log('✅ Project Neon server running');
    // Таймер с защитой от падения
    setInterval(() => {
      try {
        broadcastLobbyList();
      } catch (err) {
        console.error('❌ Таймер упал:', err);
      }
    }, 3000);
  });
});
