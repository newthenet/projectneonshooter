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

      await users.createIndex({ username: 1 }, { unique: true });
      await maps.createIndex({ author_id: 1 });

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
  res.json({ status: 'ok', memory: process.memoryUsage(), db: !!(db && db.topology?.isConnected()) });
});

// Карты
app.post('/api/maps', auth, async (req, res) => {
  try {
    const user = await users.findOne({ _id: req.userId });
    if (!user?.is_neon) return res.status(403).json({ error: 'Neon only' });
    await maps.insertOne({ name: req.body.name, author_id: req.userId, data: req.body.data, created_at: new Date() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maps', auth, async (req, res) => {
  try {
    const list = await maps.find({}, { projection: { name: 1, created_at: 1 } }).toArray();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maps/:id', auth, async (req, res) => {
  try {
    const map = await maps.findOne({ _id: new ObjectId(req.params.id) });
    if (!map) return res.status(404).json({ error: 'Not found' });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
          if (lobby.players.length >= 2) {   // <-- ЛИМИТ 2 ИГРОКА
            return ws.send(JSON.stringify({ type: 'error', text: 'Лобби заполнено (макс. 2)' }));
          }
          lobby.players.push({ id: client.user.id, username: client.user.username, ws });
          client.lobbyId = lobby.id;
          updateLobbyPlayers(lobby);
          break;
        }
        case 'set_map': {
          const client = clients.get(ws);
          if (!client?.lobbyId) return;
          const lobby = lobbies.get(client.lobbyId);
          if (lobby && lobby.host === client.user.id) {
            lobby.mapData = msg.mapData;
          }
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
          setTimeout(() => {
            if (lobby.state !== 'starting') return;
            lobby.state = 'playing';
            lobby.round = 1;
            lobby.players.forEach((p, i) => { p.team = i % 2 === 0 ? 't' : 'ct'; });
            for (const p of lobby.players) {
              try {
                p.ws.send(JSON.stringify({
                  type: 'game_started',
                  players: lobby.players.map(pl => ({ id: pl.id, username: pl.username, team: pl.team })),
                  mapData: lobby.mapData || null,
                }));
              } catch {}
            }
          }, 5000);
          break;
        }
        case 'signal': {
          const client = clients.get(ws);
          if (!client?.lobbyId) return;
          const lobby = lobbies.get(client.lobbyId);
          if (!lobby) return;
          const target = lobby.players.find(p => p.id === msg.target);
          if (target) {
            try { target.ws.send(JSON.stringify({ type: 'signal', from: client.user.id, data: msg.data })); } catch {}
          }
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
        case 'game_over': {
          const client = clients.get(ws);
          if (!client?.lobbyId) return;
          const lobby = lobbies.get(client.lobbyId);
          if (lobby && msg.winnerTeam) {
            // Обновляем победы в БД
            for (const p of lobby.players) {
              if (p.team === msg.winnerTeam) {
                users.updateOne({ _id: new ObjectId(p.id) }, { $inc: { wins: 1 } }).catch(() => {});
              }
            }
          }
          if (lobby) lobbies.delete(client.lobbyId);
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

connectDB().then(() => {
  server.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));
});
