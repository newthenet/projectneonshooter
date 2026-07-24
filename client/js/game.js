// Игровые переменные и константы
const game = {
  scene:null, camera:null, renderer:null,
  keys:{}, mouseLocked:false,
  lastShot:0, shootCooldown:0.3,
  myId:null, myTeam:null,
  ammo:10, maxAmmo:10, reloading:false,
  health:100
};

const hudEl = document.getElementById('hud');
const crosshairEl = document.getElementById('crosshair');
const ammoDisplay = document.getElementById('ammoDisplay');
const healthFill = document.getElementById('healthFill');
const healthValue = document.getElementById('healthValue');
const roundInfo = document.getElementById('roundInfo');
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const clickOverlay = document.getElementById('clickOverlay');

const defaultMap = {
  spawns: [
    {team:'t', x:0, y:1, z:8},
    {team:'ct', x:0, y:1, z:-8}
  ],
  bombSite: {x:0, y:0, z:0, radius:2},
  objects: [
    {type:'box', x:2, y:1, z:2, w:2, h:2, d:2, color:'#8B7355'},
    {type:'box', x:-2, y:1, z:-2, w:2, h:2, d:2, color:'#8B7355'},
    {type:'box', x:3, y:1, z:-3, w:2, h:2, d:2, color:'#8B7355'},
    {type:'box', x:-3, y:1, z:3, w:2, h:2, d:2, color:'#8B7355'},
    {type:'wall', x:5, y:2, z:0, w:1, h:4, d:10, color:'#888888'},
    {type:'wall', x:-5, y:2, z:0, w:1, h:4, d:10, color:'#888888'},
  ]
};

function startP2PGame(players, mapData) {
  if (peer) { try { peer.destroy(); } catch(e) {} peer = null; dataChannel = null; }
  amHost = players[0].id === user.id;
  game.myId = user.id;
  game.myTeam = players.find(p => p.id === user.id).team;
  game.health = 100; game.ammo = game.maxAmmo; game.reloading = false;

  if (!game.renderer) initGameRenderer();
  loadMap(mapData || defaultMap);
  showScreen('game');
  updateHUD();

  const otherId = players.find(p => p.id !== user.id).id;
  createPeer(otherId, amHost);

  clickOverlay.style.display = 'flex';
  clickOverlay.onclick = () => {
    clickOverlay.style.display = 'none';
    document.body.requestPointerLock();
    document.body.focus();
  };

  if (amHost) {
    initHostState(players, mapData || defaultMap);
  }
}

function initHostState(players, mapData) {
  gameState = {
    players: {},
    round: 1,
    maxRounds: 5,
    roundActive: false,
    freezeUntil: Date.now() + 5000,
    bombPlanted: false,
    bombTimer: 45,
    plantProgress: 0,
    defuseProgress: 0,
    winner: null
  };
  players.forEach(p => {
    gameState.players[p.id] = {
      id: p.id,
      username: p.username,
      team: p.team,
      health: 100,
      position: {x:0, y:1, z: p.team==='t'?8:-8},
      rotation: {x:0, y:0, z:0}
    };
  });
  sendToPeer({ type:'game_state', state: gameState });
}

function applyGameState() {
  if (!gameState) return;
  const my = gameState.players[game.myId];
  if (my) {
    game.health = my.health;
    game.camera.position.set(my.position.x, my.position.y, my.position.z);
    game.camera.rotation.set(my.rotation.x, my.rotation.y, my.rotation.z);
  }
  updateRemoteModels();
  updateHUD();
}

// Управление и стрельба
function shoot() {
  if (!gameState || !gameState.roundActive || gameState.freezeUntil > Date.now()) return;
  if (game.ammo <= 0 || game.reloading) return;
  const now = performance.now()/1000;
  if (now - game.lastShot < game.shootCooldown) return;
  game.lastShot = now; game.ammo--;
  updateHUD();
  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(game.camera.quaternion);
  const spread = 0.02;
  dir.x += (Math.random()-0.5)*spread; dir.y += (Math.random()-0.5)*spread; dir.z += (Math.random()-0.5)*spread;
  dir.normalize();
  if (amHost) {
    hostProcessShoot(game.myId, game.camera.position.toArray(), dir.toArray());
  } else {
    sendToPeer({
      type:'input', id:game.myId,
      pos: {x:game.camera.position.x, y:game.camera.position.y, z:game.camera.position.z},
      rot: {x:game.camera.rotation.x, y:game.camera.rotation.y, z:game.camera.rotation.z},
      shoot: true,
      shootOrigin: game.camera.position.toArray(),
      shootDir: dir.toArray()
    });
  }
  if (game.ammo === 0) reload();
}

function reload() {
  if (game.reloading || game.ammo === game.maxAmmo) return;
  game.reloading = true;
  setTimeout(() => { game.ammo = game.maxAmmo; game.reloading = false; updateHUD(); }, 3000);
}

