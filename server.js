const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/api/io',
  transports: ['polling'],
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// GAME CONSTANTS
// ================================================================
const CARD_DEFS = {
  first_finder:    { name:'第一发现者', icon:'🔍', type:'主动', desc:'必须第一个打出，启动游戏' },
  criminal:        { name:'犯人',     icon:'🦹', type:'主动', desc:'仅剩此一张时可打出，犯人阵营获胜' },
  accomplice:      { name:'共犯',     icon:'🕵️', type:'主动', desc:'亮明犯人阵营身份' },
  detective:       { name:'侦探',     icon:'🔎', type:'主动', desc:'指控一人：有犯人无不在场证明即胜' },
  alibi:           { name:'不在场证明', icon:'🛡️', type:'被动', desc:'在手牌中免疫侦探指控' },
  witness:         { name:'目击者',   icon:'👁️', type:'主动', desc:'查看一名其他玩家的所有手牌' },
  rumor:           { name:'谣言',     icon:'💬', type:'主动', desc:'全体从上家随机抽1张牌' },
  trade:           { name:'交易',     icon:'🤝', type:'主动', desc:'与一名玩家秘密交换1张手牌' },
  intel_exchange:  { name:'情报交换', icon:'📨', type:'主动', desc:'每人选1张传给下家' },
  civilian:        { name:'普通人',   icon:'🧑', type:'主动', desc:'无效果，纯粹消耗手牌' },
  divine_dog:      { name:'神犬',     icon:'🐕', type:'主动', desc:'弃掉一人1张牌，弃掉犯人即胜' },
};

const FULL_DECK = [
  'first_finder',
  'criminal',
  'detective',
  'divine_dog',
  'accomplice','accomplice',
  'alibi','alibi','alibi',
  'rumor','rumor','rumor','rumor','rumor',
  'intel_exchange','intel_exchange','intel_exchange','intel_exchange','intel_exchange',
  'civilian','civilian','civilian','civilian',
  'trade','trade','trade','trade','trade',
  'witness','witness','witness','witness',
];

const IMPORTANT_CARDS = ['rumor', 'divine_dog', 'intel_exchange', 'detective'];

// ================================================================
// ROOM & GAME STATE
// ================================================================
const rooms = {};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom() {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    host: null,
    players: [],       // { id, name, socketId, isAI, hand: [...] }
    maxHuman: 8,
    gameStarted: false,
    gameState: null,   // full server-side game state
    aiTimers: [],
    createdAt: Date.now(),
  };
  return code;
}

function initGameState(room) {
  const playerCount = room.players.length;
  const names = room.players.map(p => p.name);
  let accompliceCount = 0;
  if (playerCount >= 4 && playerCount <= 5) accompliceCount = 1;
  else if (playerCount >= 6) accompliceCount = 2;

  const totalCards = playerCount * 4;
  const mandatory = ['first_finder', 'criminal', 'detective', 'alibi'];
  for (let i = 0; i < accompliceCount; i++) mandatory.push('accomplice');

  const remaining = totalCards - mandatory.length;
  const pool = [...FULL_DECK];
  for (const m of mandatory) {
    const idx = pool.indexOf(m);
    if (idx >= 0) pool.splice(idx, 1);
  }
  shuffle(pool);
  const deck = shuffle([...mandatory, ...pool.slice(0, remaining)]);

  const hands = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(deck.slice(i * 4, (i + 1) * 4));
  }

  let firstFinderOwner = -1;
  for (let i = 0; i < playerCount; i++) {
    if (hands[i].includes('first_finder')) { firstFinderOwner = i; break; }
  }

  return {
    playerCount,
    names,
    hands,
    playedCards: [],
    currentPlayer: firstFinderOwner,
    turnNumber: 1,
    gameOver: false,
    winner: null,
    log: [],
    aiKnowledge: Array.from({length: playerCount}, () => ({})),
    waitingForTarget: null,   // { playerIdx, cardId }
    waitingForTrade: null,    // { playerIdx, targetIdx, cardA }
    waitingForIntel: false,
  };
}

function getCardDef(id) { return CARD_DEFS[id]; }

