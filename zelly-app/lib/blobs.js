'use strict';
/* Large images arrive as data: URLs. They are stored once (content-addressed) and replaced by /b/<id> in documents. */
const crypto = require('crypto');
const { q } = require('./db');
const MAX = 4 * 1024 * 1024;
const OK = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/;
async function put(dataUrl) {
  const m = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\r\n]+)$/i.exec(dataUrl);
  if (!m || !OK.test(m[1].toLowerCase())) return null;
  const buf = Buffer.from(m[2], 'base64'); if (!buf.length || buf.length > MAX) return null;
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 40);
  const have = await q('SELECT id FROM blobs WHERE id = ?', [id]);
  if (!have.length) { try { await q('INSERT INTO blobs (id, mime, data, created) VALUES (?, ?, ?, ?)', [id, m[1].toLowerCase(), buf, Date.now()]); } catch (e) { const again = await q('SELECT id FROM blobs WHERE id = ?', [id]); if (!again.length) throw e; } }
  return '/b/' + id;
}
async function get(id) { const r = await q('SELECT mime, data FROM blobs WHERE id = ?', [id]); return r[0] ? { mime: r[0].mime, data: Buffer.from(r[0].data) } : null; }
/* walk a value; replace data-URL strings by blob URLs. Mutates and returns v. Long non-image data URLs are dropped. */
async function externalize(v) {
  if (typeof v === 'string') {
    if (v.startsWith('data:image/') || (v.length > 200 && v.startsWith('data:'))) return (await put(v)) || '';
    return v;
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = await externalize(v[i]); return v; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = await externalize(v[k]); return v; }
  return v;
}
module.exports = { put, get, externalize };
