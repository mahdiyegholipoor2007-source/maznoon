'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'MAZNOON', mode: 'telegram-mini-app' }));
app.get('/config.json', (_req, res) => {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  res.set('Cache-Control', 'no-store');
  res.json({ game: 'MAZNOON', telegramBotUsername: /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : '' });
});

const rooms = new Map();
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 3;
const WORDS = [
  { category: 'جاهای دیدنی', word: 'شهربازی' },
  { category: 'جاهای دیدنی', word: 'فرودگاه' },
  { category: 'جاهای دیدنی', word: 'بیمارستان' },
  { category: 'خوراکی‌ها', word: 'قرمه‌سبزی' },
  { category: 'خوراکی‌ها', word: 'بستنی' },
  { category: 'خوراکی‌ها', word: 'پیتزا' },
  { category: 'وسایل', word: 'چتر' },
  { category: 'وسایل', word: 'عینک آفتابی' },
  { category: 'وسایل', word: 'کنترل تلویزیون' },
  { category: 'حیوانات', word: 'پنگوئن' },
  { category: 'حیوانات', word: 'اختاپوس' },
  { category: 'حیوانات', word: 'گربه' },
  { category: 'شغل‌ها', word: 'دندان‌پزشک' },
  { category: 'شغل‌ها', word: 'آشپز' },
  { category: 'شغل‌ها', word: 'فضانورد' },
  { category: 'فناوری', word: 'هوش مصنوعی' },
  { category: 'فناوری', word: 'کنسول بازی' },
  { category: 'فناوری', word: 'ربات' },
  { category: 'مکان‌ها', word: 'مدرسه' },
  { category: 'مکان‌ها', word: 'ساحل' },
  { category: 'مکان‌ها', word: 'مترو' },
  { category: 'چیزهای عجیب', word: 'موجود فضایی' },
  { category: 'چیزهای عجیب', word: 'ماشین زمان' },
  { category: 'چیزهای عجیب', word: 'نامرئی شدن' }
];

function cleanName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
}
function cleanClue(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 100);
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function activePlayers(room) {
  return room.players.filter(p => p.active);
}
function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.id === socketId);
    if (player) return { room, player };
  }
  return null;
}
function safeState(room, socketId) {
  const me = room.players.find(p => p.id === socketId);
  const gameOver = room.phase === 'result' && room.result && ['citizens_win', 'infiltrator_win'].includes(room.result.type);
  const infiltrator = room.players.find(p => p.role === 'infiltrator');
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    category: room.category,
    prompt: 'یک سرنخ کوتاه بده؛ خود کلمه را لو نده!',
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      active: p.active,
      isHost: p.id === room.hostId,
      hasClue: Boolean(p.clue),
      hasVoted: p.vote !== null,
      role: gameOver ? p.role : undefined
    })),
    selfId: socketId,
    selfRole: me ? me.role : null,
    selfActive: me ? me.active : false,
    secretWord: me && me.role === 'citizen' && room.phase !== 'lobby' ? room.word : (gameOver ? room.word : null),
    clueCount: activePlayers(room).filter(p => p.clue).length,
    voteCount: activePlayers(room).filter(p => p.vote !== null).length,
    clues: ['vote', 'result'].includes(room.phase)
      ? activePlayers(room).filter(p => p.clue).map(p => ({ id: p.id, name: p.name, text: p.clue }))
      : [],
    result: room.result,
    gameOver,
    infiltratorName: gameOver && infiltrator ? infiltrator.name : null,
    canStart: room.phase === 'lobby' && room.players.length >= MIN_PLAYERS,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS
  };
}
function emitRoom(room) {
  for (const player of room.players) {
    io.to(player.id).emit('state', safeState(room, player.id));
  }
}
function notify(socket, message) {
  socket.emit('notice', { message });
}
function resetPlayerRound(p) {
  p.clue = '';
  p.vote = null;
}
function beginGame(room) {
  const chosen = WORDS[Math.floor(Math.random() * WORDS.length)];
  room.word = chosen.word;
  room.category = chosen.category;
  room.round = 1;
  room.phase = 'clue';
  room.result = null;
  room.players.forEach(p => {
    p.active = true;
    p.role = 'citizen';
    resetPlayerRound(p);
  });
  const alive = activePlayers(room);
  alive[Math.floor(Math.random() * alive.length)].role = 'infiltrator';
}
function maybeFinishClues(room) {
  const alive = activePlayers(room);
  if (alive.length && alive.every(p => Boolean(p.clue))) room.phase = 'vote';
}
function settleVotes(room) {
  const alive = activePlayers(room);
  if (!alive.length || !alive.every(p => p.vote !== null)) return;
  const counts = new Map();
  alive.forEach(p => counts.set(p.vote, (counts.get(p.vote) || 0) + 1));
  const topCount = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === topCount).map(([id]) => id);
  if (leaders.length !== 1) {
    room.phase = 'result';
    room.result = { type: 'tie', title: 'رأی‌ها مساوی شد!', text: 'هیچ‌کس حذف نشد. دور بعد رو شروع کنید و دقیق‌تر سرنخ بدید.' };
    return;
  }
  const eliminated = room.players.find(p => p.id === leaders[0]);
  eliminated.active = false;
  const allCitizens = activePlayers(room).filter(p => p.role === 'citizen');
  if (eliminated.role === 'infiltrator') {
    room.phase = 'result';
    room.result = {
      type: 'citizens_win', title: 'نفوذی لو رفت!', text: `${eliminated.name} نفوذی بود. شهروندها برنده شدند.`,
      eliminatedName: eliminated.name, eliminatedRole: eliminated.role, winner: 'citizens'
    };
  } else if (allCitizens.length <= 1) {
    room.phase = 'result';
    room.result = {
      type: 'infiltrator_win', title: 'نفوذی همه رو بازی داد!', text: `${eliminated.name} شهروند بود و نفوذی هنوز بین شماست.`,
      eliminatedName: eliminated.name, eliminatedRole: eliminated.role, winner: 'infiltrator'
    };
  } else {
    room.phase = 'result';
    room.result = {
      type: 'wrong_elimination', title: 'اشتباه گرفتید!', text: `${eliminated.name} شهروند بود. نفوذی هنوز لو نرفته.`,
      eliminatedName: eliminated.name, eliminatedRole: eliminated.role
    };
  }
}