// ================================================================
// GAME LOGIC (server-side, same as single-player version)
// ================================================================
function canPlayCard(gs, playerIdx, cardId) {
  const hand = gs.hands[playerIdx];
  if (gs.turnNumber === 1 && cardId === 'first_finder') return true;
  if (gs.turnNumber === 1 && hand.includes('first_finder') && cardId !== 'first_finder') return false;
  if (cardId === 'criminal') return hand.length === 1;
  return true;
}

function needsTarget(cardId) {
  return ['detective', 'witness', 'trade', 'divine_dog'].includes(cardId);
}

function getValidTargets(gs, playerIdx, cardId) {
  const targets = [];
  for (let i = 0; i < gs.playerCount; i++) {
    if (i === playerIdx) continue;
    if (cardId === 'trade' && gs.hands[i].length === 0) continue;
    targets.push(i);
  }
  return targets;
}

function addLog(gs, msg, cls = '') {
  gs.log.push({ msg, cls });
  broadcastToRoom(gs._roomCode, 'log', { msg, cls });
}

function broadcastToRoom(roomCode, event, data, excludeSocketId = null) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const p of room.players) {
    if (p.isAI) continue;
    if (p.socketId === excludeSocketId) continue;
    io.to(p.socketId).emit(event, data);
  }
  // Also send to the excluded socket if we want everyone
  if (excludeSocketId) {
    io.to(excludeSocketId).emit(event, data);
  }
}

function broadcastAll(roomCode, event, data) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const p of room.players) {
    if (p.isAI) continue;
    io.to(p.socketId).emit(event, data);
  }
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.isAI) continue;

    // Build state visible to this player
    const visibleState = {
      playerIdx: i,
      playerCount: gs.playerCount,
      names: gs.names,
      myHand: gs.hands[i],
      opponents: [],
      currentPlayer: gs.currentPlayer,
      turnNumber: gs.turnNumber,
      gameOver: gs.gameOver,
      winner: gs.winner,
    };

    for (let j = 0; j < gs.playerCount; j++) {
      if (j === i) continue;
      visibleState.opponents.push({
        idx: j,
        name: gs.names[j],
        cardCount: gs.hands[j].length,
        isAI: room.players[j].isAI,
      });
    }

    io.to(p.socketId).emit('game_state', visibleState);
  }
}

// ================================================================
// CARD EFFECTS
// ================================================================
function resolveDetective(room, playerIdx, targetIdx) {
  const gs = room.gameState;
  const targetHand = gs.hands[targetIdx];
  const hasCriminal = targetHand.includes('criminal');
  const hasAlibi = targetHand.includes('alibi');
  const targetName = gs.names[targetIdx];

  if (hasCriminal && !hasAlibi) {
    addLog(gs, `🔎 ${gs.names[playerIdx]} 指控 ${targetName} 是犯人——指控成功！`, 'success');
    gameOver(room, 'detective', playerIdx);
  } else if (hasCriminal && hasAlibi) {
    addLog(gs, `🛡️ ${targetName} 有不在场证明，侦探的指控无效！`, 'important');
  } else {
    addLog(gs, `🔎 ${targetName} 不是犯人，侦探的指控落空了。`);
  }
}

function resolveWitness(room, playerIdx, targetIdx) {
  const gs = room.gameState;
  const targetHand = [...gs.hands[targetIdx]];
  
  const witnessPlayer = room.players[playerIdx];
  const targetPlayer = room.players[targetIdx];
  
  if (!witnessPlayer.isAI) {
    // Human witness: show result, pause game until acknowledged
    io.to(witnessPlayer.socketId).emit('witness_result', {
      targetName: gs.names[targetIdx],
      cards: targetHand,
    });
    gs._waitingWitnessAck = true;
  }
  
  if (!targetPlayer.isAI) {
    io.to(targetPlayer.socketId).emit('log', {
      msg: `👁️ ${gs.names[playerIdx]} 通过目击者查看了你的手牌！`,
      cls: 'info',
    });
  }

  addLog(gs, `👁️ ${gs.names[playerIdx]} 查看了 ${gs.names[targetIdx]} 的手牌。`);

  // Store in AI knowledge
  if (witnessPlayer.isAI) {
    for (const c of targetHand) {
      gs.aiKnowledge[playerIdx][c] = (gs.aiKnowledge[playerIdx][c] || 0) + 1;
    }
  }
}

