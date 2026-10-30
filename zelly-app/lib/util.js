'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

/* per-key async mutex: serialises read-modify-write on one document */
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release; const next = new Promise(r => { release = r; });
  const chain = prev.then(() => next); locks.set(key, chain);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$'); if (alg !== 'scrypt') return false;
  const calc = await scrypt(String(pw), Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex'); return want.length === calc.length && crypto.timingSafeEqual(want, calc);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const rid = n => crypto.randomBytes(n || 4).toString('hex');
const day = s => Math.round(new Date(s + 'T00:00:00Z').getTime() / 864e5);
const todayStr = () => { const d = new Date(Date.now() + 7 * 36e5); return d.toISOString().slice(0, 10); }; // Asia/Vientiane (UTC+7)
const addDays = n => { const d = new Date(Date.now() + 7 * 36e5 + n * 864e5); return d.toISOString().slice(0, 10); };
const clone = o => JSON.parse(JSON.stringify(o));
class HttpError extends Error { constructor(code, msg, extra) { super(msg || String(code)); this.code = code; this.extra = extra; } }
/* tiny in-memory rate limiter */
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter(t => now - t < 3600e3); if (f.length) hits.set(k, f); else hits.delete(k); } }, 600e3).unref();
/* client address; Hostinger (and most hosts) put a reverse proxy in front, so trust the first X-Forwarded-For hop */
const ip = req => { const x = process.env.TRUST_PROXY === '0' ? '' : String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return x || (req.socket && req.socket.remoteAddress) || '?'; };
module.exports = { ip, withLock, hashPassword, verifyPassword, sha, token, rid, day, todayStr, addDays, clone, HttpError, rateLimit };
