'use strict';
const { q } = require('../lib/db');
const U = require('../lib/util');
const M = require('../lib/model');
const B = require('../lib/blobs');
const { route, send } = require('../lib/http');
const { HttpError } = U;

async function shopCtx(slug) {
  const r = await q('SELECT owner_id, store_id FROM shops WHERE slug = ?', [String(slug || '').toLowerCase()]);
  if (!r[0]) throw new HttpError(404, 'shop');
  const row = await M.userById(r[0].owner_id); if (!row) throw new HttpError(404, 'shop');
  const owner = M.rowToUser(row); if (owner.status !== 'active') throw new HttpError(404, 'shop');
  const { doc: plat } = await M.getPlat(), pl = M.effPlan(owner, plat);
  return { ownerId: owner.id, storeId: r[0].store_id, owner, plat, feat: { coupons: !!pl.coupons, members: !!pl.members } };
}
const memberView = m => ({ id: m.id, name: m.name, phone: m.phone, points: m.points, spent: m.spent, joined: m.joined, via: m.via });
const same = (a, b) => M.digits(a) && M.digits(a) === M.digits(b);

route('GET', '/api/public/shop/:slug', async ctx => {
  const c = await shopCtx(ctx.params.slug), w = await M.getOwnerDoc(c.ownerId), st = w.doc.stores.find(s => s.id === c.storeId);
  if (!st) throw new HttpError(404, 'shop');
  send(ctx.res, 200, { d: M.publicDoc(w.doc, st, c.feat), shop: st.id, feat: c.feat, slug: ctx.params.slug, ownerName: c.owner.biz || c.owner.name });
});

route('POST', '/api/public/member', async ctx => {
  const b = ctx.body, ip = U.ip(ctx.req);
  if (!U.rateLimit('mb:' + ip, 30, 600e3)) throw new HttpError(429, 'slow down');
  const c = await shopCtx(b.shop); if (!c.feat.members) throw new HttpError(403, 'members off');
  const ph = M.digits(b.phone); if (ph.length < 9 || ph.length > 15) return send(ctx.res, 400, { error: 'err.phone' });
  const out = await U.withLock('d:' + c.ownerId, async () => {
    const w = await M.getOwnerDoc(c.ownerId), d = w.doc, ex = d.members.find(m => m.phone === ph);
    if (b.mode === 'signup') {
      const name = M.clip(b.name, 80).trim(); if (!name) return { code: 400, body: { error: 'err.name' } };
      if (ex) return { code: 400, body: { error: 'err.exists' } };
      const m = { id: 'm' + (d.seq.member++), name, phone: ph, points: 0, spent: 0, joined: Date.now(), via: c.storeId }; d.members.push(m);
      await M.putDoc('d:' + c.ownerId, d); return { code: 200, body: { member: memberView(m), created: true } };
    }
    if (!ex) return { code: 404, body: { error: 'err.notfound' } };
    return { code: 200, body: { member: memberView(ex) } };
  });
  send(ctx.res, out.code, out.body);
});

route('POST', '/api/public/order', async ctx => {
  const b = ctx.body, ip = U.ip(ctx.req);
  if (!U.rateLimit('od:' + ip, 20, 3600e3)) throw new HttpError(429, 'slow down');
  const c = await shopCtx(b.shop);
  const out = await U.withLock('d:' + c.ownerId, async () => {
    const w = await M.getOwnerDoc(c.ownerId), d = w.doc; M.expireOrders(d);
    const r = M.placeOrder(d, c.feat, { shop: c.storeId, lines: b.lines, cust: b.cust, code: b.code, memberId: b.memberId, memberPhone: b.memberPhone, taxInv: b.taxInv });
    if (r.err) { return { code: 400, body: { error: r.err, a: r.a } }; }
    await M.putDoc('d:' + c.ownerId, d);
    const st = d.stores.find(s => s.id === c.storeId), stock = {}; r.order.items.forEach(i => { stock[i.sku] = M.stockOf(d, st.wh, i.sku); });
    return { code: 200, body: { order: M.customerOrder(r.order), points: r.points, stock, wh: st.wh } };
  });
  send(ctx.res, out.code, out.body);
});

route('POST', '/api/public/slip', async ctx => {
  const b = ctx.body, ip = U.ip(ctx.req);
  if (!U.rateLimit('sl:' + ip, 30, 3600e3)) throw new HttpError(429, 'slow down');
  const c = await shopCtx(b.shop), img = await B.put(String(b.img || '')); if (!img) throw new HttpError(400, 'image');
  const out = await U.withLock('d:' + c.ownerId, async () => {
    const w = await M.getOwnerDoc(c.ownerId), o = w.doc.orders.find(x => x.id === b.id);
    if (!o || !same(o.cust.phone, b.phone)) return { code: 404, body: { error: 'order' } };
    if (o.status !== 'unpaid') return { code: 400, body: { error: 'status' } };
    o.slip = { img, name: M.clip(b.name, 80), t: Date.now() }; o.slipRejected = false;
    await M.putDoc('d:' + c.ownerId, w.doc); return { code: 200, body: { order: M.customerOrder(o) } };
  });
  send(ctx.res, out.code, out.body);
});

route('POST', '/api/public/track', async ctx => {
  const b = ctx.body, ip = U.ip(ctx.req);
  if (!U.rateLimit('tr:' + ip, 120, 600e3)) throw new HttpError(429, 'slow down');
  const c = await shopCtx(b.shop), w = await M.getOwnerDoc(c.ownerId), list = (Array.isArray(b.orders) ? b.orders : []).slice(0, 30);
  const orders = []; list.forEach(x => { const o = w.doc.orders.find(y => y.id === x.id && same(y.cust.phone, x.phone)); if (o) orders.push(M.customerOrder(o)); });
  let member = null; if (b.memberId && c.feat.members) { const m = w.doc.members.find(x => x.id === b.memberId && same(x.phone, b.memberPhone)); if (m) member = memberView(m); }
  send(ctx.res, 200, { orders, member });
});

route('GET', '/b/:id', async ctx => {
  const id = ctx.params.id; if (!/^[a-f0-9]{40}$/.test(id)) throw new HttpError(404, 'nf');
  const b = await B.get(id); if (!b) throw new HttpError(404, 'nf');
  ctx.res.writeHead(200, { 'Content-Type': b.mime, 'Content-Length': b.data.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  ctx.res.end(b.data);
});
module.exports = {};