io.on('connection', socket => {
  socket.on('createRoom', payload => {
    const name = cleanName(payload && payload.name);
    if (!name) return notify(socket, 'اول یه اسم برای خودت بنویس.');
    const code = newCode();
    const room = {
      code, hostId: socket.id, phase: 'lobby', round: 0,
      word: null, category: null, result: null,
      players: [{ id: socket.id, name, role: null, active: true, clue: '', vote: null }]
    };
    rooms.set(code, room);
    socket.join(code);
    emitRoom(room);
  });

  socket.on('joinRoom', payload => {
    const name = cleanName(payload && payload.name);
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!name) return notify(socket, 'اول یه اسم برای خودت بنویس.');
    if (!room) return notify(socket, 'این کد اتاق پیدا نشد. از میزبان کد جدید بگیر.');
    if (room.phase !== 'lobby') return notify(socket, 'بازی شروع شده؛ برای این دور دیگه نمی‌شه وارد شد.');
    if (room.players.length >= MAX_PLAYERS) return notify(socket, 'اتاق پر شده؛ حداکثر ۸ نفر می‌تونن بازی کنن.');
    room.players.push({ id: socket.id, name, role: null, active: true, clue: '', vote: null });
    socket.join(code);
    emitRoom(room);
  });

  socket.on('startGame', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return notify(socket, 'اول وارد یه اتاق شو.');
    const { room } = found;
    if (room.hostId !== socket.id) return notify(socket, 'فقط سازنده اتاق می‌تونه بازی رو شروع کنه.');
    if (room.phase !== 'lobby') return notify(socket, 'بازی در حال اجراست.');
    if (room.players.length < MIN_PLAYERS) return notify(socket, `برای شروع حداقل ${MIN_PLAYERS} نفر لازم دارید.`);
    beginGame(room);
    emitRoom(room);
  });

  socket.on('submitClue', payload => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    if (room.phase !== 'clue') return notify(socket, 'الان زمان ثبت سرنخ نیست.');
    if (!player.active) return notify(socket, 'از بازی حذف شدی و این دور فقط تماشا می‌کنی.');
    if (player.clue) return notify(socket, 'سرنخت رو قبلاً ثبت کردی.');
    const clue = cleanClue(payload && payload.clue);
    if (!clue) return notify(socket, 'یه سرنخ کوتاه بنویس.');
    player.clue = clue;
    maybeFinishClues(room);
    emitRoom(room);
  });

  socket.on('castVote', payload => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    if (room.phase !== 'vote') return notify(socket, 'الان زمان رأی دادن نیست.');
    if (!player.active) return notify(socket, 'از بازی حذف شدی و نمی‌تونی رأی بدی.');
    if (player.vote !== null) return notify(socket, 'رأی تو ثبت شده.');
    const target = room.players.find(p => p.id === String(payload && payload.targetId));
    if (!target || !target.active) return notify(socket, 'این بازیکن دیگه توی بازی نیست.');
    if (target.id === player.id) return notify(socket, 'به خودت نمی‌تونی رأی بدی!');
    player.vote = target.id;
    settleVotes(room);
    emitRoom(room);
  });

  socket.on('continueRound', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.hostId !== socket.id) return notify(socket, 'فقط میزبان می‌تونه دور بعد رو شروع کنه.');
    if (room.phase !== 'result' || !room.result || ['citizens_win', 'infiltrator_win'].includes(room.result.type)) {
      return notify(socket, 'در حال حاضر امکان شروع دور بعد نیست.');
    }
    room.round += 1;
    room.phase = 'clue';
    room.result = null;
    activePlayers(room).forEach(resetPlayerRound);
    emitRoom(room);
  });

  socket.on('restartGame', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.hostId !== socket.id) return notify(socket, 'فقط میزبان می‌تونه بازی رو از نو شروع کنه.');
    room.phase = 'lobby';
    room.round = 0;
    room.word = null;
    room.category = null;
    room.result = null;
    room.players.forEach(p => {
      p.role = null;
      p.active = true;
      resetPlayerRound(p);
    });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    room.players = room.players.filter(p => p.id !== player.id);
    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) room.hostId = room.players[0].id;
    if (room.phase === 'clue') maybeFinishClues(room);
    if (room.phase === 'vote') settleVotes(room);
    emitRoom(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  MAZNOON Mini App server is running!`);
  console.log(`  Local test: http://localhost:${PORT}`);
  console.log(`  Public Telegram Mini App: deploy this service with HTTPS, then set its URL in @BotFather.\n`);
});