function resolveDivineDog(room, playerIdx, targetIdx, cardId = null) {
  const gs = room.gameState;
  const targetHand = gs.hands[targetIdx];
  if (targetHand.length === 0) {
    addLog(gs, `🐕 ${gs.names[targetIdx]} 没有手牌，神犬无事可做。`);
    return;
  }

  const discard = cardId || targetHand[Math.floor(Math.random() * targetHand.length)];
  const idx = targetHand.indexOf(discard);
  if (idx < 0) return;
  targetHand.splice(idx, 1);
  
  addLog(gs, `🐕 神犬弃掉了 ${gs.names[targetIdx]} 的【${getCardDef(discard).name}】！`, 'danger');

  if (discard === 'criminal') {
    addLog(gs, '🎉 神犬弃掉了犯人牌！非犯人阵营获胜！', 'success');
    gameOver(room, 'divine_dog', playerIdx);
  } else {
    targetHand.push('divine_dog');
    addLog(gs, `🐕 ${gs.names[targetIdx]} 收走了神犬牌。`);
  }
}

function resolveTrade(room, playerIdx, targetIdx, cardA, cardB) {
  const gs = room.gameState;
  const handA = gs.hands[playerIdx];
  const handB = gs.hands[targetIdx];

  const idxA = handA.indexOf(cardA);
  const idxB = handB.indexOf(cardB);
  if (idxA < 0 || idxB < 0) return;
  handA.splice(idxA, 1);
  handB.splice(idxB, 1);
  handA.push(cardB);
  handB.push(cardA);

  addLog(gs, `🤝 ${gs.names[playerIdx]} 和 ${gs.names[targetIdx]} 秘密交换了一张牌。`);
}

function resolveRumor(room) {
  const gs = room.gameState;
  const { playerCount, hands } = gs;

  // Track how many copies of each card type are "just acquired" and protected per player
  const protected = Array.from({ length: playerCount }, () => new Map());

  for (let i = 0; i < playerCount; i++) {
    const upperIdx = (i - 1 + playerCount) % playerCount;
    const upperHand = hands[upperIdx];
    if (upperHand.length === 0) {
      addLog(gs, `💬 ${gs.names[i]} 的上家没有手牌，什么也没抽到。`);
      continue;
    }

    // Build available cards: exclude only the exact number of protected copies
    const prot = protected[upperIdx];
    const available = [];
    const consumed = new Map(); // track how many we've excluded already
    for (const c of upperHand) {
      const protectedCount = prot.get(c) || 0;
      const alreadyExcluded = consumed.get(c) || 0;
      if (alreadyExcluded < protectedCount) {
        // This specific copy is protected, skip it
        consumed.set(c, alreadyExcluded + 1);
      } else {
        available.push(c);
      }
    }

    // Pick from available, or fall back to all upperHand cards
    const pool = available.length > 0 ? available : upperHand;
    const pick = pool[Math.floor(Math.random() * pool.length)];

    const pickIdx = upperHand.indexOf(pick);
    upperHand.splice(pickIdx, 1);
    hands[i].push(pick);

    // Mark this card as protected for the next player (下家)
    protected[i].set(pick, (protected[i].get(pick) || 0) + 1);
    addLog(gs, `💬 ${gs.names[i]} 从上家抽到了一张牌。`);
  }

  addLog(gs, '💬 谣言平息，所有人的手牌都发生了变化...');
}

function resolveIntelExchange(room, passedCards) {
  const gs = room.gameState;
  const { playerCount, hands } = gs;

  for (let i = 0; i < playerCount; i++) {
    const nextIdx = (i + 1) % playerCount;
    const card = passedCards[i];
    if (card !== null && card !== undefined) {
      const idx = hands[i].indexOf(card);
      if (idx >= 0) {
        hands[i].splice(idx, 1);
        hands[nextIdx].push(card);
        addLog(gs, `📨 ${gs.names[i]} 传给 ${gs.names[nextIdx]} 一张牌。`);
      }
    }
  }
  addLog(gs, '📨 情报交换完成！');
}

