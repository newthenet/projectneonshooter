// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-123';
const NEON_PASSWORD = process.env.NEON_PASSWORD || 'pnshooter888Qcod5';
const NEON_HASH = bcrypt.hashSync(NEON_PASSWORD, 10);

if (!MONGODB_URI) {
  console.error('MONGODB_URI не задан');
  process.exit(1);
}

let db, users, maps;

// Подключение к MongoDB (лёгкое)
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  for (let i = 0; i < 5; i++) {
    try {
      await client.connect();
      db = client.db('projectneon');
      users = db.collection('users');
      maps = db.collection('maps');

      // Индексы
      await users.createIndex({ username: 1 }, { unique: true });
      await maps.createIndex({ author_id: 1 });

      // Создаём Neon, если нет
      const neon = await users.findOne({ is_neon: true });
      if (!neon) {
        await users.insertOne({
          username: 'Neon',
          password: NEON_HASH,
          is_neon: true,
          wins: 0,
        });
      }
      console.log('MongoDB готова');
      return;
    } catch (err) {
      console.error(`Попытка ${i + 1}:`, err.message);
      if (i < 4) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('Не удалось подключиться к MongoDB');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.static('client'));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.userId = new ObjectId(jwt.verify(token, JWT_SECRET).id);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== API ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Fields required' });
    const exists = await users.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username exists' });
    const result = await users.insertOne({
      username,
      password: bcrypt.hashSync(password, 10),
      is_neon: false,
      wins: 0,
    });
    const token = jwt.sign({ id: result.insertedId }, JWT_SECRET);
    res.json({ token, user: { id: result.insertedId, username, is_neon: false } });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await users.findOne({ username });
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Bad credentials' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username, is_neon: user.is_neon } });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const top = await users.find({}, { projection: { username: 1, wins: 1 } })
      .sort({ wins: -1 }).limit(50).toArray();
    res.json(top);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    memory: process.memoryUsage(),
    db: !!(db && db.topology?.isConnected()),
  });
});

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// ==================== WebSocket ====================
const clients = new Map();   // ws -> { user, lobbyId }
const lobbies = new Map();

function sendLobbyList(ws) {
  const list = [];
  for (const [id, lobby] of lobbies) {
    if (lobby.state === 'waiting')
      list.push({ id, host: lobby.players[0]?.username, players: lobby.players.length });
  }
  try { ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list })); } catch {}
}

function updateLobbyPlayers(lobby) {
  const players = lobby.players.map(p => ({ id: p.id, username: p.username }));
  for (const p of lobby.players) {
    try { p.ws.send(JSON.stringify({ type: 'lobby_update', players })); } catch {}
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
          const userId = new ObjectId(dec.id);
          users.findOne({ _id: userId })
            .then(user => {
              if (!user) return ws.send(JSON.stringify({ type: 'error', text: 'User not found' }));
              clients.set(ws, {
                user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon },
                lobbyId: null,
              });
              ws.send(JSON.stringify({
                type: 'auth_ok',
                user: { id: user._id.toString(), username: user.username, is_neon: user.is_neon },
              }));
              sendLobbyList(ws);
            })
            .catch(() => ws.send(JSON.stringify({ type: 'error', text: 'DB error' })));
          break;
        }
        case 'lobby_list':
          sendLobbyList(ws);
          break;
        case 'create_lobby': {
          const client = clients.get(ws);
          if (!client) return;
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
            state: 'waiting',
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
            try { p.ws.send(JSON.stringify({ type: 'game_starting', delay: 5 })); } catch {}
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
  server.listen(process.env.PORT || 3000, () => {
    console.log('Сервер запущен');
    setInterval(() => {
      const mem = process.memoryUsage();
      console.log(`RAM: ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
    }, 30000);
  });
});
