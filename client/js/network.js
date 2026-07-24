let peer = null, dataChannel = null;
let amHost = false;
let gameState = null; // объект состояния, синхронизируемый между хостом и клиентом

const peerConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ]
};

function createPeer(remoteId, initiator) {
  if (peer && !peer.destroyed) peer.destroy();
  peer = new SimplePeer({ initiator, config: peerConfig });
  peer.on('signal', data => {
    if (!peer.destroyed && !peer.connected) sendWS({ type:'signal', target:remoteId, data });
  });
  peer.on('connect', () => {
    dataChannel = peer;
    if (amHost && gameState) sendToPeer({ type:'game_state', state: gameState });
  });
  peer.on('data', data => {
    try { const msg = JSON.parse(data.toString()); handleP2PMessage(msg); } catch(e) {}
  });
  peer.on('error', e => console.error('Peer error:', e));
  peer.on('close', () => { dataChannel = null; peer = null; });
}

function handleSignal(from, data) {
  if (!peer || peer.destroyed || peer.connected) return;
  try { peer.signal(data); } catch(e) {}
}

function sendToPeer(obj) {
  if (dataChannel && dataChannel.connected) dataChannel.send(JSON.stringify(obj));
}

function handleP2PMessage(msg) {
  if (!amHost && msg.type === 'game_state') {
    gameState = msg.state;
    applyGameState();
  } else if (amHost && msg.type === 'input') {
    processHostInput(msg);
  } else if (msg.type === 'chat') {
    addChatMessage(msg.from, msg.text);
  }
}

function processHostInput(msg) {
  if (!gameState) return;
  const player = gameState.players[msg.id];
  if (!player) return;
  player.position = msg.pos;
  player.rotation = msg.rot;
  if (msg.shoot && gameState.roundActive && Date.now() > gameState.freezeUntil) {
    hostProcessShoot(msg.id, msg.shootOrigin, msg.shootDir);
  }
  if (msg.action === 'plant' && player.team === 't' && !gameState.bombPlanted) {
    startPlanting(msg.id);
  }
  if (msg.action === 'defuse' && player.team === 'ct' && gameState.bombPlanted) {
    startDefusing(msg.id);
  }
}

// Отправка ввода от клиента
setInterval(() => {
  if (amHost || !dataChannel || !dataChannel.connected || !gameState || !gameState.roundActive) return;
  sendToPeer({
    type:'input',
    id: game.myId,
    pos: {x: game.camera.position.x, y: game.camera.position.y, z: game.camera.position.z},
    rot: {x: game.camera.rotation.x, y: game.camera.rotation.y, z: game.camera.rotation.z}
  });
}, 30);

// Хост отправляет состояние игры
setInterval(() => {
  if (!amHost || !gameState || !gameState.roundActive) return;
  if (game.mouseLocked && Date.now() > gameState.freezeUntil) {
    handleMovement();
    gameState.players[game.myId].position = {
      x: game.camera.position.x,
      y: game.camera.position.y,
      z: game.camera.position.z
    };
    gameState.players[game.myId].rotation = {
      x: game.camera.rotation.x,
      y: game.camera.rotation.y,
      z: game.camera.rotation.z
    };
  }
  // обновление таймера бомбы
  if (gameState.bombPlanted) {
    gameState.bombTimer -= 0.05;
    if (gameState.bombTimer <= 0) endRound('t');
  }
  sendToPeer({ type:'game_state', state: gameState });
  updateHUD();
}, 50);
