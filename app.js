'use strict';

const socket = io();
const $ = id => document.getElementById(id);
const telegramApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
let appConfig = { telegramBotUsername: '' };

// Initialize Telegram's Mini App bridge when opened inside Telegram.
if (telegramApp) {
  try {
    telegramApp.ready();
    telegramApp.expand();
    if (typeof telegramApp.setHeaderColor === 'function') telegramApp.setHeaderColor('#090811');
    if (typeof telegramApp.setBackgroundColor === 'function') telegramApp.setBackgroundColor('#090811');
  } catch (_) { /* Keep browser fallback usable on older Telegram clients. */ }
}
const appConfigReady = fetch('/config.json', { cache: 'no-store' })
  .then(response => response.ok ? response.json() : {})
  .then(config => { appConfig = { ...appConfig, ...(config || {}) }; return appConfig; })
  .catch(() => appConfig);
const welcomeScreen = $('welcomeScreen');
const gameScreen = $('gameScreen');
const toast = $('toast');
let currentState = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
function myName() { return $('playerName').value.trim().slice(0, 18); }
function inviteUrlFor(code) {
  const botUsername = String(appConfig.telegramBotUsername || '').replace(/^@/, '');
  if (botUsername) return `https://t.me/${botUsername}?startapp=${encodeURIComponent(code)}`;
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}
async function shareInvite() {
  if (!currentState) return showToast('اول اتاق رو بساز یا واردش شو.');
  await appConfigReady;
  const url = inviteUrlFor(currentState.code);
  const text = `بیا توی MAZNOON بازی کن! کد اتاق: ${currentState.code}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (telegramApp && typeof telegramApp.openTelegramLink === 'function') {
    telegramApp.openTelegramLink(shareUrl);
    return;
  }
  if (navigator.share) {
    try { await navigator.share({ title: 'MAZNOON', text, url }); return; } catch (error) { if (error && error.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    showToast('لینک دعوت کپی شد؛ برای دوستات بفرست.');
  } catch (_) {
    showToast(`لینک دعوت: ${url}`);
  }
}
function ensureName() {
  if (!myName()) {
    $('playerName').focus();
    showToast('اول یه اسم مستعار بنویس.');
    return false;
  }
  return true;
}
function initials(name) { return Array.from(name || '?')[0] || '?'; }
function playerCard(player) {
  const status = currentState.phase === 'lobby' ? (player.isHost ? 'سازنده اتاق' : 'آماده بازی') : (!player.active ? 'حذف شده' : (player.hasClue ? 'سرنخ ثبت شد' : 'در حال بازی'));
  const complete = currentState.phase === 'clue' ? player.hasClue : currentState.phase === 'vote' ? player.hasVoted : false;
  return `<div class="player-card"><div class="player-avatar">${escapeHtml(initials(player.name))}</div><span class="player-name">${escapeHtml(player.name)}</span>${player.isHost ? '<span class="host-tag">میزبان</span>' : ''}<span class="player-status ${complete ? 'done' : ''}">${escapeHtml(status)}</span></div>`;
}
function rolePanel() {
  if (!currentState || currentState.phase === 'lobby' || currentState.phase === 'result') return '';
  const isSpy = currentState.selfRole === 'infiltrator';
  return `<div class="role-symbol">${isSpy ? '♟' : '✦'}</div><div class="role-copy"><span class="small-label">نقش مخفی تو</span><h2>${isSpy ? 'تو نفوذی هستی' : 'تو شهروندی'}</h2><p>${isSpy ? 'کلمه رو نمی‌دونی. با سرنخ‌های بقیه هماهنگ شو و خودت رو لو نده.' : `کلمه مخفی رو ببین و با سرنخ درست کمک کن نفوذی لو بره. دسته: ${escapeHtml(currentState.category || '')}`}</p></div>${!isSpy && currentState.secretWord ? `<div class="secret-word">${escapeHtml(currentState.secretWord)}</div>` : ''}`;
}
function renderCluePanel() {
  const st = currentState;
  $('roundNumber').textContent = st.round;
  $('clueProgress').textContent = `${st.clueCount} / ${st.players.filter(p => p.active).length}`;
  const total = Math.max(1, st.players.filter(p => p.active).length);
  $('clueProgressBar').style.width = `${Math.min(100, st.clueCount / total * 100)}%`;
  $('cluePlayerList').innerHTML = st.players.filter(p => p.active).map(p => `<div class="status-chip ${p.hasClue ? 'done' : ''}"><span class="status-dot"></span>${escapeHtml(p.name)}${p.hasClue ? ' · ثبت شد' : ' · منتظر'}</div>`).join('');
  const meSubmitted = st.players.find(p => p.id === st.selfId)?.hasClue;
  $('clueForm').classList.toggle('hidden', !st.selfActive || meSubmitted);
  $('clueWaiting').classList.toggle('hidden', !st.selfActive || !meSubmitted);
  $('clueInput').disabled = !st.selfActive || meSubmitted;
  $('submitClueButton').disabled = !st.selfActive || meSubmitted;
}
function renderVotePanel() {
  const st = currentState;
  $('voteRoundNumber').textContent = st.round;
  $('voteProgress').textContent = `${st.voteCount} / ${st.players.filter(p => p.active).length}`;
  const total = Math.max(1, st.players.filter(p => p.active).length);
  $('voteProgressBar').style.width = `${Math.min(100, st.voteCount / total * 100)}%`;
  $('clueGrid').innerHTML = st.clues.map(clue => `<article class="clue-card"><div class="clue-card-head"><span class="player-avatar">${escapeHtml(initials(clue.name))}</span>${escapeHtml(clue.name)}</div><p>${escapeHtml(clue.text)}</p></article>`).join('');
  const me = st.players.find(p => p.id === st.selfId);
  const alreadyVoted = me && me.hasVoted;
  $('voteTargets').innerHTML = st.players.filter(p => p.active).map(p => `<button class="vote-target ${p.id === st.selfId ? 'self' : ''}" data-target-id="${escapeHtml(p.id)}" ${!st.selfActive || alreadyVoted || p.id === st.selfId ? 'disabled' : ''}><span class="player-avatar">${escapeHtml(initials(p.name))}</span>${escapeHtml(p.name)}${p.id === st.selfId ? ' (تو)' : ''}</button>`).join('');
  $('voteTargets').querySelectorAll('[data-target-id]').forEach(button => button.addEventListener('click', () => socket.emit('castVote', { targetId: button.dataset.targetId })));
  $('voteWaiting').classList.toggle('hidden', !st.selfActive || !alreadyVoted);
}
function renderResult() {
  const st = currentState;
  const r = st.result || { type: 'tie', title: 'نتیجه دور', text: '' };
  const winner = r.type === 'citizens_win';
  const spyWins = r.type === 'infiltrator_win';
  const gameOver = st.gameOver;
  const icon = winner ? '✓' : spyWins ? '♟' : r.type === 'tie' ? '↔' : '×';
  const roleText = r.eliminatedRole === 'infiltrator' ? 'نفوذی' : r.eliminatedRole === 'citizen' ? 'شهروند' : '—';
  let details = '';
  if (gameOver) {
    details = `<div class="result-details"><div class="result-detail"><span>کلمه مخفی</span><b>${escapeHtml(st.secretWord || '—')}</b></div><div class="result-detail"><span>نفوذی واقعی</span><b>${escapeHtml(st.infiltratorName || '—')}</b></div><div class="result-detail"><span>برنده</span><b>${winner ? 'شهروندها' : 'نفوذی'}</b></div></div>`;
  } else if (r.eliminatedName) {
    details = `<div class="result-details"><div class="result-detail"><span>بازیکن حذف‌شده</span><b>${escapeHtml(r.eliminatedName)}</b></div><div class="result-detail"><span>نقش او</span><b>${roleText}</b></div><div class="result-detail"><span>وضعیت</span><b>بازی ادامه دارد</b></div></div>`;
  }
  let actions = '';
  if (gameOver) {
    actions = st.hostId === st.selfId ? '<button class="primary-button" id="restartButton">بازی دوباره با همین جمع ↙</button>' : '<span class="pill">منتظر میزبان برای شروع دوباره</span>';
  } else {
    actions = st.hostId === st.selfId ? '<button class="primary-button" id="continueButton">شروع دور بعد ↙</button>' : '<span class="pill">منتظر میزبان برای دور بعد</span>';
  }
  $('resultPanel').innerHTML = `<div class="result-icon ${winner ? 'win' : spyWins ? 'loss' : ''}">${icon}</div><span class="small-label">${gameOver ? 'GAME OVER' : 'ROUND RESULT'}</span><h2>${escapeHtml(r.title || 'نتیجه')}</h2><p class="result-description">${escapeHtml(r.text || '')}</p>${details}<div class="result-actions">${actions}</div><p class="eliminated-note">${gameOver ? 'این دور تموم شد؛ دوباره بازی کنین و نقش‌ها عوض می‌شن.' : 'هر بار سرنخ‌ها رو با دقت بررسی کن؛ نفوذی می‌تونه هر کسی باشه.'}</p>`;
  if ($('continueButton')) $('continueButton').addEventListener('click', () => socket.emit('continueRound'));
  if ($('restartButton')) $('restartButton').addEventListener('click', () => socket.emit('restartGame'));
}
function setVisiblePanels(phase) {
  $('lobbyPanel').classList.toggle('hidden', phase !== 'lobby');
  $('rolePanel').classList.toggle('hidden', !['clue', 'vote'].includes(phase));
  $('cluePanel').classList.toggle('hidden', phase !== 'clue');
  $('votePanel').classList.toggle('hidden', phase !== 'vote');
  $('resultPanel').classList.toggle('hidden', phase !== 'result');
}
function renderState(st) {
  currentState = st;
  welcomeScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  $('connectionText').textContent = 'متصل به اتاق';
  $('copyCodeButton').innerHTML = `${escapeHtml(st.code)} <span>▣</span>`;
  $('playerCount').textContent = `${st.players.length}/${st.maxPlayers}`;
  $('playerGrid').innerHTML = st.players.map(playerCard).join('');
  $('startButton').disabled = !st.canStart || st.hostId !== st.selfId;
  $('startButton').textContent = st.hostId === st.selfId ? (st.canStart ? 'شروع بازی ↙' : `حداقل ${st.minPlayers} نفر لازم است`) : 'منتظر میزبان...';
  $('lobbyHint').textContent = st.players.length < st.minPlayers ? `برای شروع ${st.minPlayers - st.players.length} نفر دیگه دعوت کن.` : 'همه آماده‌اید؟ میزبان می‌تونه بازی رو شروع کنه.';
  const phases = {
    lobby: ['LOBBY', 'اتاق انتظار', 'کد اتاق رو برای دوستات بفرست و جمع رو کامل کن.'],
    clue: ['GIVE A CLUE', 'وقت سرنخ دادنه', 'به کلمه فکر کن؛ یا اگر نفوذی هستی، نقش بازی کن.'],
    vote: ['FIND THE SPY', 'نفوذی کیه؟', 'سرنخ‌ها رو بررسی کن و به فرد مشکوک رأی بده.'],
    result: ['ROUND RESULT', 'نتیجه بازی', 'حقیقت کم‌کم داره روشن می‌شه.']
  };
  const details = phases[st.phase] || phases.lobby;
  $('phaseEyebrow').textContent = details[0];
  $('phaseTitle').textContent = details[1];
  $('phaseDescription').textContent = details[2];
  setVisiblePanels(st.phase);
  $('rolePanel').innerHTML = rolePanel();
  if (st.phase === 'clue') renderCluePanel();
  if (st.phase === 'vote') renderVotePanel();
  if (st.phase === 'result') renderResult();
}

$('createButton').addEventListener('click', () => {
  if (!ensureName()) return;
  socket.emit('createRoom', { name: myName() });
});
$('joinButton').addEventListener('click', () => {
  if (!ensureName()) return;
  const code = $('roomCodeInput').value.trim().toUpperCase();
  if (!code) return showToast('کد اتاق رو وارد کن.');
  socket.emit('joinRoom', { name: myName(), code });
});
$('roomCodeInput').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
$('playerName').addEventListener('keydown', event => { if (event.key === 'Enter') $('createButton').click(); });
$('roomCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') $('joinButton').click(); });
$('startButton').addEventListener('click', () => socket.emit('startGame'));
$('clueForm').addEventListener('submit', event => {
  event.preventDefault();
  const clue = $('clueInput').value.trim();
  if (!clue) return showToast('اول سرنخت رو بنویس.');
  socket.emit('submitClue', { clue });
  $('clueInput').value = '';
});
$('shareInviteButton').addEventListener('click', shareInvite);
$('copyCodeButton').addEventListener('click', async () => {
  if (!currentState) return;
  try {
    await navigator.clipboard.writeText(currentState.code);
    showToast('کد اتاق کپی شد؛ برای دوستات بفرست.');
  } catch {
    showToast(`کد اتاق: ${currentState.code}`);
  }
});
$('rulesButton').addEventListener('click', () => $('rulesModal').classList.remove('hidden'));
$('closeRulesButton').addEventListener('click', () => $('rulesModal').classList.add('hidden'));
$('rulesModal').addEventListener('click', event => { if (event.target === $('rulesModal')) $('rulesModal').classList.add('hidden'); });
socket.on('state', renderState);
socket.on('notice', payload => showToast(payload && payload.message ? payload.message : 'یه خطای نامشخص پیش اومد.'));
socket.on('connect', () => { $('connectionText').textContent = 'اتصال آماده'; });
socket.on('disconnect', () => { $('connectionText').textContent = 'اتصال قطع شد'; showToast('ارتباط با بازی قطع شد؛ صفحه رو دوباره بارگذاری کن.'); });

// Use Telegram profile name as a convenience only; the player can edit it.
if (!$('playerName').value && telegramApp && telegramApp.initDataUnsafe && telegramApp.initDataUnsafe.user) {
  const user = telegramApp.initDataUnsafe.user;
  const suggestedName = user.first_name || user.username || '';
  if (suggestedName) $('playerName').value = String(suggestedName).slice(0, 18);
}
const params = new URLSearchParams(window.location.search);
const startParam = telegramApp && telegramApp.initDataUnsafe ? telegramApp.initDataUnsafe.start_param : '';
const invitedCode = params.get('room') || startParam || params.get('tgWebAppStartParam');
if (invitedCode) $('roomCodeInput').value = invitedCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
