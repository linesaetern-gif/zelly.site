'use strict';
const { q } = require('../lib/db');
const U = require('../lib/util');
const M = require('../lib/model');
const B = require('../lib/blobs');
const S = require('../lib/session');
const { route, send } = require('../lib/http');
const { HttpError } = U;
const Pay = require('../lib/payments'), N = require('../lib/notify');
const LANGS = ['lo', 'th', 'en'];
const PROVS = ['vtc', 'pho', 'lnt', 'bok', 'oud', 'lpb', 'hou', 'say', 'xkh', 'vte', 'blx', 'kha', 'svk', 'slv', 'sek', 'chm', 'att', 'xai'];   /* 18 provinces of Laos */
const BIZ_TYPES = ['fashion', 'cosmetics', 'supplement', 'home', 'jewelry', 'other'];
const Bill = () => require('./billing');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = M.clip;
const userView = u => { const v = Object.assign({}, u); delete v.pass; return v; };
function expireRequests(plat) { const now = Date.now(); let n = 0; plat.requests.forEach(r => { if (r.status === 'pending' && !r.slip && r.due && r.due <= now) { r.status = 'expired'; n++; } }); return n; }
const need = ctx => { if (!ctx.user) throw new HttpError(401, 'auth'); return ctx.user; };
/* referral codes (owner -> owner affiliate) */
const REFCH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanRef = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
async function ownerByRef(code) {
  if (!code) return null; const r = await q("SELECT * FROM users WHERE role = 'owner' AND data LIKE ?", ['%"ref":"' + code + '"%']);
  return r.map(M.rowToUser).find(u => u.ref === code) || null;
}
async function newRef() {
  for (let i = 0; i < 8; i++) { const b = require('crypto').randomBytes(6); let c = 'Z'; for (const x of b) c += REFCH[x % REFCH.length]; if (!(await ownerByRef(c))) return c; }
  return 'Z' + U.rid(5).toUpperCase();
}
async function ensureRef(u) { if (u.role !== 'owner' || u.ref) return u; const data = M.dataOf(u); data.ref = await newRef(); await M.saveUserData(u.id, data); u.ref = data.ref; return u; }
const acctId = u => u.role === 'staff' ? u.ownerId : u.id;

/* what a given user may see of the platform document */
async function platView(user, plat) {
  const base = { settings: plat.settings, plans: plat.plans, seq: plat.seq, commissions: [], payouts: [], online: Pay.online(), emailOn: !!user && user.role === 'super' ? N.enabled() : undefined };
  if (!user) { const s = Object.assign({}, plat.settings); delete s.pay; return Object.assign(base, { settings: s, users: [], requests: [], payments: [], messages: [] }); }
  if (user.role === 'super') {
    const rows = await M.allUsers(), users = [];
    for (const r of rows) {
      const u = userView(M.rowToUser(r));
      if (u.role === 'owner') { const d = await M.getDoc('d:' + u.id); u.usage = d ? M.usageOf(d.doc) : { shops: 0, products: 0, whs: 0 }; }
      users.push(u);
    }
    return Object.assign(base, { users, requests: plat.requests, payments: plat.payments, messages: plat.messages, commissions: plat.commissions, payouts: plat.payouts });
  }
  const ownerRow = await M.userById(acctId(user)), users = [userView(M.rowToUser(ownerRow))];
  if (user.role === 'owner') (await M.staffOf(user.id)).forEach(r => users.push(userView(M.rowToUser(r))));
  else users.push(userView(user));
  const oid = acctId(user);
  let payments = plat.payments.filter(p => p.uid === oid), commissions = [], payouts = [];
  if (user.role === 'owner') {   /* affiliate: the people I referred (no private data) and what I earned */
    const refd = (await q("SELECT * FROM users WHERE role = 'owner' AND data LIKE ?", ['%"refBy":"' + user.id + '"%'])).map(M.rowToUser).filter(x => x.refBy === user.id);
    refd.forEach(x => users.push({ id: x.id, role: 'owner', name: x.name, biz: x.biz, joined: x.joined, planId: x.planId, refBy: x.refBy, status: x.status }));
    refd.forEach(x => plat.payments.filter(p => p.uid === x.id).forEach(p => payments.push({ id: p.id, uid: p.uid, planId: p.planId, months: p.months, amount: 0, method: '', note: '', t: p.t })));
    commissions = plat.commissions.filter(c => c.uid === user.id); payouts = plat.payouts.filter(w => w.uid === user.id);
  }
  return Object.assign(base, { users, requests: plat.requests.filter(r => r.uid === oid), payments, messages: [], commissions, payouts });
}