function gameOver(room, reason, winningPlayer) {
  const gs = room.gameState;
  gs.gameOver = true;
  
  let detail = '';
  if (reason === 'criminal') {
    detail = `${gs.names[winningPlayer]} 打出了犯人牌，犯人阵营获胜！`;
  } else if (reason === 'detective') {
    detail = '侦探成功指控了犯人，非犯人阵营获胜！';
  } else if (reason === 'divine_dog') {
    detail = '神犬弃掉了犯人牌，非犯人阵营获胜！';
  }

  gs.winner = { reason, detail, winningPlayer };

  // Reveal all hands
  const allHands = [];
  for (let i = 0; i < gs.playerCount; i++) {
    allHands.push({
      name: gs.names[i],
      cards: gs.hands[i],
    });
  }

  broadcastAll(room.code, 'game_over', {
    reason,
    detail,
    allHands,
    winnerTeam: reason === 'criminal' ? '犯人阵营' : '非犯人阵营（侦探方）',
  });

  // Clean up AI timers
  for (const t of room.aiTimers) clearTimeout(t);
  room.aiTimers = [];
}

// ================================================================
// TURN MANAGEMENT
// ================================================================
function executePlay(room, playerIdx, cardId, targetIdx = -1) {
  const gs = room.gameState;
  if (gs.gameOver) return;

  const hand = gs.hands[playerIdx];
  const cardIdx = hand.indexOf(cardId);
  if (cardIdx < 0) return;

  hand.splice(cardIdx, 1);
  gs.playedCards.push(cardId);

  const def = getCardDef(cardId);
  addLog(gs, `${gs.names[playerIdx]} 打出了【${def.name}】${def.icon}`, 'important');

  // Resolve effect
  switch (cardId) {
    case 'first_finder':
      addLog(gs, '📢 游戏正式开始！');
      break;
    case 'criminal':
      gameOver(room, 'criminal', playerIdx);
      return;
    case 'accomplice':
      addLog(gs, `🕵️ ${gs.names[playerIdx]} 亮明了犯人阵营身份！`, 'danger');
      break;
    case 'detective':
      resolveDetective(room, playerIdx, targetIdx);
      break;
    case 'witness':
      resolveWitness(room, playerIdx, targetIdx);
      if (gs._waitingWitnessAck) {
        // Don't advance turn - wait for human to acknowledge
        gs._witnessPlayerIdx = playerIdx;
        return;
      }
      break;
    case 'divine_dog':
      resolveDivineDog(room, playerIdx, targetIdx);
      break;
    case 'trade':
      resolveTrade(room, playerIdx, targetIdx, gs._tradeCardA, gs._tradeCardB);
      gs._tradeCardA = null; gs._tradeCardB = null;
      break;
    case 'rumor':
      resolveRumor(room);
      break;
    case 'intel_exchange':
      resolveIntelExchange(room, gs._intelCards || []);
      gs._intelCards = null;
      break;
    case 'alibi':
    case 'civilian':
    default:
      addLog(gs, '无事发生。');
      break;
  }

  if (!gs.gameOver) {
    advanceTurn(room);
  }

  sendGameState(room.code);
}

function advanceTurn(room) {
  const gs = room.gameState;
  if (gs.gameOver) return;

  const { playerCount, hands } = gs;
  let nextPlayer = (gs.currentPlayer + 1) % playerCount;
  let attempts = 0;
  while (hands[nextPlayer].length === 0 && attempts < playerCount) {
    nextPlayer = (nextPlayer + 1) % playerCount;
    attempts++;
  }

  const allEmpty = hands.every(h => h.length === 0);
  if (allEmpty) {
    gameOver(room, 'criminal', -1);
    return;
  }

  gs.currentPlayer = nextPlayer;
  gs.turnNumber++;

  addLog(gs, `➡️ 轮到 ${gs.names[nextPlayer]} 出牌。`);
  sendGameState(room.code);

  // If AI's turn
  if (room.players[nextPlayer].isAI) {
    const isImportant = gs._lastImportant || false;
    gs._lastImportant = false;
    const delay = isImportant ? 2200 : 1200;
    const timer = setTimeout(() => aiPlay(room, nextPlayer), delay + Math.random() * 800);
    room.aiTimers.push(timer);
  }
}

