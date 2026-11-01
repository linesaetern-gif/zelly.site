'use strict';
/* Server-side model: documents, users, plan rules and the order logic (mirror of the client rules). */
const { q } = require('./db');
const U = require('./util');
const DEFAULT_PLAT = require('./plat-defaults.json');
const lt = (lo, th, en) => ({ lo, th, en });

/* ---------- documents ---------- */
async function getDoc(id, init) {
  const r = await q('SELECT rev, json FROM docs WHERE id = ?', [id]);
  if (r[0]) return { rev: Number(r[0].rev), doc: JSON.parse(r[0].json) };
  const doc = init ? init() : null; if (!doc) return null;
  await q('INSERT INTO docs (id, rev, json) VALUES (?, ?, ?)', [id, 1, JSON.stringify(doc)]);
  return { rev: 1, doc };
}
async function putDoc(id, doc) {
  const r = await q('SELECT rev FROM docs WHERE id = ?', [id]); const rev = r[0] ? Number(r[0].rev) + 1 : 1;
  if (r[0]) await q('UPDATE docs SET rev = ?, json = ? WHERE id = ?', [rev, JSON.stringify(doc), id]);
  else await q('INSERT INTO docs (id, rev, json) VALUES (?, ?, ?)', [id, rev, JSON.stringify(doc)]);
  return rev;
}
const emptyData = () => ({ carriers: [], threads: [], codTpl: '', loyalty: null, packPhoto: false, warehouses: [{ id: 'w1', name: lt('ຄັງຫຼັກ', 'คลังหลัก', 'Main warehouse') }], stores: [], products: [], stock: { w1: {} }, log: [], orders: [], seq: { order: 1001, prod: 1, store: 1, wh: 2, coupon: 1, promo: 1, member: 1, aff: 1, carrier: 0 }, affs: [], coupons: [], promos: [], members: [] });
const getPlat = async () => {
  const w = await getDoc('plat', () => U.clone(DEFAULT_PLAT));
  for (const k of ['commissions', 'payouts']) if (!Array.isArray(w.doc[k])) w.doc[k] = [];
  w.doc.seq = Object.assign({ comm: 1001, wd: 1001 }, w.doc.seq);
  if (!w.doc.settings.aff) w.doc.settings.aff = { on: false, pct: 10, min: 50000 };
  return w;
};
const getOwnerDoc = ownerId => getDoc('d:' + ownerId, emptyData);

