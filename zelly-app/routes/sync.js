'use strict';
const U = require('../lib/util');
const M = require('../lib/model');
const B = require('../lib/blobs');
const S = require('../lib/session');
const Diff = require('../lib/diff');
const { route, send } = require('../lib/http');
const { platView, acctId, expireRequests } = require('./account');
const { HttpError } = U;

/* which top-level keys of the shop document each staff permission may change */
const PERM_KEYS = {
  overview: [], reports: [], settings: [], chat: ['threads'], orders: ['orders', 'log', 'stock', 'members'], cod: ['orders', 'codTpl'], payments: ['orders'],
  stock: ['stock', 'log', 'warehouses', 'seq'], stores: ['stores', 'products', 'warehouses', 'stock', 'log', 'seq'], promo: ['coupons', 'promos', 'seq'],
  members: ['members', 'loyalty', 'seq'], shipping: ['carriers', 'seq'], vat: ['stores'], pack: ['orders', 'packPhoto'], shop: ['stores']
};
const SHAPE = { arrays: ['carriers', 'threads', 'warehouses', 'stores', 'products', 'log', 'orders', 'affs', 'coupons', 'promos', 'members'], objects: ['stock', 'seq'] };
function normalize(d) {
  const e = M.emptyData();
  SHAPE.arrays.forEach(k => { if (!Array.isArray(d[k])) d[k] = e[k]; });
  SHAPE.objects.forEach(k => { if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = e[k]; });
  if (!d.warehouses.length) d.warehouses = e.warehouses;
  d.warehouses.forEach(w => { if (!d.stock[w.id]) d.stock[w.id] = {}; });
  Object.keys(e.seq).forEach(k => { if (typeof d.seq[k] !== 'number') d.seq[k] = e.seq[k]; });
  if (d.log.length > 3000) d.log.length = 3000;
}
const validOps = ops => Array.isArray(ops) && ops.length <= 6000 && ops.every(o => o && typeof o === 'object' && Array.isArray(o.p) && ['set', 'del', 'add', 'rm'].includes(o.o));

route('POST', '/api/sync', async ctx => {
  const u = ctx.user; if (!u) throw new HttpError(401, 'auth');
  const b = ctx.body, ops = b.ops || [];
  if (!validOps(ops)) throw new HttpError(400, 'bad ops');
  if (b.doc === 'plat') return syncPlat(ctx, u, ops);
  return syncShop(ctx, u, ops, Number(b.rev));
}, { limit: 24 * 1024 * 1024 });

async function syncShop(ctx, u, ops, clientRev) {
  if (u.role === 'super') throw new HttpError(403, 'no shop');
  const oid = acctId(u);
  const out = await U.withLock('d:' + oid, async () => {
    const { doc: plat } = await M.getPlat(), ownerRow = await M.userById(oid), owner = M.rowToUser(ownerRow);
    const w = await M.getOwnerDoc(oid); let d = w.doc, forceDoc = false, dirty = false;
    if (M.expireOrders(d)) { dirty = true; forceDoc = true; }
    let accepted = ops;
    if (u.role === 'staff') {
      const allowed = new Set(); (u.perms || []).forEach(p => (PERM_KEYS[p] || []).forEach(k => allowed.add(k)));
      accepted = ops.filter(op => allowed.has(op.p[0]));
      if (accepted.length !== ops.length) forceDoc = true;
    }
    if (accepted.length) {
      if (M.isLocked(owner, plat)) return { code: 423, body: { error: 'locked', rev: w.rev, doc: d } };
      const before = M.usageOf(d), snap = U.clone(d);
      for (const op of accepted) if ('v' in op) { const s = JSON.stringify(op.v); if (s && s.includes('data:')) { op.v = await B.externalize(op.v); forceDoc = true; } }
      Diff.apply(d, accepted); normalize(d);
      const after = M.usageOf(d), pl = M.effPlan(owner, plat);
      for (const [k, key] of [['shops', 'shops'], ['products', 'products'], ['whs', 'whs']]) {
        if (after[k] > before[k] && after[k] > pl[key]) return { code: 409, body: { error: 'limit', kind: { shops: 'shop', products: 'product', whs: 'wh' }[k], n: pl[key], plan: pl.name, rev: w.rev, doc: snap } };
      }
      if (await M.reindexShops(oid, d)) forceDoc = true;
      dirty = true;
    }
    const mismatch = clientRev !== w.rev; let rev = w.rev;
    if (dirty) rev = await M.putDoc('d:' + oid, d);
    return { code: 200, body: (mismatch || forceDoc) ? { rev, doc: d } : { rev } };
  });
  send(ctx.res, out.code, out.body);
}

const PLAT_KEYS = ['settings', 'plans', 'requests', 'payments', 'messages', 'seq', 'commissions', 'payouts'];
const USER_FIELDS = new Set(['ref', 'refBy', 'name', 'biz', 'phone', 'status', 'planId', 'exp', 'note', 'addr', 'img', 'refBy', 'last', 'joined']);
async function syncPlat(ctx, u, ops) {
  if (u.role !== 'super') throw new HttpError(403, 'admin only');
  const out = await U.withLock('plat', async () => {
    const w = await M.getPlat(), plat = w.doc; let replaced = false;
    const rest = [], byUser = {};
    for (const op of ops) {
      if (op.p[0] === 'users') { if (op.p[1] && op.p[1][0] === '#' && op.p.length >= 3 && USER_FIELDS.has(op.p[2]) && (op.o === 'set' || op.o === 'del')) (byUser[op.p[1].slice(1)] = byUser[op.p[1].slice(1)] || []).push(op); else replaced = true; continue; }
      if (PLAT_KEYS.includes(op.p[0])) rest.push(op); else replaced = true;
    }
    for (const op of rest) if ('v' in op) { const s = JSON.stringify(op.v); if (s && s.includes('data:')) { op.v = await B.externalize(op.v); replaced = true; } }
    let dirty = false;
    if (rest.length) { Diff.apply(plat, rest); expireRequests(plat); await M.putDoc('plat', plat); dirty = true; }
    for (const id of Object.keys(byUser)) {
      const row = await M.userById(id); if (!row || row.role === 'super') { replaced = true; continue; }
      const data = M.dataOf(M.rowToUser(row)), wrap = { x: data };
      byUser[id].forEach(op => { op.p = ['x'].concat(op.p.slice(2)); });
      for (const op of byUser[id]) if ('v' in op) op.v = await B.externalize(op.v);
      Diff.apply(wrap, byUser[id]); await M.saveUserData(id, wrap.x);
      if (wrap.x.status !== 'active') await S.destroyAllFor(id);
    }
    return { plat, replaced, dirty };
  });
  send(ctx.res, 200, out.replaced ? { ok: true, plat: await platView(u, out.plat) } : { ok: true });
}
module.exports = { PERM_KEYS, normalize };