// ================================================================
// AI LOGIC
// ================================================================
function aiPlay(room, playerIdx) {
  const gs = room.gameState;
  if (gs.gameOver) return;

  const hand = gs.hands[playerIdx];
  if (hand.length === 0) { advanceTurn(room); return; }

  if (gs.turnNumber === 1 && hand.includes('first_finder')) {
    executePlay(room, playerIdx, 'first_finder');
    return;
  }

  if (hand.length === 1 && hand[0] === 'criminal') {
    executePlay(room, playerIdx, 'criminal');
    return;
  }

  // Detective strategy
  if (hand.includes('detective')) {
    const suspect = aiFindSuspect(gs, playerIdx);
    if (suspect >= 0) {
      gs._lastImportant = true;
      executePlay(room, playerIdx, 'detective', suspect);
      return;
    }
  }

  // Divine dog strategy
  if (hand.includes('divine_dog')) {
    const target = aiFindDivineDogTarget(gs, playerIdx);
    if (target >= 0) {
      gs._lastImportant = true;
      executePlay(room, playerIdx, 'divine_dog', target);
      return;
    }
  }

  // Witness: gather info
  if (hand.includes('witness')) {
    const target = aiChooseWitnessTarget(gs, playerIdx);
    if (target >= 0) {
      executePlay(room, playerIdx, 'witness', target);
      return;
    }
  }

  // Priority: play non-essential cards
  const priority = ['civilian', 'accomplice', 'alibi', 'trade', 'rumor', 'intel_exchange', 'witness', 'divine_dog', 'detective'];
  for (const cardId of priority) {
    if (hand.includes(cardId) && canPlayCard(gs, playerIdx, cardId)) {
      if (cardId === 'trade') {
        const targets = getValidTargets(gs, playerIdx, 'trade');
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          gs._tradeCardA = hand[Math.floor(Math.random() * hand.length)];
          gs._tradeCardB = gs.hands[target][Math.floor(Math.random() * gs.hands[target].length)];
          executePlay(room, playerIdx, 'trade', target);
          return;
        }
      } else if (cardId === 'divine_dog' || cardId === 'detective' || cardId === 'witness') {
        const targets = getValidTargets(gs, playerIdx, cardId);
        if (targets.length > 0) {
          if (IMPORTANT_CARDS.includes(cardId)) gs._lastImportant = true;
          executePlay(room, playerIdx, cardId, targets[Math.floor(Math.random() * targets.length)]);
          return;
        }
      } else {
        if (IMPORTANT_CARDS.includes(cardId)) gs._lastImportant = true;
        executePlay(room, playerIdx, cardId);
        return;
      }
    }
  }

  // Fallback
  for (const cardId of hand) {
    if (canPlayCard(gs, playerIdx, cardId)) {
      if (needsTarget(cardId)) {
        const targets = getValidTargets(gs, playerIdx, cardId);
        if (targets.length > 0) {
          executePlay(room, playerIdx, cardId, targets[Math.floor(Math.random() * targets.length)]);
          return;
        }
      } else {
        executePlay(room, playerIdx, cardId);
        return;
      }
    }
  }

  advanceTurn(room);
}

function aiFindSuspect(gs, playerIdx) {
  for (let i = 0; i < gs.playerCount; i++) {
    if (i === playerIdx || gs.hands[i].length === 0) continue;
    if (gs.aiKnowledge[playerIdx]['criminal'] > 0 && gs.hands[i].includes('criminal')) return i;
  }
  if (Math.random() < 0.15) {
    const targets = [];
    for (let i = 0; i < gs.playerCount; i++) {
      if (i !== playerIdx && gs.hands[i].length > 0) targets.push(i);
    }
    if (targets.length > 0) return targets[Math.floor(Math.random() * targets.length)];
  }
  return -1;
}

