// Кот-пожарный: сервер мини-приложения Telegram.
// Без зависимостей, нужен Node.js 18+.
// Отдаёт игру, проверяет вход через Telegram (initData), хранит профили и рейтинги,
// продаёт монеты за Telegram Stars и принимает обновления бота через webhook.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройки ----------
loadDotEnv(path.join(ROOT, '.env'));
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const TG_API = (process.env.TG_API || 'https://api.telegram.org').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update('catff-webhook:' + BOT_TOKEN).digest('hex').slice(0, 48);
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '';
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const INITDATA_MAX_AGE = (+process.env.INITDATA_MAX_AGE_HOURS || 24) * 3600;

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Скопируй .env.example в .env и впиши токен от @BotFather.');
  process.exit(1);
}

// Пакеты монет. Цена в звёздах (XTR). Меняй как хочешь, id лучше не трогать после запуска.
const PACKS = [
  { id: 'p100', coins: 100, stars: 15, title: 'Горсть монет' },
  { id: 'p350', coins: 350, stars: 45, title: 'Кошелёк', tag: 'выгодно' },
  { id: 'p900', coins: 900, stars: 100, title: 'Сейф части' },
  { id: 'p2500', coins: 2500, stars: 250, title: 'Казна', tag: 'максимум' },
];

// Длительность уровней в секундах: нужна для простой проверки очков от читов.
const LEVEL_TIME = [60, 90, 120, 120, 120, 120];
const LEVEL_NAMES = ['Двор части', 'Ночной склад', 'Город', 'Кухня ресторана', 'Пожарная часть', 'Рейв'];
const SCORE_PER_SEC_CAP = 200;

// ---------- хранилище (JSON-файл) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, scores: {}, payments: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 400);
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch (_) {} process.exit(0); });

function userRec(u) {
  const id = String(u.id);
  const rec = db.users[id] || (db.users[id] = { created: Date.now(), pending: 0, profile: null });
  rec.name = displayName(u);
  rec.username = u.username || '';
  rec.seen = Date.now();
  return rec;
}
function displayName(u) {
  let n = (u.first_name || '') + (u.last_name ? ' ' + u.last_name[0] + '.' : '');
  if (!n.trim()) n = u.username ? '@' + u.username : 'Кот #' + String(u.id).slice(-4);
  return n.replace(/[\u0000-\u001f​-‏‪-‮]/g, '').trim().slice(0, 24);
}

// ---------- проверка входа через Telegram ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const SECRET = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
function checkInitData(raw) {
  if (!raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('\n');
  const calc = crypto.createHmac('sha256', SECRET).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!(age >= -60 && age < INITDATA_MAX_AGE)) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) { return null; }
}

