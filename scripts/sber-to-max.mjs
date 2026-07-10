import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChatId, sendMaxMessage } from './max-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const logsDir = join(root, 'logs');
await mkdir(logsDir, { recursive: true });

const token = required('MAX_BOT_TOKEN');
const sourceUrl = process.env.SBER_SOURCE_URL || 'https://sberazs.ru/';
const chromePath = process.env.CHROME_PATH || findChrome();
const captureMs = Math.max(12, Number(process.env.CAPTURE_SECONDS || 25)) * 1000;
const center = {
  lat: Number(process.env.TARGET_LAT || 52.318),
  lon: Number(process.env.TARGET_LON || 38.345)
};
const bbox = {
  minLat: Number(process.env.BBOX_MIN_LAT || 52.20),
  maxLat: Number(process.env.BBOX_MAX_LAT || 52.52),
  minLon: Number(process.env.BBOX_MIN_LON || 38.08),
  maxLon: Number(process.env.BBOX_MAX_LON || 38.62)
};

if (!chromePath) throw new Error('Chrome/Chromium не найден. На GitHub Actions используйте /usr/bin/google-chrome.');

const chatId = await resolveChatId(token, {
  chatId: process.env.MAX_TARGET_CHAT_ID,
  channelLink: process.env.MAX_CHANNEL_LINK
});

const result = await collectStations();
await writeFile(join(logsDir, 'last-result.json'), JSON.stringify(result, null, 2));

if (!result.stations.length) {
  throw new Error('Данные АЗС Долгоруковского округа не найдены. Сообщение в MAX не отправлено, чтобы не публиковать недостоверную сводку. Откройте журнал last-discovery.json в артефактах запуска.');
}

const message = formatMessage(result.stations);
await sendMaxMessage(token, chatId, message);
console.log(`Отправлено станций: ${result.stations.length}; chat_id=${chatId}`);

async function collectStations() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = join('/tmp', `dolg-fuel-${process.pid}-${Date.now()}`);
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--lang=ru-RU', '--window-size=1440,1000',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const target = await waitForTarget(port, 15_000);
    const hits = await navigateAndCapture(target.webSocketDebuggerUrl, sourceUrl, captureMs);
    await writeFile(join(logsDir, 'last-discovery.json'), JSON.stringify(hits.map(hit => ({
      url: hit.url,
      status: hit.status,
      mime: hit.mime,
      bodyPreview: hit.body?.slice(0, 500)
    })), null, 2));

    const objects = [];
    for (const hit of hits) {
      if (!hit.body) continue;
      try { walk(JSON.parse(hit.body), objects); } catch { /* не JSON */ }
    }
    const stations = dedupe(objects.map(normalize).filter(Boolean)).slice(0, 12);
    return { checkedAt: new Date().toISOString(), sourceUrl, stations };
  } finally {
    chrome.kill('SIGTERM');
    if (stderr) await writeFile(join(logsDir, 'chrome.log'), stderr.slice(-30_000));
  }
}

async function navigateAndCapture(wsUrl, url, duration) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const hits = [];
    const send = (method, params = {}) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Истекло время ожидания страницы sberazs.ru'));
    }, duration + 20_000);

    ws.onopen = async () => {
      try {
        await send('Network.enable');
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Moscow' }).catch(() => {});
        await send('Emulation.setGeolocationOverride', { latitude: center.lat, longitude: center.lon, accuracy: 50 }).catch(() => {});
        await send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['geolocation'] }).catch(() => {});
        await send('Page.navigate', { url });
        setTimeout(async () => {
          for (const hit of hits) {
            try {
              const data = await send('Network.getResponseBody', { requestId: hit.requestId });
              hit.body = data.body;
            } catch {}
          }
          clearTimeout(timer);
          ws.close();
          resolve(hits);
        }, duration);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter.rej(new Error(msg.error.message)); else waiter.res(msg.result || {});
        return;
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response || {};
        const candidate = /json/i.test(r.mimeType || '') || /(api|station|azs|fuel|map|poi|geo)/i.test(r.url || '');
        if (candidate && Number(r.status || 0) < 400) hits.push({ requestId: msg.params.requestId, url: r.url, mime: r.mimeType, status: r.status });
      }
    };
    ws.onerror = error => { clearTimeout(timer); reject(error); };
  });
}

function walk(value, out, depth = 0) {
  if (depth > 15 || value == null) return;
  if (Array.isArray(value)) { for (const item of value) walk(item, out, depth + 1); return; }
  if (typeof value !== 'object') return;
  const coords = findCoords(value);
  if (coords && inside(coords.lat, coords.lon)) {
    const text = JSON.stringify(value).toLowerCase();
    if (/(азс|заправ|fuel|station|бензин|diesel|аи-?92|аи-?95|топлив)/i.test(text)) out.push(value);
  }
  for (const child of Object.values(value)) walk(child, out, depth + 1);
}