/* ---------- boot / workspace ---------- */
route('GET', '/api/boot', async ctx => {
  const { doc: plat } = await M.getPlat();
  send(ctx.res, 200, { user: ctx.user ? userView(ctx.user) : null, plat: await platView(ctx.user, plat) });
});
route('GET', '/api/workspace', async ctx => {
  const u = await ensureRef(need(ctx)), { doc: plat } = await M.getPlat();
  if (U.rateLimit('ws:' + u.id, 120, 60e3) === false) throw new HttpError(429, 'slow down');
  const out = { user: userView(u), plat: await platView(u, plat) };
  if (u.role !== 'super') {
    const oid = acctId(u);
    out.d = await U.withLock('d:' + oid, async () => { const w = await M.getOwnerDoc(oid); if (M.expireOrders(w.doc)) w.rev = await M.putDoc('d:' + oid, w.doc); return w; });
  }
  send(ctx.res, 200, out);
});

/* ---------- auth ---------- */
/* step 1 of the sign-up wizard: is this e-mail still free? */
route('POST', '/api/auth/check-email', async ctx => {
  if (!U.rateLimit('ce:' + U.ip(ctx.req), 30, 600e3)) throw new HttpError(429, 'au.rate');
  const email = clip(ctx.body.email, 150).trim().toLowerCase(); if (!EMAIL.test(email)) return send(ctx.res, 400, { error: 'err.email' });
  send(ctx.res, 200, { ok: true, free: !(await M.userByEmail(email)) });
});
route('POST', '/api/auth/signup', async ctx => {
  const b = ctx.body, ip = U.ip(ctx.req);
  if (!U.rateLimit('su:' + ip, 8, 3600e3)) throw new HttpError(429, 'au.rate');
  const img = b.img ? (await B.put(String(b.img))) || '' : '';
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), st = pl.doc.settings;
    if (!st.signupOpen) return { error: 'au.closed' };
    const email = clip(b.email, 150).trim().toLowerCase(), name = clip(b.name, 80).trim(), pass = String(b.pass || '');
    if (!name || !EMAIL.test(email)) return { error: 'err.email' };
    if (pass.length < 6) return { error: 'err.pass' };
    if (await M.userByEmail(email)) return { error: 'au.exists' };
    const rc = cleanRef(b.ref); let refBy = '';
    if (rc) { const rf = await ownerByRef(rc); if (!rf) return { error: 'af.refBad' }; if (st.aff && st.aff.on) refBy = rf.id; }
    const trial = st.trialDays > 0 && M.planOf(pl.doc, st.trialPlan) && st.trialPlan !== 'free';
    const u = { role: 'owner', email, name, biz: clip(b.biz, 100).trim(), phone: clip(b.phone, 30).trim(), planId: trial ? st.trialPlan : 'free', status: 'active' /* new owners start at once, no admin approval */, exp: trial ? U.addDays(st.trialDays) : '', joined: Date.now(), note: '', last: Date.now(), refBy, ref: await newRef(), lang: LANGS.includes(b.lang) ? b.lang : 'lo', bizType: BIZ_TYPES.includes(b.bizType) ? b.bizType : '', prov: PROVS.includes(b.prov) ? b.prov : '', dist: clip(b.dist, 80).trim(), vill: clip(b.vill, 80).trim(), addr: clip(b.addr, 300).trim(), img };
    const id = await M.insertUser(u, await U.hashPassword(pass));
    return { id, pending: u.status === 'pending', trial: !!trial, u: Object.assign({}, u, { email }) };
  });
  if (out.error) return send(ctx.res, 400, out);
  if (!out.pending) await S.create(ctx.res, ctx.req, out.id);
  N.welcome(out.u, out.pending);
  send(ctx.res, 200, { ok: true, pending: out.pending, trial: out.trial });
});
route('POST', '/api/auth/login', async ctx => {
  const email = clip(ctx.body.email, 150).trim().toLowerCase(), ip = U.ip(ctx.req);
  if (!U.rateLimit('li:' + ip + ':' + email, 10, 600e3)) throw new HttpError(429, 'au.rate');
  const row = await M.userByEmail(email);
  if (!row || !(await U.verifyPassword(String(ctx.body.pass || ''), row.pass_hash))) return send(ctx.res, 401, { error: 'au.bad' });
  const u = M.rowToUser(row);
  if (u.status === 'pending') return send(ctx.res, 403, { error: 'au.pending' });
  if (u.status === 'suspended') return send(ctx.res, 403, { error: u.role === 'staff' ? 'stf.offMsg' : 'au.suspended' });
  if (u.role === 'staff') { const ow = await M.userById(u.ownerId); if (!ow || M.rowToUser(ow).status !== 'active') return send(ctx.res, 403, { error: 'au.suspended' }); }
  const data = M.dataOf(u); data.last = Date.now(); if (LANGS.includes(ctx.body.lang)) data.lang = ctx.body.lang; await M.saveUserData(u.id, data);
  await S.create(ctx.res, ctx.req, u.id);
  send(ctx.res, 200, { ok: true });
});
route('POST', '/api/auth/logout', async ctx => { await S.destroy(ctx); send(ctx.res, 200, { ok: true }); });