// ---------- Bot API ----------
async function tg(method, body) {
  const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

function termsText() {
  try { return fs.readFileSync(path.join(ROOT, 'terms.txt'), 'utf8').trim(); }
  catch (_) { return 'Условия покупки не настроены.'; }
}
function supportText() {
  return [
    'Поддержка по покупкам в «Коте-пожарном».',
    SUPPORT_CONTACT ? `Напиши ${SUPPORT_CONTACT} и приложи номер платежа из чека (раздел «Звёзды» в настройках Telegram).` :
      'Ответь на это сообщение, опиши проблему и приложи номер платежа из чека.',
    'Служба поддержки Telegram и @BotSupport не могут помочь с покупками в этом боте.',
  ].join('\n\n');
}

async function onUpdate(u) {
  // 1) подтверждение перед оплатой: отвечаем в течение 10 секунд
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const inv = parsePayload(q.invoice_payload);
    let err = '';
    if (!inv) err = 'Счёт устарел. Открой магазин в игре ещё раз.';
    else if (String(q.from.id) !== inv.uid) err = 'Этот счёт выписан на другого игрока.';
    else if (q.currency !== 'XTR' || q.total_amount !== inv.pack.stars) err = 'Цена изменилась. Открой магазин ещё раз.';
    await tg('answerPreCheckoutQuery', err
      ? { pre_checkout_query_id: q.id, ok: false, error_message: err }
      : { pre_checkout_query_id: q.id, ok: true });
    return;
  }
  const m = u.message;
  if (!m) return;
  // 2) успешная оплата: только теперь начисляем монеты
  if (m.successful_payment) {
    const sp = m.successful_payment;
    const charge = sp.telegram_payment_charge_id;
    if (db.payments[charge]) return; // уже обработан
    const inv = parsePayload(sp.invoice_payload);
    const uid = String(m.from.id);
    const pack = inv ? inv.pack : PACKS.find(p => p.stars === sp.total_amount);
    const coins = pack ? pack.coins : 0;
    db.payments[charge] = { uid, pack: pack && pack.id, stars: sp.total_amount, coins, at: Date.now(), status: 'paid' };
    userRec(m.from).pending += coins;
    persist();
    await tg('sendMessage', { chat_id: m.chat.id, text: `Оплата прошла: +${coins} монет. Они уже ждут тебя в игре.` }).catch(() => {});
    return;
  }
  // 3) возврат, сделанный Telegram или через /refund
  if (m.refunded_payment) {
    markRefunded(m.refunded_payment.telegram_payment_charge_id);
    return;
  }
  const text = (m.text || '').trim();
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '');
  if (cmd === '/start') {
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: 'Привет! Я кот-пожарный. Огонь сам себя не потушит.\nЖми «Играть».',
      reply_markup: PUBLIC_URL ? { inline_keyboard: [[{ text: 'Играть', web_app: { url: PUBLIC_URL + '/' } }]] } : undefined,
    });
  } else if (cmd === '/paysupport') {
    await tg('sendMessage', { chat_id: m.chat.id, text: supportText() });
  } else if (cmd === '/terms') {
    await tg('sendMessage', { chat_id: m.chat.id, text: termsText() });
  } else if (cmd === '/refund' && ADMIN_IDS.has(String(m.from.id))) {
    const charge = text.split(/\s+/)[1];
    const p = charge && db.payments[charge];
    if (!p) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Платёж не найден. Формат: /refund <telegram_payment_charge_id>' }); return; }
    try {
      await tg('refundStarPayment', { user_id: +p.uid, telegram_payment_charge_id: charge });
      markRefunded(charge);
      await tg('sendMessage', { chat_id: m.chat.id, text: `Возврат сделан: ${p.stars}⭐, у игрока списано ${p.coins} монет.` });
    } catch (e) {
      await tg('sendMessage', { chat_id: m.chat.id, text: 'Не получилось: ' + e.message });
    }
  } else if (cmd === '/payments' && ADMIN_IDS.has(String(m.from.id))) {
    const last = Object.entries(db.payments).sort((a, b) => b[1].at - a[1].at).slice(0, 10)
      .map(([c, p]) => `${new Date(p.at).toISOString().slice(0, 16)} · ${db.users[p.uid]?.name || p.uid} · ${p.stars}⭐ · ${p.status}\n${c}`);
    await tg('sendMessage', { chat_id: m.chat.id, text: last.join('\n\n') || 'Платежей пока нет.' });
  }
}
function markRefunded(charge) {
  const p = db.payments[charge];
  if (!p || p.status === 'refunded') return;
  p.status = 'refunded'; p.refundedAt = Date.now();
  // монеты списываются при следующем входе игрока (pending может уйти в минус)
  const u = db.users[p.uid]; if (u) u.pending -= p.coins;
  persist();
}
function makePayload(uid, pack) { return `${uid}:${pack.id}:${crypto.randomBytes(6).toString('hex')}`; }
function parsePayload(s) {
  const [uid, pid] = String(s || '').split(':');
  const pack = PACKS.find(p => p.id === pid);
  return uid && pack ? { uid, pack } : null;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
const PUBLIC_DIR = path.join(ROOT, 'public');
let indexCache = { mtime: 0, html: '' };
function indexHtml() {
  const f = path.join(PUBLIC_DIR, 'game.html');
  const st = fs.statSync(f);
  if (st.mtimeMs !== indexCache.mtime) {
    const game = fs.readFileSync(f, 'utf8');
    indexCache = {
      mtime: st.mtimeMs,
      html: '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">' +
        '<title>Кот-пожарный</title>' +
        '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
        '<script>window.CATFF_API="/api";</script>' +
        '</head><body>\n' + game + '\n</body></html>',
    };
  }
  return indexCache.html;
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(buf);
}
const json = (res, code, obj) => send(res, code, obj);
function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const lastScoreAt = new Map();

async function api(req, res, url) {
  const p = url.pathname.slice(4); // без /api
  if (p === '/packs' && req.method === 'GET') return json(res, 200, { packs: PACKS });
  if (p === '/terms' && req.method === 'GET') return json(res, 200, { text: termsText() });

  const tu = checkInitData(req.headers['x-init-data']);
  if (!tu) return json(res, 401, { error: 'вход через Telegram не подтверждён' });
  const uid = String(tu.id);
  const me = userRec(tu);

  if (p === '/me' && req.method === 'GET') {
    persist();
    return json(res, 200, { user: { id: tu.id, name: me.name }, profile: me.profile });
  }
  if (p === '/profile' && req.method === 'PUT') {
    const b = await readBody(req, 96 * 1024);
    if (!b.profile || typeof b.profile !== 'object' || Array.isArray(b.profile)) return json(res, 400, { error: 'нет профиля' });
    const incoming = +b.profile.upd || 0;
    if (me.profile && (+me.profile.upd || 0) > incoming) return json(res, 409, { error: 'на сервере новее', upd: me.profile.upd });
    me.profile = b.profile; persist();
    return json(res, 200, { ok: true });
  }
  if (p === '/claim' && req.method === 'POST') {
    const coins = me.pending || 0; me.pending = 0; persist();
    return json(res, 200, { coins });
  }
  if (p === '/score' && req.method === 'POST') {
    const b = await readBody(req);
    const lv = b.level, score = b.score, dur = +b.dur || 0;
    if (!Number.isInteger(lv) || lv < 0 || lv >= LEVEL_TIME.length) return json(res, 400, { error: 'уровень' });
    if (!Number.isInteger(score) || score < 0) return json(res, 400, { error: 'очки' });
    if (dur > LEVEL_TIME[lv] + 5 || score > Math.max(dur, 1) * SCORE_PER_SEC_CAP) return json(res, 400, { error: 'подозрительный результат' });
    const now = Date.now();
    if (now - (lastScoreAt.get(uid) || 0) < 8000) return json(res, 429, { error: 'слишком часто' });
    lastScoreAt.set(uid, now);
    const t = db.scores[lv] || (db.scores[lv] = {});
    const prev = t[uid] ? t[uid].s : 0;
    if (score > prev) { t[uid] = { s: score, at: now }; persist(); }
    return json(res, 200, { best: Math.max(prev, score), improved: score > prev });
  }
  if (p === '/leaderboard' && req.method === 'GET') {
    const lv = +url.searchParams.get('level');
    if (!Number.isInteger(lv) || lv < 0 || lv >= LEVEL_TIME.length) return json(res, 400, { error: 'уровень' });
    const rows = Object.entries(db.scores[lv] || {}).sort((a, b) => b[1].s - a[1].s || a[1].at - b[1].at);
    const top = rows.slice(0, 50).map(([id, r]) => ({ name: db.users[id]?.name || 'Кот', score: r.s, me: id === uid }));
    const i = rows.findIndex(([id]) => id === uid);
    return json(res, 200, { level: lv, name: LEVEL_NAMES[lv], top, total: rows.length, me: i >= 0 ? { rank: i + 1, score: rows[i][1].s } : null });
  }
  if (p === '/invoice' && req.method === 'POST') {
    const b = await readBody(req);
    const pack = PACKS.find(x => x.id === b.pack);
    if (!pack) return json(res, 400, { error: 'нет такого пакета' });
    const link = await tg('createInvoiceLink', {
      title: `${pack.coins} монет`,
      description: `${pack.title}: ${pack.coins} монет для кота-пожарного. Монеты тратятся на снаряжение и способности в игре.`,
      payload: makePayload(uid, pack),
      currency: 'XTR',
      prices: [{ label: `${pack.coins} монет`, amount: pack.stars }],
    });
    return json(res, 200, { link });
  }
  return json(res, 404, { error: 'нет такого метода' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/tg/webhook' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return json(res, 403, { error: 'forbidden' });
      const update = await readBody(req, 1024 * 1024);
      json(res, 200, { ok: true });
      onUpdate(update).catch(e => console.error('update', e.message));
      return;
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, indexHtml(), MIME['.html'], { 'Cache-Control': 'no-cache' });
    }
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=3600' });
    });
  } catch (e) {
    console.error(req.method, url.pathname, e.message);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: e.code ? e.message : 'ошибка сервера' });
  }
});

server.listen(PORT, async () => {
  console.log(`Кот-пожарный слушает порт ${PORT}`);
  if (!PUBLIC_URL) { console.log('PUBLIC_URL не задан: webhook и кнопку меню бота настрой вручную.'); return; }
  try {
    await tg('setWebhook', { url: PUBLIC_URL + '/tg/webhook', secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: false });
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: PUBLIC_URL + '/' } } });
    await tg('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть игру' },
      { command: 'paysupport', description: 'Помощь с покупками' },
      { command: 'terms', description: 'Условия покупки' },
    ] });
    console.log('Бот настроен: webhook, кнопка «Играть» и команды.');
  } catch (e) {
    console.error('Не удалось настроить бота:', e.message);
  }
});

function loadDotEnv(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
