'use strict';
const { q } = require('./db');
const U = require('./util');
const M = require('./model');
const DAYS = 30;
async function create(res, req, userId) {
  const tk = U.token();
  await q('INSERT INTO sessions (token, user_id, exp) VALUES (?, ?, ?)', [U.sha(tk), userId, Date.now() + DAYS * 864e5]);
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', 'zs=' + tk + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + DAYS * 86400 + (secure ? '; Secure' : ''));
}
async function destroy(ctx) {
  const tk = ctx.cookies.zs; if (tk) await q('DELETE FROM sessions WHERE token = ?', [U.sha(tk)]);
  ctx.res.setHeader('Set-Cookie', 'zs=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
async function userFor(cookies) {
  const tk = cookies.zs; if (!tk || tk.length !== 64) return null;
  const r = await q('SELECT user_id, exp FROM sessions WHERE token = ?', [U.sha(tk)]); if (!r[0]) return null;
  if (Number(r[0].exp) < Date.now()) { await q('DELETE FROM sessions WHERE token = ?', [U.sha(tk)]); return null; }
  const row = await M.userById(r[0].user_id); if (!row) return null;
  const u = M.rowToUser(row);
  if (u.status === 'suspended' || u.status === 'pending') return null;
  if (u.role === 'staff') { const ow = await M.userById(u.ownerId); if (!ow || M.rowToUser(ow).status !== 'active') return null; }
  return u;
}
async function destroyAllFor(userId) { await q('DELETE FROM sessions WHERE user_id = ?', [userId]); }
module.exports = { create, destroy, userFor, destroyAllFor };