/* ---------- own profile ---------- */
route('POST', '/api/me/profile', async ctx => {
  const u = need(ctx), b = ctx.body, data = M.dataOf(u); let email = null;
  const name = clip(b.name, 80).trim(); if (!name) return send(ctx.res, 400, { error: 'prof.errName' });
  data.name = name; data.phone = clip(b.phone, 30).trim(); if (LANGS.includes(b.lang)) data.lang = b.lang;
  if (u.role !== 'staff') {
    data.biz = clip(b.biz, 100).trim(); data.addr = clip(b.addr, 300).trim();
    const e = clip(b.email, 150).trim().toLowerCase();
    if (!EMAIL.test(e)) return send(ctx.res, 400, { error: 'stf.errEmail' });
    const dup = await M.userByEmail(e); if (dup && dup.id !== u.id) return send(ctx.res, 400, { error: 'stf.errDup' });
    if (e !== u.email) email = e;
  }
  if (b.img !== undefined) data.img = b.img ? (await B.put(b.img)) || '' : '';
  await M.saveUserData(u.id, data, email);
  const { doc: plat } = await M.getPlat(); const fresh = M.rowToUser(await M.userById(u.id));
  send(ctx.res, 200, { ok: true, user: userView(fresh), plat: await platView(fresh, plat) });
});
route('POST', '/api/me/lang', async ctx => {
  const u = need(ctx); if (!LANGS.includes(ctx.body.lang)) throw new HttpError(400, 'lang');
  if (u.lang !== ctx.body.lang) { const data = M.dataOf(u); data.lang = ctx.body.lang; await M.saveUserData(u.id, data); }
  send(ctx.res, 200, { ok: true });
});
route('POST', '/api/me/password', async ctx => {
  const u = need(ctx), row = await M.userById(u.id), b = ctx.body;
  if (!(await U.verifyPassword(String(b.cur || ''), row.pass_hash))) return send(ctx.res, 400, { error: 'prof.pwBad' });
  if (String(b.pw || '').length < 6) return send(ctx.res, 400, { error: 'stf.errPass' });
  await q('UPDATE users SET pass_hash = ? WHERE id = ?', [await U.hashPassword(b.pw), u.id]);
  send(ctx.res, 200, { ok: true });
});