/* ---------- users ---------- */
const PRIVATE_FIELDS = ['pass'];
function rowToUser(r) { const d = JSON.parse(r.data); return Object.assign({}, d, { id: r.id, role: r.role, ownerId: r.owner_id || undefined, email: r.email }); }
async function userById(id) { const r = await q('SELECT * FROM users WHERE id = ?', [id]); return r[0] || null; }
async function userByEmail(email) { const r = await q('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]); return r[0] || null; }
async function allUsers() { return q('SELECT * FROM users ORDER BY created ASC'); }
async function staffOf(ownerId) { return q('SELECT * FROM users WHERE owner_id = ? ORDER BY created ASC', [ownerId]); }
function dataOf(u) { const d = Object.assign({}, u); for (const k of ['id', 'role', 'ownerId', 'email', 'pass', 'usage']) delete d[k]; return d; }
async function insertUser(u, passHash) {
  const id = u.id || 'u' + U.rid(5);
  await q('INSERT INTO users (id, email, role, owner_id, pass_hash, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, String(u.email).trim().toLowerCase(), u.role, u.ownerId || null, passHash, JSON.stringify(dataOf(u)), Date.now()]);
  return id;
}
async function saveUserData(id, data, email) {
  if (email) await q('UPDATE users SET data = ?, email = ? WHERE id = ?', [JSON.stringify(data), String(email).trim().toLowerCase(), id]);
  else await q('UPDATE users SET data = ? WHERE id = ?', [JSON.stringify(data), id]);
}

/* ---------- plan rules (same as the browser) ---------- */
const planOf = (plat, id) => plat.plans.find(p => p.id === id);
function subState(u, plat) {
  if (u.role !== 'owner') return 'free';
  if (u.planId === 'free' || !u.exp) return 'free';
  const left = U.day(u.exp) - U.day(U.todayStr());
  if (left >= 0) return left <= 7 ? 'expiring' : 'active';
  return (-left <= plat.settings.graceDays) ? 'grace' : 'expired';
}
function effPlan(u, plat) {
  const st = subState(u, plat), p = planOf(plat, u.planId) || planOf(plat, 'free');
  return (st === 'expired' && plat.settings.autoDowngrade) ? planOf(plat, 'free') : p;
}
const isLocked = (owner, plat) => !!owner && owner.role === 'owner' && !!plat.settings.lockOnExpire && subState(owner, plat) === 'expired';
const usageOf = d => ({ shops: d.stores.length, products: d.products.length, whs: d.warehouses.length });

/* ---------- shops index (slug -> owner) ---------- */
const cleanSlug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
/* ensures slugs are unique platform-wide; returns true if the document had to be changed */
const reindexShops = (ownerId, d) => U.withLock('shops-index', () => reindexShopsRaw(ownerId, d));
async function reindexShopsRaw(ownerId, d) {
  let changed = false; const seen = new Set();
  for (const s of d.stores) {
    let slug = cleanSlug(s.slug) || cleanSlug(s.name) || 'shop-' + U.rid(2);
    for (let tries = 0; tries < 6; tries++) {
      const hit = await q('SELECT owner_id, store_id FROM shops WHERE slug = ?', [slug]);
      const taken = seen.has(slug) || (hit[0] && (hit[0].owner_id !== ownerId || hit[0].store_id !== s.id));
      if (!taken) break; slug = cleanSlug(slug + '-' + U.rid(2));
    }
    if (slug !== s.slug) { s.slug = slug; changed = true; }
    seen.add(slug);
  }
  await q('DELETE FROM shops WHERE owner_id = ?', [ownerId]);
  for (const s of d.stores) await q('INSERT INTO shops (slug, owner_id, store_id) VALUES (?, ?, ?)', [s.slug, ownerId, s.id]);
  return changed;
}

/* ---------- order rules ---------- */
const MIN = 60000;
const defaultPay = () => ({ transfer: { on: false, bank: '', accName: '', accNo: '', qr: '', note: '' }, cod: { on: true }, chat: { on: false, contact: '' }, holdMin: 60 });
function payOf(st) { const d = defaultPay(), p = st && st.pay ? st.pay : {}; return { transfer: Object.assign(d.transfer, p.transfer), cod: Object.assign(d.cod, p.cod), chat: Object.assign(d.chat, p.chat), holdMin: p.holdMin || d.holdMin }; }
const vatOf = st => Object.assign({ on: false, rate: 7, mode: 'excl', taxId: '', company: '' }, (st && st.vat) || {});
const DEF_LOY = () => ({ per: 10000, tiers: [{ id: 't1', n: 'Silver', min: 0 }, { id: 't2', n: 'Gold', min: 500 }, { id: 't3', n: 'Platinum', min: 1500 }] });
const pointUnit = d => Math.max(1, Math.floor(+((d.loyalty || DEF_LOY()).per)) || 10000);
const findVar = (d, sku) => { for (const p of d.products) { const v = (p.variants || []).find(x => x.sku === sku); if (v) return { p, v }; } return null; };
const stockOf = (d, wh, sku) => (d.stock[wh] && d.stock[wh][sku]) || 0;
const varCost = (p, v) => (v && v.cost != null && v.cost !== '') ? +v.cost || 0 : (+p.cost || 0);
function adjust(d, wh, sku, delta, reason, ref) {
  d.stock[wh] = d.stock[wh] || {};
  const before = stockOf(d, wh, sku), after = Math.max(0, before + delta); d.stock[wh][sku] = after;
  if (after !== before) { d.log.unshift({ t: Date.now(), sku, wh, delta: after - before, reason, ref: ref || '' }); if (d.log.length > 3000) d.log.length = 3000; }
}
function checkCoupon(d, code, sid, subtotal, member) {
  const c = d.coupons.find(x => x.code === String(code || '').trim().toUpperCase());
  if (!c || !c.active) return { err: 'e.nocode' };
  if (c.store !== 'all' && c.store !== sid) return { err: 'e.store' };
  if (c.end && c.end < U.todayStr()) return { err: 'e.expired' };
  if (c.limit && c.used >= c.limit) return { err: 'e.limit' };
  if (c.member && !member) return { err: 'e.member' };
  if (subtotal < c.min) return { err: 'e.min', a: { m: c.min } };
  return { c };
}
function calc(d, feat, sid, lines, code, member, carrierId) {
  const st = d.stores.find(s => s.id === sid), car = carrierId ? d.carriers.find(c => c.id === carrierId && c.active !== false && (c.store === 'all' || c.store === sid)) : null;
  let subtotal = 0, items = 0;
  const rows = lines.map(l => { const f = findVar(d, l.sku), line = f.p.price * l.qty; subtotal += line; items += l.qty; return { sku: l.sku, qty: l.qty, price: f.p.price, cost: varCost(f.p, f.v), line, pid: f.p.id }; });
  let ship = (!subtotal || subtotal >= (st.freeShipMin || 0)) ? 0 : (car && car.fee > 0 ? car.fee : (st.shipFee || 0)), discount = 0, err = '', ea, coupon = null;
  if (code && feat.coupons) {
    const r = checkCoupon(d, code, sid, subtotal, member);
    if (r.err) { err = r.err; ea = r.a; }
    else { coupon = r.c; if (coupon.type === 'percent') discount = Math.floor(subtotal * coupon.value / 100); else if (coupon.type === 'amount') discount = Math.min(coupon.value, subtotal); else ship = 0; }
  }
  const base = Math.max(0, subtotal - discount), vs = vatOf(st); let vat = 0;
  if (vs.on) vat = vs.mode === 'excl' ? Math.round(base * vs.rate / 100) : Math.round(base - base / (1 + vs.rate / 100));
  const total = base + ship + (vs.on && vs.mode === 'excl' ? vat : 0);
  return { rows, items, subtotal, discount, ship, total, vat, vatMode: vs.on ? vs.mode : '', vatRate: vs.on ? vs.rate : 0, carrier: car ? { id: car.id, name: car.name } : null, coupon, err, ea, points: Math.floor(total / pointUnit(d)) };
}
const digits = s => String(s || '').replace(/\D/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
/* Places an order into owner document d. Returns {order, points} or {err, a} */
function placeOrder(d, feat, req) {
  const st = d.stores.find(s => s.id === req.shop); if (!st) return { err: 'e.nostore' };
  const lines = (Array.isArray(req.lines) ? req.lines : []).map(l => ({ sku: String(l.sku || ''), qty: Math.floor(+l.qty) || 0 })).filter(l => l.qty > 0 && l.qty <= 999);
  if (!lines.length) return { err: 'e.empty' };
  const merged = {}; lines.forEach(l => { merged[l.sku] = (merged[l.sku] || 0) + l.qty; });
  const lines2 = Object.keys(merged).map(sku => ({ sku, qty: merged[sku] }));
  for (const l of lines2) {
    const f = findVar(d, l.sku); if (!f || f.p.active === false || !(f.p.stores || []).includes(st.id)) return { err: 'e.nostore' };
    if (stockOf(d, st.wh, l.sku) < l.qty) return { err: 'e.short', a: { sku: l.sku } };
  }
  const c = req.cust || {};
  if (!clip(c.name, 80).trim() || !clip(c.address, 400).trim()) return { err: 'err.addr' };
  if (digits(c.phone).length < 9) return { err: 'err.phone' };
  const pm = payOf(st), methods = ['transfer', 'cod', 'chat'].filter(k => pm[k].on);
  if (!methods.includes(c.pay)) return { err: 'pay.none' };
  const cars = d.carriers.filter(x => x.active !== false && (x.store === 'all' || x.store === st.id));
  if (cars.length && !cars.some(x => x.id === c.carrier)) return { err: 'car.pick' };
  let member = null;
  if (req.memberId) { member = d.members.find(m => m.id === req.memberId && m.phone === digits(req.memberPhone)); if (!member || !feat.members) member = null; }
  const qd = calc(d, feat, st.id, lines2, req.code, member, c.carrier);
  if (qd.err) return { err: qd.err, a: qd.ea };
  const id = 'SK-' + (d.seq.order++), unpaid = c.pay !== 'cod';
  lines2.forEach(l => adjust(d, st.wh, l.sku, -l.qty, 'r.sold', id));
  if (qd.coupon) qd.coupon.used++;
  const cust = { name: clip(c.name, 80).trim(), phone: clip(c.phone, 30).trim(), address: clip(c.address, 400).trim(), pay: c.pay };
  const o = { id, store: st.id, cust, items: qd.rows.map(r => ({ sku: r.sku, price: r.price, cost: r.cost, qty: r.qty })), subtotal: qd.subtotal, discount: qd.discount, ship: qd.ship, total: qd.total, vat: qd.vat, vatMode: qd.vatMode, vatRate: qd.vatRate, carrier: qd.carrier, coupon: qd.coupon ? qd.coupon.code : '', status: unpaid ? 'unpaid' : 'new', pay: c.pay, paid: false, slip: null, payDue: unpaid ? Date.now() + payOf(st).holdMin * MIN : 0, t: Date.now(), member: member ? member.id : '', tracking: '' };
  if (req.taxInv && vatOf(st).on && req.taxInv.name && req.taxInv.taxId) o.taxInv = { name: clip(req.taxInv.name, 80), taxId: clip(req.taxInv.taxId, 30) };
  const code = clip(c.aff, 20).trim().toUpperCase();
  if (code) { const ag = d.affs.find(a => a.code === code); if (!ag || !ag.active || !(ag.store === 'all' || ag.store === st.id)) return { err: 'af.codeBad' }; o.aff = ag.code; o.affPct = ag.pct; o.affAmt = Math.round(Math.max(0, o.subtotal - o.discount) * ag.pct / 100); }
  d.orders.unshift(o);
  return { order: o, points: member ? qd.points : 0 };
}
function cancelOrder(d, id, reason) {
  const o = d.orders.find(x => x.id === id); if (!o || o.status === 'shipped' || o.status === 'cancelled') return false;
  const st = d.stores.find(s => s.id === o.store);
  if (st) o.items.forEach(i => adjust(d, st.wh, i.sku, i.qty, 'r.cancel', id));
  const c = o.coupon && d.coupons.find(x => x.code === o.coupon); if (c && c.used > 0) c.used--;
  o.status = 'cancelled'; if (reason) o.cancelReason = reason; return true;
}
function expireOrders(d) {
  const now = Date.now(); let n = 0;
  d.orders.forEach(o => { if (o.status === 'unpaid' && !o.slip && o.payDue && o.payDue <= now) { if (cancelOrder(d, o.id, 'expired')) n++; } });
  return n;
}
/* what a customer may see of an order */
function customerOrder(o) {
  const out = { id: o.id, store: o.store, cust: { name: o.cust.name, phone: o.cust.phone, address: o.cust.address, pay: o.cust.pay }, items: o.items.map(i => ({ sku: i.sku, price: i.price, qty: i.qty })), subtotal: o.subtotal, discount: o.discount, ship: o.ship, total: o.total, vat: o.vat, vatMode: o.vatMode, vatRate: o.vatRate, carrier: o.carrier, coupon: o.coupon, status: o.status, pay: o.pay, paid: o.paid, slip: o.slip ? { img: o.slip.img, t: o.slip.t } : null, slipRejected: !!o.slipRejected, payDue: o.payDue, t: o.t, member: o.member, tracking: o.tracking || '', packPhotos: o.packPhotos || [], cancelReason: o.cancelReason || '' };
  if (o.taxInv) out.taxInv = o.taxInv; return out;
}
/* sanitised document for the customer storefront of one store */
function publicDoc(d, st, feat) {
  const prods = d.products.filter(p => p.active !== false && (p.stores || []).includes(st.id)).map(p => { const c = JSON.parse(JSON.stringify(p)); delete c.cost; (c.variants || []).forEach(v => { delete v.cost; }); return c; });
  const stock = {}; stock[st.wh] = {}; prods.forEach(p => (p.variants || []).forEach(v => { stock[st.wh][v.sku] = stockOf(d, st.wh, v.sku); }));
  const pub = emptyData();
  Object.assign(pub, {
    stores: [JSON.parse(JSON.stringify(st))], products: prods, stock,
    warehouses: d.warehouses.filter(w => w.id === st.wh), loyalty: d.loyalty || DEF_LOY(), seq: { order: 0, prod: 0, store: 0, wh: 0, coupon: 0, promo: 0, member: 0, aff: 0 },
    carriers: d.carriers.filter(c => c.active !== false && (c.store === 'all' || c.store === st.id)).map(c => JSON.parse(JSON.stringify(c))),
    coupons: feat.coupons ? d.coupons.filter(c => c.active && (c.store === 'all' || c.store === st.id)).map(c => ({ code: c.code, type: c.type, value: c.value, min: c.min, store: c.store, member: c.member, limit: c.limit, used: c.used, end: c.end, active: true, img: c.img || '', sticker: c.sticker || '' })) : [],
    affs: d.affs.filter(a => a.active && (a.store === 'all' || a.store === st.id)).map(a => ({ id: a.id, code: a.code, store: a.store, active: true, pct: 0, name: '', phone: '', paid: 0, log: [] })),
    promos: d.promos.filter(p => p.active && (p.store === 'all' || p.store === st.id)).map(p => JSON.parse(JSON.stringify(p)))
  });
  return pub;
}
module.exports = { lt, getDoc, putDoc, emptyData, getPlat, getOwnerDoc, rowToUser, userById, userByEmail, allUsers, staffOf, dataOf, insertUser, saveUserData, planOf, subState, effPlan, isLocked, usageOf, cleanSlug, reindexShops, placeOrder, cancelOrder, expireOrders, customerOrder, publicDoc, payOf, digits, clip, findVar, stockOf, adjust, DEFAULT_PLAT, PRIVATE_FIELDS };