function findCoords(o) {
  const pairs = [['lat','lon'], ['lat','lng'], ['latitude','longitude'], ['y','x']];
  for (const [a, b] of pairs) {
    const lat = Number(o[a]); const lon = Number(o[b]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  if (Array.isArray(o.coordinates) && o.coordinates.length >= 2) {
    const [a, b] = o.coordinates.map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (a >= 30 && a <= 50 && b >= 50 && b <= 60) return { lat: b, lon: a };
      if (a >= 50 && a <= 60 && b >= 30 && b <= 50) return { lat: a, lon: b };
    }
  }
  return null;
}

function normalize(obj) {
  const coords = findCoords(obj);
  if (!coords) return null;
  const flat = flatten(obj);
  const raw = JSON.stringify(obj);
  const name = pick(flat, ['stationName', 'organizationName', 'name', 'title', 'brand'])
    || (/роснефть/i.test(raw) ? 'Роснефть' : /тритон/i.test(raw) ? 'Тритон' : /алмаз/i.test(raw) ? 'Алмаз' : 'АЗС');
  const address = pick(flat, ['fullAddress', 'address', 'subtitle', 'description']) || 'Долгоруковский округ';
  const status = guessStatus(raw);
  return {
    name: clean(name, 90), address: clean(address, 180), lat: coords.lat, lon: coords.lon,
    status, statusLabel: statusLabel(status), lastSeenAt: findDate(flat), fuel: guessFuel(raw, status)
  };
}

function formatMessage(stations) {
  const lines = ['⛽ **Обстановка на АЗС Долгоруковского округа**', ''];
  for (const station of stations) {
    lines.push(`${statusIcon(station.status)} **${escapeMarkdown(station.name)}**`);
    lines.push(escapeMarkdown(station.address));
    lines.push(`Статус: **${escapeMarkdown(station.statusLabel)}**`);
    const fuel = station.fuel.filter(item => item.detected).map(item => `${item.label} — ${item.available ? 'есть' : 'нет'}`);
    if (fuel.length) lines.push(fuel.join(' · '));
    if (station.lastSeenAt) lines.push(`Данные на: ${formatDate(station.lastSeenAt)}`);
    lines.push('');
  }
  lines.push(`Проверено: ${formatDate(new Date().toISOString())}`);
  lines.push('_Данные автоматически получены из публично отображаемой карты sberazs.ru и носят справочный характер._');
  return lines.join('\n').slice(0, 4000);
}

function flatten(o, prefix = '', out = {}) {
  if (!o || typeof o !== 'object') return out;
  for (const [key, value] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else { out[key] = value; out[path] = value; }
  }
  return out;
}
function pick(flat, keys) {
  for (const wanted of keys) for (const [key, value] of Object.entries(flat)) {
    if (key.toLowerCase().endsWith(wanted.toLowerCase()) && typeof value === 'string' && value.trim().length > 1) return value.trim();
  }
  return null;
}
function findDate(flat) {
  for (const [key, value] of Object.entries(flat)) {
    if (!/(time|date|updated|last|moment)/i.test(key) || !['string','number'].includes(typeof value)) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf()) && date.getFullYear() >= 2020) return date.toISOString();
  }
  return null;
}
function guessStatus(text) {
  const t = text.toLowerCase();
  if (/(закрыт|closed|не работает)/.test(t)) return 'closed';
  if (/(нет топлива|топлива нет|unavailable|empty)/.test(t)) return 'unavailable';
  if (/(есть топливо|топливо есть|available|покупали недавно|недавно заправ)/.test(t)) return 'available';
  if (/(было недавно|возможно есть|recent|maybe)/.test(t)) return 'recent';
  return 'unknown';
}
function guessFuel(text, status) {
  const t = text.toLowerCase();
  return [
    ['АИ-92', /(аи[- ]?92|ai[- ]?92)/],
    ['АИ-95', /(аи[- ]?95|ai[- ]?95)/],
    ['ДТ', /(дт|diesel|дизел)/]
  ].map(([label, regex]) => ({ label, detected: regex.test(t), available: !['closed','unavailable'].includes(status) }));
}
function statusLabel(status) { return ({ available:'Есть топливо', recent:'Возможно есть', unavailable:'Топлива нет', closed:'Закрыта', unknown:'Данные уточняются' })[status]; }
function statusIcon(status) { return ({ available:'🟢', recent:'🟡', unavailable:'🔴', closed:'⚫', unknown:'⚪' })[status]; }
function formatDate(value) { return new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(value)); }
function clean(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function escapeMarkdown(value) { return clean(value, 500).replace(/([*_~`\[\]])/g, '\\$1'); }
function inside(lat, lon) { return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon; }
function dedupe(list) {
  const out = [];
  for (const item of list) if (!out.some(existing => distance(existing, item) < 0.3)) out.push(item);
  return out;
}
function distance(a, b) { return Math.hypot((a.lat-b.lat)*111, (a.lon-b.lon)*68); }
function findChrome() { return ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync) || null; }
async function waitForTarget(port, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page');
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Не удалось подключиться к Chrome DevTools');
}
function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Не задан секрет ${name}`);
  return value;
}
