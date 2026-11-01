'use strict';
/* Online subscription payment (PhaJay / BCEL QR), webhook, receipts, e-mail hooks for billing and the expiry reminder job. */
const U = require('../lib/util');
const M = require('../lib/model');
const Pay = require('../lib/payments');
const N = require('../lib/notify');
const Mail = require('../lib/mailer');
const { route, send } = require('../lib/http');
const { platView } = require('./account');
const { HttpError } = U;

const pad = n => String(n).padStart(2, '0');
function addMonths(s, m) {
  const [y, mo, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, mo - 1 + m, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(Math.min(d, last));
}
const need = ctx => { if (!ctx.user) throw new HttpError(401, 'auth'); return ctx.user; };

/* Activates a subscription request that has been paid. Idempotent. Must run inside withLock('plat') with plat = the loaded doc.
   Returns null when nothing happened, else { pay, user, plan, exp, comm } (caller saves the doc and sends mail). */
async function activate(plat, r, method) {
  if (!r || r.status === 'paid') return null;
  const row = await M.userById(r.uid), plan = M.planOf(plat, r.planId); if (!row || !plan) return null;
  const u = M.rowToUser(row), today = U.todayStr(), same = u.planId === plan.id && u.exp && u.exp >= today;
  const data = M.dataOf(u); data.planId = plan.id; data.exp = plan.id === 'free' ? '' : addMonths(same ? u.exp : today, r.months);
  if (u.status === 'pending') data.status = 'active';
  await M.saveUserData(u.id, data);
  const pay = { id: 'PAY-' + (plat.seq.pay++), uid: u.id, planId: plan.id, months: r.months, amount: r.amount, method: method || '', note: r.id, t: Date.now() };
  plat.payments.unshift(pay); r.status = 'paid'; r.paidAt = Date.now();
  let comm = null; const a = plat.settings.aff;
  if (a && a.on && u.refBy && u.refBy !== u.id) {
    const rf = await M.userById(u.refBy), amt = Math.round(pay.amount * a.pct / 100);
    if (rf && amt > 0) { comm = { id: 'CM-' + (plat.seq.comm++), uid: u.refBy, from: u.id, pay: pay.id, base: pay.amount, pct: a.pct, amount: amt, t: Date.now() }; plat.commissions.unshift(comm); }
  }
  return { pay, user: Object.assign(u, data), plan, exp: data.exp, comm };
}
async function afterActivate(res) {
  if (!res) return;
  N.paid(res.user, res.pay, res.plan, res.exp);
  if (res.comm) { const rf = await M.userById(res.comm.uid); if (rf) N.commission(M.rowToUser(rf), res.user, res.comm.amount); }
}
const admins = async () => (await M.allUsers()).map(M.rowToUser).filter(u => u.role === 'super');
const myReq = (plat, ctx, u) => plat.requests.find(x => x.id === String(ctx.body.id || ctx.query.id || '') && x.uid === u.id);

/* ---- start an online payment for one of my requests ---- */
route('POST', '/api/billing/pay', async ctx => {
  const u = need(ctx); if (u.role !== 'owner') throw new HttpError(403, 'owner only');
  if (!Pay.online()) return send(ctx.res, 503, { error: 'pay.off' });
  if (!U.rateLimit('pay:' + u.id, 12, 600e3)) throw new HttpError(429, 'slow down');
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), plat = pl.doc, r = myReq(plat, ctx, u);
    if (!r) return { code: 404, body: { error: 'request' } };
    if (r.status === 'paid') return { code: 400, body: { error: 'pay.done' } };
    const fresh = r.pay && r.pay.txId && Date.now() - r.pay.at < 10 * 60e3 && !ctx.body.force;
    if (!fresh) {
      let q; try { q = await Pay.createQr({ amount: r.amount, order: r.id, description: 'Zelly ' + r.id }); } catch (e) { console.error('[pay] createQr', e.message); return { code: 502, body: { error: 'pay.fail', detail: String(e.message).slice(0, 160) } }; }
      r.pay = { provider: 'phajay', txId: q.txId, qr: q.qr, link: q.link, at: Date.now() };
      r.txIds = (r.txIds || []).concat(q.txId).slice(-10);
      if (r.status === 'expired' || r.status === 'rejected') r.status = 'pending';
      r.due = Math.max(r.due || 0, Date.now() + plat.settings.reqDays * 864e5);
      await M.putDoc('plat', plat);
    }
    return { code: 200, body: { ok: true, pay: { qr: r.pay.qr, link: r.pay.link, at: r.pay.at, amount: r.amount, id: r.id } } };
  });
  send(ctx.res, out.code, out.body);
});

/* ---- poll: ask the gateway and activate when paid ---- */
route('GET', '/api/billing/status', async ctx => {
  const u = need(ctx); if (u.role !== 'owner') throw new HttpError(403, 'owner only');
  if (!U.rateLimit('pst:' + u.id, 60, 60e3)) throw new HttpError(429, 'slow down');
  const id = String(ctx.query.id || '');
  const res = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), plat = pl.doc, r = plat.requests.find(x => x.id === id && x.uid === u.id);
    if (!r) return { code: 404 };
    if (r.status === 'paid') return { code: 200, paid: true, plat };
    if (!Pay.online() || !(r.txIds || []).length) return { code: 200, paid: false, plat };
    let act = null, st = '';
    for (const tx of (r.txIds || []).slice().reverse().slice(0, 3)) {
      let s; try { s = await Pay.status(tx); } catch (e) { st = 'error'; continue; }
      st = s.status || st;
      if (s.paid && s.amount >= r.amount) { act = await activate(plat, r, 'BCEL OnePay (PhaJay) ' + tx); break; }
    }
    if (act) await M.putDoc('plat', plat);
    return { code: 200, paid: !!act, act, status: st, plat };
  });
  if (res.code === 404) throw new HttpError(404, 'request');
  if (res.act) afterActivate(res.act).catch(e => console.error('[notify]', e.message));
  send(ctx.res, 200, { ok: true, paid: res.paid, status: res.status || '', plat: res.paid ? await platView(await M.userById(u.id).then(M.rowToUser), res.plat) : undefined });
});

