// Vercel cron: when Gemini's daily AI limit has reset, send a push notification to the owner's phone (ntfy.sh).
// Required environment variables (Vercel dashboard):
//   NTFY_TOPIC      - a long random topic name; subscribe to the same topic in the ntfy phone app
//   CRON_SECRET     - Vercel sends it automatically to cron calls (Authorization: Bearer ...)
//   APP_PASSCODE    - used for the manual test: /api/quota-reset?test=1&passcode=...
//   KV_REST_API_URL / KV_REST_API_TOKEN - set automatically by the Upstash Redis integration
// Gemini's daily quota resets at midnight Pacific time, so the cron runs at 07:05 and 08:05 UTC
// and only acts when the Pacific clock reads 00:xx.

const crypto = require('crypto');

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function redisConf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/$/, ''), token };
}

async function redisCmd(conf, cmd) {
  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + conf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok || json === null) throw new Error('redis http ' + res.status);
  if (json.error) throw new Error('redis ' + json.error);
  return json.result;
}

// Pacific calendar date (YYYY-MM-DD) for a timestamp.
function ptDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Pacific hour (0-23) right now.
function ptHour(ms) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return Number(s);
}

async function notify(topic, body) {
  const res = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
    method: 'POST',
    headers: { Title: 'Aloha AI quota', Tags: 'sparkles', Priority: 'high' },
    body,
  });
  if (!res.ok) throw new Error('ntfy http ' + res.status);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => res.status(code).json(body);

  const query = req.query || {};
  const cronSecret = process.env.CRON_SECRET;
  const passcode = process.env.APP_PASSCODE;
  const auth = String((req.headers && req.headers.authorization) || '');
  const isCron = !!cronSecret && auth === 'Bearer ' + cronSecret;
  const isTest = query.test === '1' && !!passcode && typeof query.passcode === 'string' && sameSecret(query.passcode, passcode);
  if (!isCron && !isTest) return send(401, { error: '권한이 없어요.' });

  const topic = process.env.NTFY_TOPIC;
  if (!topic) return send(500, { error: 'NTFY_TOPIC 환경변수가 없어요.' });

  try {
    if (isTest) {
      await notify(topic, '알림 테스트예요. 이 알림이 보이면 AI 한도 알림이 연결된 거예요.');
      return send(200, { ok: true, test: true });
    }

    const now = Date.now();
    if (ptHour(now) !== 0) return send(200, { ok: true, sent: false, reason: 'not reset time yet' });

    const conf = redisConf();
    if (!conf) return send(500, { error: 'Upstash Redis가 연결되어 있지 않아요.' });

    // The limit was hit on the previous Pacific day (2 hours before this run).
    const key = 'ai:day-limit:' + ptDate(now - 2 * 60 * 60 * 1000);
    const flag = await redisCmd(conf, ['GET', key]);
    if (!flag) return send(200, { ok: true, sent: false });

    await notify(topic, 'AI 요약 한도가 풀렸어요. 지금 다시 요약할 수 있어요. 알로하 → 2. 요약에서 이어서 해 주세요.');
    await redisCmd(conf, ['DEL', key]);
    return send(200, { ok: true, sent: true });
  } catch (err) {
    console.error('quota-reset failed', err && err.message);
    return send(502, { error: '알림을 보내지 못했어요.' });
  }
};