function hostProcessShoot(shooterId, originArr, dirArr) {
  const origin = new THREE.Vector3().fromArray(originArr);
  const dir = new THREE.Vector3().fromArray(dirArr);
  const raycaster = new THREE.Raycaster(origin, dir);
  const intersects = raycaster.intersectObjects(game.scene.children, true);
  for (const inter of intersects) {
    const obj = inter.object;
    if (obj.userData.playerId && obj.userData.hitbox) {
      if (obj.userData.playerId === shooterId) continue;
      if (gameState.players[obj.userData.playerId]?.team === gameState.players[shooterId]?.team) continue;
      const dmg = obj.userData.hitbox==='head'?100:20;
      gameState.players[obj.userData.playerId].health = Math.max(0, gameState.players[obj.userData.playerId].health - dmg);
      if (gameState.players[obj.userData.playerId].health <= 0) {
        gameState.players[obj.userData.playerId].health = 0;
        checkRoundEnd();
      }
      sendToPeer({ type:'game_state', state: gameState });
      break;
    }
  }
}

function startPlanting(planterId) {
  gameState.plantProgress = 0;
  gameState.bombPlanted = true;
  gameState.bombTimer = 45;
  // прогресс идёт 3 секунды на хосте
  const interval = setInterval(() => {
    gameState.plantProgress += 1/60;
    if (gameState.plantProgress >= 1) {
      clearInterval(interval);
      sendToPeer({ type:'game_state', state: gameState });
    }
  }, 1000/60);
}

function startDefusing(defuserId) {
  gameState.defuseProgress = 0;
  const interval = setInterval(() => {
    gameState.defuseProgress += 1/60;
    if (gameState.defuseProgress >= 1) {
      clearInterval(interval);
      gameState.bombPlanted = false;
      sendToPeer({ type:'game_state', state: gameState });
    }
  }, 1000/60);
}

function checkRoundEnd() {
  const alive = {t:false, ct:false};
  Object.values(gameState.players).forEach(p => { if (p.health > 0) alive[p.team] = true; });
  if (!alive.t || !alive.ct) {
    const winner = !alive.t ? 'ct' : 't';
    endRound(winner);
  }
}

function endRound(winnerTeam) {
  gameState.roundActive = false;
  gameState.round++;
  if (gameState.round > gameState.maxRounds) {
    gameOver(winnerTeam);
    return;
  }
  if (gameState.round === 4) {
    Object.values(gameState.players).forEach(p => p.team = p.team==='t'?'ct':'t');
  }
  Object.values(gameState.players).forEach(p => {
    p.health = 100;
    p.position = {x:0, y:1, z: p.team==='t'?8:-8};
  });
  gameState.freezeUntil = Date.now() + 5000;
  gameState.roundActive = true;
  gameState.bombPlanted = false;
  gameState.bombTimer = 45;
  gameState.plantProgress = 0;
  gameState.defuseProgress = 0;
  sendToPeer({ type:'game_state', state: gameState });
}

function gameOver(winnerTeam) {
  gameState.roundActive = false;
  alert(`Победила команда ${winnerTeam}`);
  leaveGame();
}

function updateHUD() {
  if (!gameState || !gameState.players[game.myId]) return;
  const my = gameState.players[game.myId];
  ammoDisplay.textContent = `${game.ammo}/${game.maxAmmo}${game.reloading?' (перезарядка)':''}`;
  healthFill.style.width = `${my.health}%`;
  healthValue.textContent = my.health;
  roundInfo.textContent = `Раунд ${gameState.round}/${gameState.maxRounds} | ${game.myTeam?.toUpperCase()}`;
}

function initGameRenderer() {
  game.scene = new THREE.Scene(); game.scene.background = new THREE.Color(0x87ceeb);
  game.camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  game.renderer = new THREE.WebGLRenderer({ antialias:true });
  game.renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('gameCanvas').appendChild(game.renderer.domElement);
  game.scene.add(new THREE.AmbientLight(0x404040));
  const light = new THREE.DirectionalLight(0xffffff,0.8); light.position.set(10,20,5); game.scene.add(light);
  window.addEventListener('resize', () => {
    if (!game.camera) return;
    game.camera.aspect = window.innerWidth/window.innerHeight;
    game.camera.updateProjectionMatrix();
    game.renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function loadMap(data) {
  while(game.scene.children.length > 2) game.scene.remove(game.scene.children[2]);
  data.objects?.forEach(obj => {
    let mesh;
    const geometry = obj.type==='box' ? new THREE.BoxGeometry(obj.w, obj.h, obj.d) : new THREE.BoxGeometry(obj.w, obj.h, obj.d);
    mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: obj.color || '#8B7355' }));
    mesh.position.set(obj.x, obj.y, obj.z);
    game.scene.add(mesh);
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshLambertMaterial({color:0x228b22}));
  ground.rotation.x = -Math.PI/2; game.scene.add(ground);
}

function updateRemoteModels() {
  if (!gameState) return;
  // Удаляем старые меши (упрощённо)
  Object.values(gameState.players).forEach(p => {
    if (p.id === game.myId) return;
    if (!game.players) game.players = {};
    if (!game.players[p.id]) game.players[p.id] = { mesh:null };
    if (game.players[p.id].mesh) game.scene.remove(game.players[p.id].mesh);
    const group = new THREE.Group();
    const bodyColor = p.team==='t'?0xff4444:0x4444ff;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,1.8,8), new THREE.MeshLambertMaterial({color:bodyColor}));
    body.position.y = 0.9;
    body.userData = { playerId:p.id, hitbox:'body' };
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35,16,16), new THREE.MeshLambertMaterial({color:0xffccaa}));
    head.position.y = 2.05;
    head.userData = { playerId:p.id, hitbox:'head' };
    group.add(body); group.add(head);
    group.position.set(p.position.x, p.position.y, p.position.z);
    group.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
    game.scene.add(group);
    game.players[p.id].mesh = group;
  });
}