/* ---- gateway webhook (public, authenticated by HMAC signature over the raw body) ---- */
route('POST', '/api/webhooks/phajay', async ctx => {
  if (!Pay.verifyWebhook(ctx.raw, ctx.req.headers['x-signature'])) return send(ctx.res, 401, { error: 'bad signature' });
  const b = ctx.body || {}, tx = String(b.transactionId || '');
  if (!tx) return send(ctx.res, 200, { ok: true, ignored: true });
  const out = await U.withLock('plat', async () => {
    const pl = await M.getPlat(), plat = pl.doc, r = plat.requests.find(x => (x.txIds || []).includes(tx));
    if (!r) return { found: false };
    if (r.status === 'paid') return { found: true, already: true };
    let paid = false, amount = Number(b.txnAmount) || 0;
    try { const s = await Pay.status(tx); paid = s.paid; amount = s.amount || amount; }
    catch (e) { paid = String(b.status) === 'PAYMENT_COMPLETED'; }   /* gateway unreachable: trust the signed payload */
    if (!paid || amount < r.amount) return { found: true, paid: false };
    const act = await activate(plat, r, 'BCEL OnePay (PhaJay) ' + tx); await M.putDoc('plat', plat);
    return { found: true, paid: true, act };
  });
  if (out.act) afterActivate(out.act).catch(e => console.error('[notify]', e.message));
  send(ctx.res, 200, { ok: true });
});

/* ---- mail: events on a slip upload (called from account.js) ---- */
async function slipUploaded(u, r) { if (!Mail.enabled()) return; const { doc: plat } = await M.getPlat(); N.slip(await admins(), u, r, M.planOf(plat, r.planId)); }
async function payoutRequested(u, w) { if (!Mail.enabled()) return; N.payoutRequested(await admins(), u, w); }

/* ---- mail: what changed when the super admin edited the platform document ---- */
const snap = plat => ({ req: Object.fromEntries(plat.requests.map(r => [r.id, { s: r.status, slip: !!r.slip, rj: !!r.slipRejected }])), wd: Object.fromEntries(plat.payouts.map(w => [w.id, w.status])) });
async function notifyPlatChanges(before, plat) {
  if (!Mail.enabled()) return;
  for (const r of plat.requests) {
    const b = before.req[r.id]; if (!b) continue;
    const row = await M.userById(r.uid); if (!row) continue; const u = M.rowToUser(row);
    if (b.s !== 'paid' && r.status === 'paid') N.approved(u, r, M.planOf(plat, r.planId), u.exp);
    else if (!b.rj && r.slipRejected && r.status === 'pending') N.rejected(u, r);
  }
  for (const w of plat.payouts) {
    const b = before.wd[w.id]; if (!b || b === w.status) continue;
    const row = await M.userById(w.uid); if (!row) continue; const u = M.rowToUser(row);
    if (w.status === 'paid') N.payoutPaid(u, w); else if (w.status === 'rejected') N.payoutRejected(u, w);
  }
}

/* ---- super admin: send a test email to myself ---- */
route('POST', '/api/admin/mailtest', async ctx => {
  const a = need(ctx); if (a.role !== 'super') throw new HttpError(403, 'admin only');
  if (!U.rateLimit('mt:' + a.id, 5, 600e3)) throw new HttpError(429, 'slow down');
  if (!Mail.enabled()) return send(ctx.res, 400, { error: 'mail.off' });
  const lang = ['lo', 'th', 'en'].includes(ctx.body.lang) ? ctx.body.lang : a.lang;
  const m = N.render('test', Object.assign({}, a, { lang }), {});
  try { await Mail.sendNow({ to: a.email, subject: m.subject, text: m.text, html: m.html }); } catch (e) { return send(ctx.res, 502, { error: 'mail.fail', detail: String(e.message).slice(0, 200) }); }
  send(ctx.res, 200, { ok: true, to: a.email });
});

/* ---- expiry reminders (7 / 3 / 1 days before, and once after) ---- */
async function remindTick() {
  if (!Mail.enabled()) return 0;
  let n = 0;
  try {
    const { doc: plat } = await M.getPlat(), today = U.day(U.todayStr());
    for (const row of await M.allUsers()) {
      const u = M.rowToUser(row); if (u.role !== 'owner' || u.status !== 'active' || !u.exp || u.planId === 'free') continue;
      const left = U.day(u.exp) - today; let stage = '';
      if (left >= 0 && left <= 7) stage = left <= 1 ? '1' : left <= 3 ? '3' : '7'; else if (left < 0 && left >= -3) stage = 'x';
      if (!stage) continue;
      const key = u.exp + ':' + stage; if (u.remind === key) continue;
      const data = M.dataOf(u); data.remind = key; await M.saveUserData(u.id, data);
      N.expiry(u, M.planOf(plat, u.planId), u.exp, stage === 'x' ? -1 : left); n++;
    }
  } catch (e) { console.error('[remind]', e.message); }
  return n;
}
module.exports = { activate, addMonths, snap, notifyPlatChanges, slipUploaded, payoutRequested, remindTick };
