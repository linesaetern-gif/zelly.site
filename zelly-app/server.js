'use strict';
/* Zelly — zero-dependency Node server (MySQL in production, SQLite for local tests) */
const fs = require('fs'), path = require('path'), http = require('http');
try { require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) { /* no .env */ }
const DB = require('./lib/db'), U = require('./lib/util'), M = require('./lib/model'), S = require('./lib/session');
const { dispatch, send } = require('./lib/http');
require('./routes/account'); require('./routes/sync'); require('./routes/public');
const { q } = DB;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: blob: https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
};
const indexCache = {};
function indexHtml(shop) {
  const k = shop || '';
  if (!indexCache[k] || process.env.NODE_ENV !== 'production') {
    let h = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    const inj = '<script>window.__ZELLY__=' + JSON.stringify({ api: true, shop: shop || null }).replace(/</g, '\\u003c') + '</script>';
    h = h.includes('<head>') ? h.replace('<head>', '<head>' + inj) : inj + h; indexCache[k] = h;
  }
  return indexCache[k];
}
function serveFile(req, res, file) {
  const st = fs.statSync(file), ext = path.extname(file).toLowerCase();
  res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' }, SEC));
  if (req.method === 'HEAD') return res.end(); fs.createReadStream(file).pipe(res);
}
async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (!ready && p !== '/healthz') return send(res, 503, { error: 'starting' });
    if (p === '/healthz') { if (!ready) return send(res, 503, { ok: false, starting: true }); await q('SELECT 1 AS ok'); return send(res, 200, { ok: true, db: DB.CLIENT }); }
    if (p.startsWith('/api/') || p.startsWith('/b/')) {
      if (req.method === 'POST') { const o = req.headers.origin; if (o && req.headers.host && new URL(o).host !== req.headers.host) throw new U.HttpError(403, 'origin'); }
      const user = p.startsWith('/api/') ? await S.userFor(require('./lib/http').parseCookies(req.headers.cookie)) : null;
      const r = await dispatch(req, res, { user });
      if (r === false) { if (p.startsWith('/b/')) { res.writeHead(404); return res.end(); } return send(res, 404, { error: 'not found' }); }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let rel = decodeURIComponent(p);
    if (rel !== '/' && rel !== '/index.html') {
      const f = path.normalize(path.join(PUB, rel));
      if (f.startsWith(PUB + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() && path.basename(f) !== 'index.html') return serveFile(req, res, f);
    }
    const m = /^\/s\/([^/]+)\/?$/.exec(p);
    const body = indexHtml(m ? m[1].toLowerCase() : null);
    res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' }, SEC));
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof U.HttpError) return send(res, e.code, Object.assign({ error: e.message }, e.extra || {}));
    console.error('[err]', req.method, req.url, e && e.stack || e); send(res, 500, { error: 'server error' });
  }
}

async function bootstrapAdmin() {
  const r = await q("SELECT id FROM users WHERE role = 'super' LIMIT 1"); if (r[0]) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@zelly.local').trim().toLowerCase();
  let pass = process.env.ADMIN_PASSWORD, generated = false; if (!pass) { pass = U.token().slice(0, 14); generated = true; }
  await M.insertUser({ id: 'u-admin', role: 'super', name: 'Super Admin', email, status: 'active', joined: Date.now(), last: 0, phone: '', note: '' }, await U.hashPassword(pass));
  console.log('[zelly] Super admin created: ' + email + (generated ? '  password: ' + pass + '   (CHANGE IT after first login; set ADMIN_PASSWORD to choose your own)' : ''));
}
async function sweepOrders() {
  try {
    const rows = await q("SELECT id FROM docs WHERE id LIKE 'd:%'");
    for (const r of rows) await U.withLock(r.id, async () => { const w = await M.getOwnerDoc(r.id.slice(2)); if (w && M.expireOrders(w.doc)) await M.putDoc(r.id, w.doc); });
  } catch (e) { console.error('[sweep]', e.message); }
}
let ready = false;
async function start() {
  /* listen first: some hosts (Hostinger) require the port to open within ~3 s, before the database is reachable */
  const port = process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT), srv = http.createServer(handler);
  srv.requestTimeout = 60e3; srv.headersTimeout = 20e3; srv.keepAliveTimeout = 65e3;
  await new Promise(ok => srv.listen(port, '0.0.0.0', ok));
  console.log('[zelly] listening on :' + srv.address().port + ' db=' + DB.CLIENT);
  try {
    if (process.env.NODE_ENV === 'production' && DB.CLIENT === 'sqlite' && !process.env.ALLOW_SQLITE) throw new Error('DB_HOST is not set. Create a MySQL database in hPanel and add DB_HOST / DB_USER / DB_PASSWORD / DB_NAME to the environment variables (see README).');
    await DB.migrate(); await M.getPlat(); await bootstrapAdmin(); ready = true; console.log('[zelly] ready');
  } catch (e) { console.error('[zelly] failed to start:', e.message); srv.close(); process.exit(1); }
  const t = setInterval(sweepOrders, 5 * 60e3); t.unref();
  const bye = () => { srv.close(() => DB.close().then(() => process.exit(0), () => process.exit(0))); setTimeout(() => process.exit(0), 5e3).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  return srv;
}
if (!process.env.ZELLY_NO_AUTOSTART) start();
module.exports = { start, handler };
