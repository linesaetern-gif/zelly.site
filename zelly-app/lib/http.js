'use strict';
const { HttpError } = require('./util');
const routes = [];
function route(method, pattern, handler, opts) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts: opts || {} });
}
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const send = (res, code, obj, headers) => { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }, headers || {})); res.end(b); };
async function dispatch(req, res, ctxBase) {
  const url = new URL(req.url, 'http://x'), pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname); if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const ctx = Object.assign({ req, res, params, query: Object.fromEntries(url.searchParams), body: null, cookies: parseCookies(req.headers.cookie) }, ctxBase);
    if (req.method === 'POST') {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json only');
      const buf = await readBody(req, r.opts.limit || 12 * 1024 * 1024); ctx.raw = buf;
      try { ctx.body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { throw new HttpError(400, 'bad json'); }
    }
    return r.handler(ctx);
  }
  return false;
}
module.exports = { route, dispatch, send, parseCookies };
