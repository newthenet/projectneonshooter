// Глобальные переменные, UI, авторизация, меню, лобби
const WS_URL = location.origin.replace(/^http/, 'ws');
let token = localStorage.getItem('token');
let user = null, ws = null, lobbyId = null, inLobby = false;

// UI элементы
const screens = {
  menu: document.getElementById('menuScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game: document.getElementById('gameScreen'),
  editor: document.getElementById('editorScreen')
};
const authBlock = document.getElementById('authBlock');
const userBlock = document.getElementById('userBlock');
const displayName = document.getElementById('displayName');
const editorBtn = document.getElementById('editorBtn');
const lobbyListDiv = document.getElementById('lobbyList');
const inLobbyDiv = document.getElementById('inLobby');
const lobbyIdDisplay = document.getElementById('lobbyIdDisplay');
const playerList = document.getElementById('playerList');
const startBtn = document.getElementById('startBtn');
const mapSelect = document.getElementById('mapSelect');

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name === 'game' && game.renderer) {
    document.getElementById('gameCanvas').appendChild(game.renderer.domElement);
    hudEl.style.display = 'flex';
    crosshairEl.style.display = 'block';
  } else {
    if (hudEl) hudEl.style.display = 'none';
    if (crosshairEl) crosshairEl.style.display = 'none';
  }
}

// WebSocket
function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { if (token) ws.send(JSON.stringify({ type:'auth', token })); };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch{ return; }
    switch(msg.type) {
      case 'auth_ok': user = msg.user; showMenu(); break;
      case 'lobby_list': if (!inLobby) renderLobbyList(msg.lobbies); break;
      case 'lobby_created': lobbyId = msg.lobbyId; inLobby = true; lobbyIdDisplay.textContent = lobbyId; break;
      case 'lobby_update':
        updateLobbyPlayers(msg.players);
        inLobbyDiv.style.display = 'block';
        break;
      case 'game_starting': alert(`Игра начнётся через ${msg.delay} сек`); break;
      case 'game_started': startP2PGame(msg.players, msg.mapData); break;
      case 'signal': handleSignal(msg.from, msg.data); break;
      case 'error': alert(msg.text); break;
    }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
function sendWS(obj) { if (ws?.readyState===1) ws.send(JSON.stringify(obj)); }

function login() {
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) })
    .then(r=>r.json()).then(d => {
      if(d.token) { token=d.token; localStorage.setItem('token',token); user=d.user; connectWS(); }
      else alert(d.error);
    });
}
function register() {
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) })
    .then(r=>r.json()).then(d => {
      if(d.token) { token=d.token; localStorage.setItem('token',token); user=d.user; connectWS(); }
      else alert(d.error);
    });
}
function logout() {
  token=null; localStorage.removeItem('token'); user=null;
  if (ws) { ws.onclose=null; ws.close(); }
  showScreen('menu'); authBlock.style.display='block'; userBlock.style.display='none';
}
function showMenu() {
  showScreen('menu'); authBlock.style.display='none'; userBlock.style.display='block';
  displayName.textContent = user.username + (user.is_neon?' ✔':'');
  editorBtn.style.display = user.is_neon?'block':'none';
}

function showLobbies() { showScreen('lobby'); inLobbyDiv.style.display='none'; inLobby=false; sendWS({ type:'lobby_list' }); }
function createLobby() { sendWS({ type:'create_lobby' }); }
function joinLobby(id) { sendWS({ type:'join_lobby', lobbyId:id }); inLobby=true; }
function updateLobbyPlayers(players) {
  playerList.innerHTML = '';
  players.forEach(p => { const li=document.createElement('li'); li.textContent=p.username; playerList.appendChild(li); });
}
function startGame() {
  const mapId = mapSelect.value;
  if (mapId) {
    fetch('/api/maps/'+mapId, { headers:{'Authorization':'Bearer '+token} })
      .then(r=>r.json()).then(map => sendWS({ type:'set_map', mapData: map.data }));
  }
  sendWS({ type:'start_game' });
}
function leaveLobby() { if (inLobby) { sendWS({ type:'leave_lobby' }); inLobby=false; } showMenu(); }
function renderLobbyList(lobbies) {
  lobbyListDiv.innerHTML = '';
  if (!lobbies?.length) { lobbyListDiv.innerHTML='<p>Нет лобби</p>'; return; }
  lobbies.forEach(l => {
    const btn = document.createElement('button');
    btn.textContent = `${l.host} (${l.players}/2)`;
    btn.onclick = () => joinLobby(l.id);
    lobbyListDiv.appendChild(btn);
  });
}

function showLeaderboard() {
  fetch('/api/leaderboard').then(r=>r.json()).then(data => {
    const list = document.getElementById('leaderboardList');
    list.innerHTML = '';
    data.forEach(p => { const div=document.createElement('div'); div.textContent=`${p.username}: ${p.wins} побед`; list.appendChild(div); });
    document.getElementById('leaderboardPanel').style.display='block';
    showScreen('menu');
  });
}

// Загрузка списка карт хосту
async function loadMapListToSelect() {
  try {
    const resp = await fetch('/api/maps', { headers:{'Authorization':'Bearer '+token} });
    const maps = await resp.json();
    mapSelect.innerHTML = '<option value="">Стандартная</option>';
    maps.forEach(m => { const o=document.createElement('option'); o.value=m._id; o.textContent=m.name; mapSelect.appendChild(o); });
  } catch(e) {}
}

// Старт
if (token) connectWS(); else { showScreen('menu'); authBlock.style.display='block'; }
