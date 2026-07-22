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
    dbRun('INSERT INTO users (username, password, is_neon) VALUES (?, ?, 1)', ['Neon', NEON_HASH]);
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

// API
app.post('/api/register', (req, res) => { /* без изменений */ });
app.post('/api/login', (req, res) => { /* без изменений */ });

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
  const top = dbAll('SELECT username, wins FROM users ORDER BY wins DESC LIMIT 50');
  res.json(top);
});

app.post('/api/win', auth, (req, res) => {
  dbRun('UPDATE users SET wins = wins + 1 WHERE id = ?', [req.user.id]);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// WebSocket – только сигналинг и управление лобби
const clients = new Map(); // ws -> { user, lobbyId, peerId }
const lobbies = new Map(); // lobbyId -> { host, players[], state, settings }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'auth': { /* как раньше */ break; }
      case 'create_lobby': {
        const client = clients.get(ws);
        if (!client) return;
        // Проверка: у этого пользователя уже есть активное лобби?
        for (const [id, lobby] of lobbies) {
          if (lobby.host === client.user.id && lobby.state !== 'finished') {
            ws.send(JSON.stringify({ type: 'error', text: 'У вас уже есть активное лобби' }));
            return;
          }
        }
        const lobbyId = uuidv4().slice(0, 6);
        lobbies.set(lobbyId, {
          id: lobbyId,
          host: client.user.id,
          players: [{ id: client.user.id, username: client.user.username, ws }],
          state: 'waiting',
          mapData: null
        });
        client.lobbyId = lobbyId;
        client.peerId = client.user.id;
        ws.send(JSON.stringify({ type: 'lobby_created', lobbyId }));
        broadcastLobbyList();
        break;
      }
      case 'join_lobby': { /* с проверкой на существование */ break; }
      case 'start_game': { /* хост запускает, меняет state на 'starting', потом через 5 сек 'playing' */ break; }
      case 'signal': {
        // Пересылаем сигнальное сообщение (offer/answer/ice) конкретному игроку в лобби
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
      case 'leave_lobby': { /* ... */ break; }
    }
  });
  ws.on('close', () => { /* ... */ });
});

// Вспомогательные функции для рассылки списка лобби и т.д.
// ...