/* ---------- staff (owner only) ---------- */
const PERMS = ['overview', 'orders', 'cod', 'chat', 'stock', 'stores', 'promo', 'members', 'reports', 'payments', 'shipping', 'vat', 'settings', 'pack', 'shop'];
route('POST', '/api/staff', async ctx => {
  const o = need(ctx); if (o.role !== 'owner') throw new HttpError(403, 'owner only');
  const b = ctx.body, email = clip(b.email, 150).trim().toLowerCase(), name = clip(b.name, 80).trim(), pass = String(b.pass || '').trim();
  const perms = (Array.isArray(b.perms) ? b.perms : []).filter(p => PERMS.includes(p));
  if (!name) return send(ctx.res, 400, { error: 'stf.errName' });
  if (!EMAIL.test(email)) return send(ctx.res, 400, { error: 'stf.errEmail' });
  if (!perms.length) return send(ctx.res, 400, { error: 'stf.errPerm' });
  const status = b.status === 'active' ? 'active' : 'suspended';
  let row = null;
  if (b.id) { row = await M.userById(b.id); if (!row || row.owner_id !== o.id || row.role !== 'staff') throw new HttpError(404, 'not found'); }
  const dup = await M.userByEmail(email); if (dup && (!row || dup.id !== row.id)) return send(ctx.res, 400, { error: 'stf.errDup' });
  if ((!row || pass) && pass.length < 6) return send(ctx.res, 400, { error: 'stf.errPass' });
  const img = b.img === undefined ? undefined : (b.img ? (await B.put(b.img)) || '' : '');
  if (row) {
    const data = M.dataOf(M.rowToUser(row)); Object.assign(data, { name, phone: clip(b.phone, 30).trim(), perms, status }); if (img !== undefined) data.img = img;
    await M.saveUserData(row.id, data, email !== row.email ? email : null);
    if (pass) await q('UPDATE users SET pass_hash = ? WHERE id = ?', [await U.hashPassword(pass), row.id]);
    if (status !== 'active') await S.destroyAllFor(row.id);
  } else {
    await M.insertUser({ role: 'staff', ownerId: o.id, name, phone: clip(b.phone, 30).trim(), email, perms, status, img: img || '', joined: Date.now(), last: 0, note: '' }, await U.hashPassword(pass));
  }
  const { doc: plat } = await M.getPlat(); send(ctx.res, 200, { ok: true, plat: await platView(o, plat) });
});
route('POST', '/api/staff/delete', async ctx => {
  const o = need(ctx); if (o.role !== 'owner') throw new HttpError(403, 'owner only');
  const row = await M.userById(ctx.body.id); if (!row || row.owner_id !== o.id || row.role !== 'staff') throw new HttpError(404, 'not found');
  await S.destroyAllFor(row.id); await q('DELETE FROM users WHERE id = ?', [row.id]);
  const { doc: plat } = await M.getPlat(); send(ctx.res, 200, { ok: true, plat: await platView(o, plat) });
});

/* ---------- subscription requests (owner) ---------- */
const planTotal = (plat, p, months) => { const s = plat.settings, d = months >= 12 ? s.disc12 : months >= 3 ? s.disc3 : 0; return Math.round(p.price * months * (1 - d / 100) / 1000) * 1000; };
route('POST', '/api/billing/request', async ctx => {
  const u = need(ctx); if (u.role !== 'owner') throw new HttpError(403, 'owner only');
  const months = Math.floor(+ctx.body.months); if (!(months >= 1 && months <= 36)) throw new HttpError(400, 'months');
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), plat = pl.doc, p = M.planOf(plat, ctx.body.planId);
    if (!p || p.on === false || p.id === 'free') return null;
    expireRequests(plat);
    const id = 'REQ-' + (plat.seq.req++);
    plat.requests.unshift({ id, uid: u.id, planId: p.id, months, amount: planTotal(plat, p, months), status: 'pending', t: Date.now(), due: Date.now() + plat.settings.reqDays * 864e5, slip: null });
    await M.putDoc('plat', plat); return { plat, id };
  });
  if (!out) throw new HttpError(400, 'plan');
  send(ctx.res, 200, { ok: true, id: out.id, plat: await platView(u, out.plat) });
});
route('POST', '/api/billing/slip', async ctx => {
  const u = need(ctx); if (u.role !== 'owner') throw new HttpError(403, 'owner only');
  const img = await B.put(String(ctx.body.img || '')); if (!img) throw new HttpError(400, 'image');
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), r = pl.doc.requests.find(x => x.id === ctx.body.id && x.uid === u.id && x.status === 'pending');
    if (!r) return null; r.slip = { img, name: clip(ctx.body.name, 80), t: Date.now() }; r.slipRejected = false; await M.putDoc('plat', pl.doc); return pl.doc;
  });
  if (!out) throw new HttpError(404, 'request');
  Bill().slipUploaded(u, out.requests.find(x => x.id === ctx.body.id)).catch(e => console.error('[notify]', e.message));
  send(ctx.res, 200, { ok: true, plat: await platView(u, out) });
});

