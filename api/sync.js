// Vercel serverless function: stores the site's records in a Redis database (Upstash)
// so that every device sees the same data.
//
//   GET  /api/sync                      -> public records only (news summaries, flow analyses ...), no passcode
//   POST /api/sync {passcode,action:'pull'}                    -> public + private records
//   POST /api/sync {passcode,action:'push',key,ts,value}       -> saves one record (passcode required)
//
// Environment variables:
//   APP_PASSCODE                                  - same passcode as the AI features
//   KV_REST_API_URL + KV_REST_API_TOKEN           - set automatically when an Upstash Redis database
//   (or UPSTASH_REDIS_REST_URL + ..._TOKEN)         is connected to the Vercel project

const crypto = require('crypto');

const PUBLIC_KEYS = ['dict-news-memos-v1', 'flow-analyses-v1', 'dict-user-articles-v1', 'dict-term-mentions-v1'];
const PRIVATE_RE = /^(campus-note-v1|taste-[a-z0-9-]{1,40})$/;
const MAX_VALUE = 900000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_READS = 120;
const MAX_WRITES = 400;
const MAX_FAILED_AUTH = 8;

const readLog = new Map();
const writeLog = new Map();
const failedAuthLog = new Map();

function keyAllowed(k) {
  return typeof k === 'string' && (PUBLIC_KEYS.includes(k) || PRIVATE_RE.test(k));
}

function recent(log, key) {
  const now = Date.now();
  const list = (log.get(key) || []).filter((t) => now - t < WINDOW_MS);
  log.set(key, list);
  return list;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function redisConf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/$/, ''), token };
}

async function redisCall(conf, path, payload) {
  const res = await fetch(conf.url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + conf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok || json === null) throw new Error('redis http ' + res.status);
  return json;
}

async function redisCmd(conf, cmd) {
  const json = await redisCall(conf, '', cmd);
  if (json.error) throw new Error('redis ' + json.error);
  return json.result;
}

async function loadKeys(conf, keys) {
  const out = {};
  if (!keys.length) return out;
  const values = await redisCmd(conf, ['MGET', ...keys.map((k) => 'sync:' + k)]);
  keys.forEach((k, i) => {
    const raw = values && values[i];
    if (typeof raw !== 'string') return;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec.ts === 'number' && typeof rec.value === 'string') out[k] = { ts: rec.ts, value: rec.value };
    } catch { /* ignore broken record */ }
  });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => res.status(code).json(body);

  const conf = redisConf();
  if (!conf) return send(501, { error: '서버 저장소가 아직 연결되지 않았어요.' });

  const ip = clientIp(req);

  try {
    if (req.method === 'GET') {
      if (recent(readLog, ip).length >= MAX_READS) return send(429, { error: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.' });
      readLog.get(ip).push(Date.now());
      return send(200, { keys: await loadKeys(conf, PUBLIC_KEYS) });
    }
    if (req.method !== 'POST') return send(405, { error: 'GET 또는 POST 요청만 받아요.' });

    const passcode = process.env.APP_PASSCODE;
    if (!passcode) return send(500, { error: '서버 설정(APP_PASSCODE)이 아직 없어요.' });
    if (recent(failedAuthLog, ip).length >= MAX_FAILED_AUTH) {
      return send(429, { error: '암호를 여러 번 틀렸어요. 잠시 뒤에 다시 시도해 주세요.' });
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return send(400, { error: '요청 형식이 올바르지 않아요.' });
    if (typeof body.passcode !== 'string' || !sameSecret(body.passcode, passcode)) {
      failedAuthLog.get(ip).push(Date.now());
      return send(401, { error: '암호가 맞지 않아요.' });
    }

    if (body.action === 'pull') {
      if (recent(readLog, ip).length >= MAX_READS) return send(429, { error: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.' });
      readLog.get(ip).push(Date.now());
      const members = await redisCmd(conf, ['SMEMBERS', 'sync:index']);
      const all = [...new Set([...PUBLIC_KEYS, ...(Array.isArray(members) ? members : [])])].filter(keyAllowed);
      return send(200, { keys: await loadKeys(conf, all) });
    }

    if (body.action === 'push') {
      if (recent(writeLog, ip).length >= MAX_WRITES) return send(429, { error: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.' });
      writeLog.get(ip).push(Date.now());
      const { key, ts, value } = body;
      if (!keyAllowed(key)) return send(400, { error: '저장할 수 없는 항목이에요.' });
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return send(400, { error: '시간 값이 올바르지 않아요.' });
      if (typeof value !== 'string' || value.length > MAX_VALUE) return send(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
      try { JSON.parse(value); } catch { return send(400, { error: '기록 형식이 올바르지 않아요.' }); }

      const existing = (await loadKeys(conf, [key]))[key];
      if (existing && existing.ts > ts) return send(409, { error: '서버에 더 새로운 기록이 있어요.', ts: existing.ts });

      const rec = JSON.stringify({ ts, value });
      await redisCall(conf, '/pipeline', [['SET', 'sync:' + key, rec], ['SADD', 'sync:index', key]]);
      return send(200, { ok: true, ts });
    }

    return send(400, { error: '알 수 없는 요청이에요.' });
  } catch (err) {
    console.error('sync failed', err && err.message);
    return send(502, { error: '서버 저장소에 연결하지 못했어요. 잠시 뒤에 다시 시도해 주세요.' });
  }
};