function handleMovement() {
  if (!game.mouseLocked) return;
  const speed = 5 * 0.1;
  const dir = new THREE.Vector3();
  if (game.keys['KeyW']) dir.z -= 1;
  if (game.keys['KeyS']) dir.z += 1;
  if (game.keys['KeyA']) dir.x -= 1;
  if (game.keys['KeyD']) dir.x += 1;
  if ((game.keys['Space'] || game.keys['KeyQ']) && game.camera.position.y <= 1) {
    game.camera.position.y = 2.5;
  }
  dir.normalize().multiplyScalar(speed);
  game.camera.position.add(dir);
  if (game.camera.position.y > 1) game.camera.position.y -= 0.2;
  else game.camera.position.y = 1;
}

function leaveGame() {
  document.exitPointerLock();
  if (game.renderer) { game.renderer.dispose(); document.getElementById('gameCanvas').innerHTML=''; }
  game.scene=null; game.camera=null; game.renderer=null;
  if (peer) { try { peer.destroy(); } catch(e) {} peer=null; dataChannel=null; }
  gameState = null;
  showMenu();
}

// Управление
document.addEventListener('keydown', e => {
  game.keys[e.code] = true;
  if (e.code === 'KeyR') reload();
  if (e.code === 'Period' && screens.game.classList.contains('active')) {
    chatInput.style.display = chatInput.style.display==='none'?'block':'none';
    if (chatInput.style.display==='block') chatInput.focus();
  }
  if (e.code === 'KeyL' && screens.game.classList.contains('active')) { if (confirm('Сдаться?')) leaveGame(); }
  if (e.code === 'KeyP' && screens.game.classList.contains('active')) {
    // plant / defuse
    if (game.myTeam === 't') plantAction();
    else defuseAction();
  }
});
document.addEventListener('keyup', e => game.keys[e.code] = false);
document.addEventListener('mousemove', e => {
  if (game.mouseLocked) {
    game.camera.rotation.y -= e.movementX * 0.002;
    game.camera.rotation.x -= e.movementY * 0.002;
    game.camera.rotation.x = Math.max(-Math.PI/2.5, Math.min(Math.PI/2.5, game.camera.rotation.x));
  }
});
document.addEventListener('pointerlockchange', () => { game.mouseLocked = document.pointerLockElement !== null; });
document.addEventListener('mousedown', e => { if (e.button===0 && game.mouseLocked && gameState?.roundActive) shoot(); });
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const msg = { type:'chat', text: chatInput.value, from: user.username };
    if (amHost) {
      addChatMessage(msg.from, msg.text);
      sendToPeer(msg);
    } else {
      sendToPeer(msg);
      addChatMessage(msg.from, msg.text);
    }
    chatInput.value = ''; chatInput.style.display = 'none';
  }
});

function plantAction() {
  if (amHost) startPlanting(game.myId);
  else sendToPeer({ type:'input', id:game.myId, pos:{x:game.camera.position.x, y:game.camera.position.y, z:game.camera.position.z}, rot:{x:game.camera.rotation.x, y:game.camera.rotation.y, z:game.camera.rotation.z}, action:'plant' });
}
function defuseAction() {
  if (amHost) startDefusing(game.myId);
  else sendToPeer({ type:'input', id:game.myId, pos:{x:game.camera.position.x, y:game.camera.position.y, z:game.camera.position.z}, rot:{x:game.camera.rotation.x, y:game.camera.rotation.y, z:game.camera.rotation.z}, action:'defuse' });
}

function addChatMessage(from, text) {
  const div = document.createElement('div'); div.textContent = `${from}: ${text}`;
  chatBox.appendChild(div); chatBox.scrollTop = chatBox.scrollHeight;
}

// Игровой цикл
function gameLoop() {
  requestAnimationFrame(gameLoop);
  if (!game.renderer || !game.scene) return;
  game.renderer.render(game.scene, game.camera);
}
gameLoop();