/* ---------- super admin: create / edit accounts (needs password handling) ---------- */
route('POST', '/api/admin/user', async ctx => {
  const a = need(ctx); if (a.role !== 'super') throw new HttpError(403, 'admin only');
  const b = ctx.body, email = clip(b.email, 150).trim().toLowerCase(), name = clip(b.name, 80).trim(), pass = String(b.pass || '');
  if (!name || !EMAIL.test(email)) return send(ctx.res, 400, { error: 'err.email' });
  const { doc: plat } = await M.getPlat(); if (!M.planOf(plat, b.planId)) return send(ctx.res, 400, { error: 'err.planName' });
  const status = ['active', 'suspended', 'pending'].includes(b.status) ? b.status : 'active';
  const fields = { name, biz: clip(b.biz, 100).trim(), phone: clip(b.phone, 30).trim(), status, planId: b.planId, exp: b.planId === 'free' ? '' : clip(b.exp, 10), note: clip(b.note, 300) };
  const dup = await M.userByEmail(email);
  if (b.id) {
    const row = await M.userById(b.id); if (!row || row.role === 'super') throw new HttpError(404, 'not found');
    if (dup && dup.id !== row.id) return send(ctx.res, 400, { error: 'au.exists' });
    const data = Object.assign(M.dataOf(M.rowToUser(row)), fields); await M.saveUserData(row.id, data, email !== row.email ? email : null);
    if (pass) { if (pass.length < 6) return send(ctx.res, 400, { error: 'err.pass' }); await q('UPDATE users SET pass_hash = ? WHERE id = ?', [await U.hashPassword(pass), row.id]); }
    if (status !== 'active') await S.destroyAllFor(row.id);
  } else {
    if (dup) return send(ctx.res, 400, { error: 'au.exists' });
    if (pass.length < 6) return send(ctx.res, 400, { error: 'err.pass' });
    await M.insertUser(Object.assign({ role: 'owner', joined: Date.now(), last: 0, ref: await newRef(), refBy: '' }, fields, { email }), await U.hashPassword(pass));
  }
  send(ctx.res, 200, { ok: true, plat: await platView(a, plat) });
});

/* ---------- affiliate payout request (owner) ---------- */
route('POST', '/api/affiliate/payout', async ctx => {
  const u = need(ctx); if (u.role !== 'owner') throw new HttpError(403, 'owner only');
  const bank = clip(ctx.body.bank, 160).trim(); if (!bank) return send(ctx.res, 400, { error: 'af.bankErr' });
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), plat = pl.doc, a = plat.settings.aff;
    const earned = plat.commissions.filter(c => c.uid === u.id).reduce((s, c) => s + c.amount, 0), taken = plat.payouts.filter(w => w.uid === u.id && w.status !== 'rejected').reduce((s, w) => s + w.amount, 0), bal = earned - taken;
    if (!a.on || bal <= 0 || bal < a.min) return { error: 'af.minErr', a: { m: a.min } };
    plat.payouts.unshift({ id: 'WD-' + (plat.seq.wd++), uid: u.id, amount: bal, bank, status: 'pending', t: Date.now() });
    await M.putDoc('plat', plat); return { plat, wd: plat.payouts[0] };
  });
  if (out.error) return send(ctx.res, 400, out);
  Bill().payoutRequested(u, out.wd).catch(e => console.error('[notify]', e.message));
  send(ctx.res, 200, { ok: true, plat: await platView(u, out.plat) });
});

/* ---------- landing page contact form ---------- */
route('POST', '/api/contact', async ctx => {
  if (!U.rateLimit('ct:' + U.ip(ctx.req), 5, 3600e3)) throw new HttpError(429, 'slow down');
  const b = ctx.body, text = clip(b.text, 1000).trim(), contact = clip(b.contact, 100).trim(); if (!text || !contact) throw new HttpError(400, 'err.msg');
  await U.withLock('plat', async () => { const pl = await M.getPlat(); pl.doc.messages.unshift({ id: 'MSG-' + (pl.doc.seq.msg++), name: clip(b.name, 80), contact, text, t: Date.now(), done: false }); if (pl.doc.messages.length > 500) pl.doc.messages.length = 500; await M.putDoc('plat', pl.doc); });
  send(ctx.res, 200, { ok: true });
});
module.exports = { ensureRef, platView, expireRequests, userView, acctId, PERMS };
