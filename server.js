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
      is_neon INTEGER DEFAULT 0
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
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Bad credentials' });
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

app.get('*', (req, res) => res.sendFile(__dirname + '/client/index.html'));

// WebSocket
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
          clients.set(ws, { user, lobbyId: null, playerId: null });
          ws.send(JSON.stringify({ type: 'auth_ok', user }));
          sendLobbyList(ws);
        } catch { ws.send(JSON.stringify({ type: 'error', text: 'Auth failed' })); }
        break;
      }
      case 'create_lobby': {
        const client = clients.get(ws);
        if (!client) return;
        const lobbyId = uuidv4().slice(0, 8);
        const lobby = {
          id: lobbyId,
          host: client.user.id,
          players: [{ id: client.user.id, username: client.user.username, ws, health: 100 }],
          state: 'waiting',
        };
        lobbies.set(lobbyId, lobby);
        client.lobbyId = lobbyId;
        client.playerId = client.user.id;
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
          ws.send(JSON.stringify({ type: 'error', text: 'Lobby unavailable' }));
          return;
        }
        lobby.players.push({ id: client.user.id, username: client.user.username, ws, health: 100 });
        client.lobbyId = lobby.id;
        client.playerId = client.user.id;
        lobby.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'lobby_update',
          players: lobby.players.map(p => ({ id: p.id, username: p.username }))
        })));
        broadcastLobbyList();
        break;
      }
      case 'start_game': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.host !== client.user.id || lobby.players.length < 2) return;
        lobby.state = 'playing';
        const spawns = [
          { x: 0, y: 1, z: 5 },
          { x: 0, y: 1, z: -5 },
          { x: 5, y: 1, z: 0 },
          { x: -5, y: 1, z: 0 },
        ];
        lobby.players.forEach((p, i) => {
          p.position = { ...spawns[i % spawns.length] };
          p.rotation = { yaw: 0 };
        });
        lobby.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'game_start',
          players: lobby.players.map(pl => ({
            id: pl.id,
            username: pl.username,
            position: pl.position,
            rotation: pl.rotation,
            health: pl.health,
          }))
        })));
        break;
      }
      case 'player_input': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'playing') return;
        const player = lobby.players.find(p => p.id === client.user.id);
        if (!player) return;
        if (msg.position) player.position = msg.position;
        if (msg.rotation) player.rotation = msg.rotation;
        const update = {
          type: 'player_update',
          id: player.id,
          position: player.position,
          rotation: player.rotation,
          health: player.health,
        };
        lobby.players.forEach(p => { if (p.ws !== ws) p.ws.send(JSON.stringify(update)); });
        break;
      }
      case 'shoot': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby || lobby.state !== 'playing') return;
        const shooter = lobby.players.find(p => p.id === client.user.id);
        if (!shooter) return;
        const targetId = msg.targetId;
        const target = lobby.players.find(p => p.id === targetId);
        let damage = 0;
        if (target) {
          target.health -= 25;
          damage = 25;
          if (target.health <= 0) {
            target.health = 0;
            // респавн через 3 секунды
            setTimeout(() => {
              if (lobby.players.includes(target)) {
                target.health = 100;
                target.position = { x: 0, y: 1, z: 5 }; // респавн на точке Т
                lobby.players.forEach(p => p.ws.send(JSON.stringify({
                  type: 'player_respawn',
                  id: target.id,
                  position: target.position,
                  health: target.health,
                })));
              }
            }, 3000);
          }
        }
        lobby.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'shoot_event',
          shooterId: shooter.id,
          targetId: targetId,
          damage: damage,
          targetHealth: target ? target.health : undefined,
        })));
        break;
      }
      case 'chat': {
        const client = clients.get(ws);
        if (!client || !client.lobbyId) return;
        const lobby = lobbies.get(client.lobbyId);
        if (!lobby) return;
        lobby.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'chat',
          from: client.user.username,
          text: msg.text,
        })));
        break;
      }
      case 'leave_lobby': {
        leaveLobby(ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveLobby(ws);
    clients.delete(ws);
  });
});

function leaveLobby(ws) {
  const client = clients.get(ws);
  if (!client || !client.lobbyId) return;
  const lobby = lobbies.get(client.lobbyId);
  if (!lobby) return;
  lobby.players = lobby.players.filter(p => p.ws !== ws);
  if (lobby.players.length === 0) {
    lobbies.delete(client.lobbyId);
  } else {
    if (lobby.host === client.user.id && lobby.players.length > 0) {
      lobby.host = lobby.players[0].id;
    }
    lobby.players.forEach(p => p.ws.send(JSON.stringify({
      type: 'lobby_update',
      players: lobby.players.map(p => ({ id: p.id, username: p.username }))
    })));
  }
  client.lobbyId = null;
  broadcastLobbyList();
}

function broadcastLobbyList() {
  const list = [];
  for (let [id, lobby] of lobbies) {
    if (lobby.state === 'waiting') {
      list.push({ id, host: lobby.players[0]?.username, players: lobby.players.length });
    }
  }
  for (let [ws, client] of clients) {
    if (client.user && !client.lobbyId) {
      ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
    }
  }
}

function sendLobbyList(ws) {
  const list = [];
  for (let [id, lobby] of lobbies) {
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
