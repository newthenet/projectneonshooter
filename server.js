// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let db;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-123';
const NEON_PASSWORD = process.env.NEON_PASSWORD || 'pnshooter888Qcod5';
const NEON_HASH = bcrypt.hashSync(NEON_PASSWORD, 10);

// Инициализация БД
async function initDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync('neon.db')) {
    const buffer = fs.readFileSync('neon.db');
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      is_neon INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      author_id INTEGER,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  saveDatabase();
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync('neon.db', buffer);
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return undefined;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
}

async function createNeonAccount() {
  if (!dbGet('SELECT id FROM users WHERE is_neon = 1')) {
    dbRun('INSERT INTO users (username, password, is_neon, wins) VALUES (?, ?, 1, 0)', ['Neon', NEON_HASH]);
  }
}

app.use(express.json());
app.use(express.static('client'));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const dec = jwt.verify(token, JWT_SECRET);
    req.user = dbGet('SELECT * FROM users WHERE id = ?', [dec.id]);
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// API (без изменений, только добавлен лидерборд)
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fields required' });
  if (dbGet('SELECT id FROM users WHERE username = ?', [username])) return res.status(409).json({ error: 'Username exists' });
  const hash = bcrypt.hashSync(password, 10);
  dbRun('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
  const newUser = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  const token = jwt.sign({ id: newUser.id }, JWT_SECRET);
  res.json({ token, user: { id: newUser.id, username: newUser.username, is_neon: !!newUser.is_neon } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Bad credentials' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, is_neon: !!user.is_neon } });
});

app.post('/api/maps', auth, (req, res) => {
  if (!req.user.is_neon) return res.status(403).json({ error: 'Neon only' });
  const { name, data } = req.body;
  dbRun('INSERT INTO maps (name, author_id, data) VALUES (?, ?, ?)', [name, req.user.id, JSON.stringify(data)]);
  res.json({ success: true });
});

app.get('/api/maps', auth, (req, res) => {
  res.json(dbAll('SELECT id, name, author_id, created_at FROM maps'));
});

app.get('/api/maps/:id', auth, (req, res) => {
  const map = dbGet('SELECT * FROM maps WHERE id = ?', [req.params.id]);
  if (!map) return res.status(404).json({ error: 'Not found' });
  map.data = JSON.parse(map.data);
  res.json(map);
});

app.get('/api/leaderboard', (req, res) => {
  res.json(dbAll('SELECT username, wins FROM users ORDER BY wins DESC LIMIT 50'));
});

app.post('/api/win', auth, (req, res) => {
  dbRun('UPDATE users SET wins = wins + 1 WHERE id = ?', [req.user.id]);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// WebSocket – сигнальный сервер и лобби
const clients = new Map();
const lobbies = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'auth': {
        try {
          const dec = jwt.verify(msg.token, JWT_SECRET);
          const user = dbGet('SELECT id, username, is_neon FROM users WHERE id = ?', [dec.id]);
          if (!user) { ws.send(JSON.stringify({ type: 'error', text: 'User not found' })); return; }
          clients.set(ws, { user, lobbyId: null, peerId: null });
          ws.send(JSON.stringify({ type: 'auth_ok', user }));
          sendLobbyList(ws);
        } catch { ws.send(JSON.stringify({ type: 'error', text: 'Auth failed' })); }
        break;
      }
      case 'create_lobby': {
        const client = clients.get(ws);
        if (!client) return;
        // Проверка: один юзер — одно активное лобби
        for (const [id, lobby] of lobbies) {
          if (lobby.host === client.user.id && lobby.state !== 'finished') {
            ws.send(JSON.stringify({ type: 'error', text: 'У вас уже есть активное лобби' }));
            return;
          }
        }
        const lobbyId = uuidv4().slice(0, 6);
        const lobby = {
          id: lobbyId,
          host: client.user.id,
          players: [{ id: client.user.id, username: client.user.username, ws }],
          state: 'waiting',
          mapData: null
        };
        lobbies.set(lobbyId, lobby);
        client.lobbyId = lobbyId;
        client.peerId = client.user.id;
        ws.send(JSON.stringify({ type: 'lobby_created', lobbyId }));
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
        if (lobby.players.length >= 10) { // ограничим 10 игроков
          ws.send(JSON.stringify({ type: 'error', text: 'Лобби заполнено' }));
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
        lobby.mapData = msg.mapData; // хост выбирает карту
        break;
      }
      case 'start_game': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.host !== client.user.id || lobby.players.length < 2) return;
        lobby.state = 'starting';
        // Рассылаем всем старт через 5 секунд
        setTimeout(() => {
          if (lobby.state !== 'starting') return;
          lobby.state = 'playing';
          lobby.round = 1;
          lobby.players.forEach((p, i) => {
            p.team = i % 2 === 0 ? 't' : 'ct'; // чередуем команды
          });
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'game_started',
            players: lobby.players.map(p => ({ id: p.id, username: p.username, team: p.team })),
            mapData: lobby.mapData
          })));
        }, 5000);
        // Сразу сообщаем, что игра начинается (отсчёт)
        lobby.players.forEach(p => p.ws.send(JSON.stringify({ type: 'game_starting', delay: 5 })));
        broadcastLobbyList();
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
        // Увеличиваем победы команде
        if (msg.winnerTeam) {
          lobby.players.forEach(p => {
            if (p.team === msg.winnerTeam) {
              // Обновляем wins в БД (через REST или здесь? Сделаем через API)
            }
          });
        }
        lobby.state = 'finished';
        lobbies.delete(client.lobbyId);
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.lobbyId) {
      const lobby = lobbies.get(client.lobbyId);
      if (lobby) {
        lobby.players = lobby.players.filter(p => p.ws !== ws);
        if (lobby.players.length === 0) lobbies.delete(client.lobbyId);
        else {
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

function broadcastLobbyList() {
  const list = [];
  for (const [id, lobby] of lobbies) {
    if (lobby.state === 'waiting') {
      list.push({ id, host: lobby.players[0]?.username, players: lobby.players.length });
    }
  }
  for (const [ws, client] of clients) {
    if (client.user && !client.lobbyId) {
      ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
    }
  }
}

function sendLobbyList(ws) {
  const list = [];
  for (const [id, lobby] of lobbies) {
    if (lobby.state === 'waiting') {
      list.push({ id, host: lobby.players[0]?.username, players: lobby.players.length });
    }
  }
  ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
}

initDatabase().then(() => {
  createNeonAccount();
  server.listen(process.env.PORT || 3000, () => console.log('Server running'));
});