function aiFindDivineDogTarget(gs, playerIdx) {
  for (let i = 0; i < gs.playerCount; i++) {
    if (i === playerIdx || gs.hands[i].length === 0) continue;
    if (gs.aiKnowledge[playerIdx]['criminal'] > 0 && gs.hands[i].includes('criminal')) return i;
  }
  const targets = [];
  for (let i = 0; i < gs.playerCount; i++) {
    if (i !== playerIdx && gs.hands[i].length > 0) targets.push(i);
  }
  if (targets.length > 0) return targets[Math.floor(Math.random() * targets.length)];
  return -1;
}

function aiChooseWitnessTarget(gs, playerIdx) {
  const targets = [];
  for (let i = 0; i < gs.playerCount; i++) {
    if (i !== playerIdx && gs.hands[i].length > 0) targets.push(i);
  }
  if (targets.length > 0) return targets[Math.floor(Math.random() * targets.length)];
  return -1;
}

// ================================================================
// SOCKET.IO EVENTS
// ================================================================
io.on('connection', (socket) => {
  console.log(`✅ 玩家连接: ${socket.id}`);

  // Create room
  socket.on('create_room', (playerName, callback) => {
    const code = createRoom();
    const room = rooms[code];
    room.host = socket.id;
    room.players.push({
      id: socket.id,
      name: playerName || '房主',
      socketId: socket.id,
      isAI: false,
      isHost: true,
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = 0;

    console.log(`🏠 房间 ${code} 创建，房主: ${playerName}`);
    callback({ success: true, code, players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })) });
  });

  // Join room
  socket.on('join_room', ({ code, playerName }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ success: false, error: '房间不存在' });
    if (room.gameStarted) return callback({ success: false, error: '游戏已开始，无法加入' });
    if (room.players.length >= room.maxHuman) return callback({ success: false, error: '房间已满（最多8人）' });

    const existingNames = room.players.filter(p => !p.isAI).map(p => p.name);
    let finalName = playerName || `玩家${room.players.length + 1}`;
    if (existingNames.includes(finalName)) {
      finalName += '_' + (room.players.length + 1);
    }

    room.players.push({
      id: socket.id,
      name: finalName,
      socketId: socket.id,
      isAI: false,
      isHost: false,
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = room.players.length - 1;

    console.log(`🚪 ${finalName} 加入房间 ${code}，当前 ${room.players.length} 人`);
    callback({ success: true, code, players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })) });

    // Notify others
    socket.to(code).emit('player_joined', {
      players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })),
    });
  });

  // Add AI player
  socket.on('add_ai', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.gameStarted) return;
    if (room.host !== socket.id) return;
    if (room.players.length >= 8) return;

    const aiNames = ['机器人A', '机器人B', '机器人C', '机器人D', '机器人E'];
    const aiIdx = room.players.filter(p => p.isAI).length;
    room.players.push({
      id: `ai_${code}_${aiIdx}`,
      name: aiNames[aiIdx] || `机器人${aiIdx + 1}`,
      socketId: null, isAI: true, isHost: false,
    });
    broadcastAll(code, 'player_joined', {
      players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })),
    });
  });

  // Remove AI player
  socket.on('remove_ai', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.gameStarted) return;
    if (room.host !== socket.id) return;

    // Remove last AI
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].isAI) {
        room.players.splice(i, 1);
        break;
      }
    }
    broadcastAll(code, 'player_joined', {
      players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })),
    });
  });

  // Restart game with same players
  socket.on('restart_game', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState || !room.gameState.gameOver) return;

    // Clean up old AI timers
    for (const t of room.aiTimers) clearTimeout(t);
    room.aiTimers = [];

    // Create fresh game state
    room.gameState = initGameState(room);
    room.gameState._roomCode = code;

    const gs = room.gameState;
    const firstFinder = gs.currentPlayer;

    addLog(gs, `🔄 新一局开始！${room.players.length} 名玩家，每人 4 张手牌。`);

    if (firstFinder === 0) {
      addLog(gs, '🔍 你拿到了「第一发现者」，必须第一个出牌！', 'important');
    } else {
      addLog(gs, `🔍 ${gs.names[firstFinder]} 拿到了「第一发现者」，将首先出牌。`);
    }

    sendGameState(code);

    // Also tell clients to remove game-over overlay
    broadcastAll(code, 'game_restarted', {});

    if (room.players[firstFinder].isAI) {
      setTimeout(() => executePlay(room, firstFinder, 'first_finder'), 1500);
    }
  });

  // Start game
  socket.on('start_game', (callback) => {
    try {
      const code = socket.data.roomCode;
      const room = rooms[code];
      if (!room) return callback({ success: false, error: '房间不存在' });
      if (room.host !== socket.id) return callback({ success: false, error: '只有房主可以开始游戏' });
      if (room.players.length < 3) return callback({ success: false, error: '至少需要3名玩家' });

      // Fill remaining slots with AI
      const aiNames = ['机器人A', '机器人B', '机器人C', '机器人D', '机器人E'];
      let aiIdx = 0;
      while (room.players.length < 3) {
        room.players.push({
          id: `ai_${code}_${aiIdx}`,
          name: aiNames[aiIdx], socketId: null, isAI: true, isHost: false,
        });
        aiIdx++;
      }

      room.gameStarted = true;
      room.gameState = initGameState(room);
      room.gameState._roomCode = code;

      const gs = room.gameState;
      const firstFinder = gs.currentPlayer;
      
      addLog(gs, `🃏 游戏开始！${room.players.length} 名玩家，每人 4 张手牌。`);
      console.log(`🎮 房间 ${code} 开始，第一发现者: ${gs.names[firstFinder]}`);
      
      if (firstFinder === 0) {
        addLog(gs, '🔍 你拿到了「第一发现者」，必须第一个出牌！', 'important');
      } else {
        addLog(gs, `🔍 ${gs.names[firstFinder]} 拿到了「第一发现者」，将首先出牌。`);
      }

      sendGameState(code);
      callback({ success: true });

      if (room.players[firstFinder].isAI) {
        setTimeout(() => executePlay(room, firstFinder, 'first_finder'), 1500);
      }
    } catch (err) {
      console.error('start_game error:', err);
      callback({ success: false, error: '服务器错误：' + err.message });
    }
  });

  // Play card (no target)
  socket.on('play_card', ({ cardId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.gameOver) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== gs.currentPlayer) return;

    if (gs.turnNumber === 1 && gs.hands[playerIdx].includes('first_finder') && cardId !== 'first_finder') {
      io.to(socket.id).emit('error_msg', '第一回合必须打出「第一发现者」！');
      return;
    }

    if (!gs.hands[playerIdx].includes(cardId)) return;
    if (!canPlayCard(gs, playerIdx, cardId)) {
      if (cardId === 'criminal') io.to(socket.id).emit('error_msg', '犯人只能在只剩这一张手牌时才能打出！');
      return;
    }

    // Intel exchange: ask all players to select a card
    if (cardId === 'intel_exchange') {
      gs.waitingForIntel = true;
      gs._intelCards = Array.from({ length: gs.playerCount }, () => null);
      gs._intelResponded = new Set();
      gs._intelInitiator = playerIdx;

      // Ask all non-AI players with cards to select
      for (let i = 0; i < gs.playerCount; i++) {
        if (!room.players[i].isAI && gs.hands[i].length > 0) {
          io.to(room.players[i].socketId).emit('select_intel_card', {
            myCards: gs.hands[i],
          });
        } else if (room.players[i].isAI && gs.hands[i].length > 0) {
          gs._intelCards[i] = aiChooseIntelCard(gs.hands[i]);
          gs._intelResponded.add(i);
        }
      }
      return;
    }

    if (IMPORTANT_CARDS.includes(cardId)) gs._lastImportant = true;
    executePlay(room, playerIdx, cardId);
  });

  // Play card with target
  socket.on('play_card_target', ({ cardId, targetIdx }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.gameOver) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== gs.currentPlayer) return;

    if (!gs.hands[playerIdx].includes(cardId)) return;
    if (!canPlayCard(gs, playerIdx, cardId)) return;

    const targets = getValidTargets(gs, playerIdx, cardId);
    if (!targets.includes(targetIdx)) return;

    // For trade, need to select cards
    if (cardId === 'trade') {
      gs.waitingForTrade = { playerIdx, targetIdx };
      gs._tradeTargetIdx = targetIdx;
      gs._tradePlayerIdx = playerIdx;
      
      // Ask both players to select a card
      io.to(socket.id).emit('select_trade_card', {
        targetName: gs.names[targetIdx],
        myCards: gs.hands[playerIdx],
      });
      io.to(room.players[targetIdx].socketId).emit('select_trade_card', {
        targetName: gs.names[playerIdx],
        myCards: gs.hands[targetIdx],
      });
      return;
    }

    // For divine_dog: human picks random without seeing cards
    if (cardId === 'divine_dog') {
      if (gs.hands[targetIdx].length === 0) {
        io.to(socket.id).emit('error_msg', '目标没有手牌！');
        return;
      }
      // Server randomly picks
    }

    if (IMPORTANT_CARDS.includes(cardId)) gs._lastImportant = true;
    executePlay(room, playerIdx, cardId, targetIdx);
  });

  // Witness acknowledgment
  socket.on('witness_ack', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (!gs._waitingWitnessAck) return;

    gs._waitingWitnessAck = false;
    sendGameState(code);
    advanceTurn(room);
  });

  // Trade card selection response
  socket.on('trade_card_selected', ({ cardId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (!gs.waitingForTrade) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    const wt = gs.waitingForTrade;

    if (playerIdx === wt.playerIdx) {
      gs._tradeCardA = cardId;
      gs._tradePlayerAReady = true;
    } else if (playerIdx === wt.targetIdx) {
      gs._tradeCardB = cardId;
      gs._tradePlayerBReady = true;
    }

    if (gs._tradePlayerAReady && gs._tradePlayerBReady) {
      gs.waitingForTrade = null;
      gs._tradePlayerAReady = false;
      gs._tradePlayerBReady = false;
      executePlay(room, wt.playerIdx, 'trade', wt.targetIdx);
    }
  });

  // Intel exchange card selection
  socket.on('intel_card_selected', ({ cardId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (!gs.waitingForIntel) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (!gs._intelCards) {
      gs._intelCards = Array.from({ length: gs.playerCount }, () => null);
    }
    gs._intelCards[playerIdx] = cardId;
    gs._intelResponded.add(playerIdx);

    // Check if all non-AI players have responded
    let allResponded = true;
    for (let i = 0; i < gs.playerCount; i++) {
      if (!room.players[i].isAI && !gs._intelResponded.has(i) && gs.hands[i].length > 0) {
        allResponded = false;
        break;
      }
    }

    if (allResponded) {
      const initiator = gs._intelInitiator || gs.currentPlayer;
      gs.waitingForIntel = false;
      gs._intelResponded = null;
      gs._lastImportant = true;
      executePlay(room, initiator, 'intel_exchange');
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`❌ 玩家断开: ${socket.id}`);
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    
    room.players = room.players.filter(p => p.id !== socket.id);
    
    if (room.players.length === 0 || room.players.every(p => p.isAI)) {
      // Clean up room
      for (const t of room.aiTimers) clearTimeout(t);
      delete rooms[code];
      console.log(`🗑️ 房间 ${code} 已清除`);
      return;
    }

    // If host left, assign new host
    if (room.host === socket.id) {
      const newHost = room.players.find(p => !p.isAI);
      if (newHost) {
        room.host = newHost.id;
        newHost.isHost = true;
        io.to(newHost.socketId).emit('you_are_host');
      }
    }

    broadcastAll(code, 'player_left', {
      players: room.players.map(p => ({ name: p.name, isAI: p.isAI, isHost: p.isHost })),
    });
  });
});

function aiChooseIntelCard(hand) {
  const priority = ['civilian', 'accomplice', 'alibi', 'rumor', 'intel_exchange', 'trade', 'witness'];
  for (const c of priority) {
    if (hand.includes(c)) return c;
  }
  return hand[0];
}

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 身份谜局 联机服务器运行在 http://localhost:${PORT}`);
  console.log(`   单机版: http://localhost:${PORT}/index.html`);
  console.log(`   联机版: http://localhost:${PORT}/online.html`);
});
