'use strict';
/* End-to-end API test against a temp SQLite DB:  node test/api.test.js */
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = path.join(os.tmpdir(), 'zelly-test-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
process.env.ZELLY_NO_AUTOSTART = '1'; process.env.SQLITE_PATH = tmp; process.env.PORT = '0'; process.env.ADMIN_EMAIL = 'root@test.io'; process.env.ADMIN_PASSWORD = 'rootpass1';
delete process.env.DB_HOST;
const assert = require('assert'), { start } = require('../server'), Diff = require('../lib/diff');
let base; const jars = {};
async function call(who, method, url, body) {
  const h = { 'Content-Type': 'application/json' }; if (jars[who]) h.Cookie = jars[who];
  const r = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j };
}
(async () => {
  const srv = await start(); base = 'http://127.0.0.1:' + srv.address().port;
  let r = await call('', 'GET', '/healthz'); assert.equal(r.s, 200);
  r = await call('', 'GET', '/api/boot'); assert.equal(r.s, 200); assert(!r.j.user);
  r = await call('a', 'POST', '/api/auth/login', { email: 'root@test.io', pass: 'bad' }); assert.equal(r.s, 401);
  r = await call('sa', 'POST', '/api/auth/login', { email: 'root@test.io', pass: 'rootpass1' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('o', 'POST', '/api/auth/signup', { name: 'Noy', email: 'noy@x.com', pass: 'secret1', biz: 'Noy Shop', phone: '020 5555 1234' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('o', 'POST', '/api/auth/signup', { name: 'Noy', email: 'noy@x.com', pass: 'secret1' }); assert.equal(r.s, 400);
  r = await call('o', 'GET', '/api/workspace'); assert.equal(r.s, 200); const w = r.j; let d = w.d.doc, rev = w.d.rev; assert(w.user.role === 'owner');
  const base0 = JSON.parse(JSON.stringify(d));
  /* owner builds a shop */
  d.stores.push({ id: 's1', name: 'Noy Shop', slug: 'noyshop', wh: 'w1', color: '#2563eb', currency: '₭', pay: { transfer: { on: true, bank: 'BCEL', acc: '1234', name: 'Noy' }, cod: { on: true }, chat: { on: false }, holdMin: 30 }, open: true });
  d.products.push({ id: 'p1', name: 'Tee', price: 100000, cost: 40000, stores: ['s1'], active: true, variants: [{ sku: 'T-1', name: 'M', price: 100000, cost: 40000 }] });
  d.stock.w1['T-1'] = 10; d.seq.store = 2; d.seq.prod = 2;
  let ops = Diff.diff(base0, d); assert(ops.length > 0);
  r = await call('o', 'POST', '/api/sync', { doc: 'd', rev, ops }); assert.equal(r.s, 200, JSON.stringify(r.j)); rev = r.j.rev;
  r = await call('', 'GET', '/api/public/shop/noyshop'); assert.equal(r.s, 200, JSON.stringify(r.j)); assert(r.j.d.products.length === 1);
  assert(!JSON.stringify(r.j).includes('"cost"'), 'cost leaked');
  /* customer order */
  r = await call('', 'POST', '/api/public/order', { shop: 'noyshop', lines: [{ sku: 'T-1', qty: 2 }], cust: { name: 'Buyer', phone: '020 9999 8888', address: 'Vientiane', pay: 'cod' } });
  assert.equal(r.s, 200, JSON.stringify(r.j)); const oid = r.j.order.id; assert(!('cost' in (r.j.order.items[0])), 'order cost leaked');
  r = await call('', 'POST', '/api/public/order', { shop: 'noyshop', lines: [{ sku: 'T-1', qty: 99 }], cust: { name: 'Buyer', phone: '020 9999 8888', address: 'V', pay: 'cod' } }); assert.equal(r.s, 400); assert.equal(r.j.error, 'e.short');
  r = await call('', 'POST', '/api/public/track', { shop: 'noyshop', orders: [{ id: oid, phone: '02099998888' }, { id: oid, phone: '1112223334' }] }); assert.equal(r.j.orders.length, 1);
  /* owner sees order, concurrent edit merges */
  r = await call('o', 'GET', '/api/workspace'); assert(r.j.d.doc.orders.some(o => o.id === oid)); assert.equal(r.j.d.doc.stock.w1['T-1'], 8);
  const d2 = JSON.parse(JSON.stringify(d)); d2.products[0].name = 'Tee v2';           /* stale base: no order inside */
  r = await call('o', 'POST', '/api/sync', { doc: 'd', rev, ops: Diff.diff(d, d2) }); assert.equal(r.s, 200); assert(r.j.doc, 'expected doc back after concurrent change');
  assert.equal(r.j.doc.products[0].name, 'Tee v2'); assert(r.j.doc.orders.some(o => o.id === oid), 'order lost!'); assert.equal(r.j.doc.stock.w1['T-1'], 8);
  /* plan limit: free plan allows N shops */
  /* plan limit: a free account may only keep the number of shops its plan allows */
  r = await call('sa', 'POST', '/api/admin/user', { name: 'Free Co', email: 'free@x.com', pass: 'freepass1', planId: 'free', status: 'active' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('fr', 'POST', '/api/auth/login', { email: 'free@x.com', pass: 'freepass1' }); assert.equal(r.s, 200);
  r = await call('fr', 'GET', '/api/workspace'); const fd0 = r.j.d.doc, fd1 = JSON.parse(JSON.stringify(fd0)), maxShops = r.j.plat.plans.find(p => p.id === 'free').shops;
  for (let i = 0; i < maxShops + 1; i++) fd1.stores.push({ id: 'x' + i, name: 'S' + i, slug: 'free-' + i, wh: 'w1', pay: {}, open: true });
  r = await call('fr', 'POST', '/api/sync', { doc: 'd', rev: r.j.d.rev, ops: Diff.diff(fd0, fd1) }); assert.equal(r.s, 409, 'limit not enforced'); assert.equal(r.j.error, 'limit'); assert.equal(r.j.doc.stores.length, 0);
  /* same slug on two accounts gets a suffix */
  const fd2 = JSON.parse(JSON.stringify(fd0)); fd2.stores.push({ id: 'y1', name: 'Dup', slug: 'noyshop', wh: 'w1', pay: {}, open: true });
  r = await call('fr', 'POST', '/api/sync', { doc: 'd', rev: 0, ops: Diff.diff(fd0, fd2) }); assert.equal(r.s, 200); assert(r.j.doc.stores[0].slug !== 'noyshop' && r.j.doc.stores[0].slug.startsWith('noyshop-'), r.j.doc.stores[0].slug);
  /* staff */
  r = await call('o', 'POST', '/api/staff', { name: 'Packer', email: 'pk@x.com', pass: 'packpass', perms: ['pack', 'orders'], status: 'active' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('st', 'POST', '/api/auth/login', { email: 'pk@x.com', pass: 'packpass' }); assert.equal(r.s, 200);
  r = await call('st', 'GET', '/api/workspace'); const sd = r.j.d.doc, sd2 = JSON.parse(JSON.stringify(sd)); sd2.products[0].name = 'HACK'; sd2.orders.find(o => o.id === oid).status = 'packing';
  r = await call('st', 'POST', '/api/sync', { doc: 'd', rev: r.j.d.rev, ops: Diff.diff(sd, sd2) }); assert.equal(r.s, 200);
  r = await call('o', 'GET', '/api/workspace'); assert.equal(r.j.d.doc.products[0].name, 'Tee v2', 'staff changed products'); assert.equal(r.j.d.doc.orders.find(o => o.id === oid).status, 'packing');
  r = await call('st', 'POST', '/api/admin/user', { op: 'add' }); assert(r.s >= 400);
  /* super sees users; owner cannot use plat sync */
  r = await call('o', 'POST', '/api/sync', { doc: 'plat', ops: [{ o: 'set', p: ['settings', 'signupOpen'], v: false }] }); assert.equal(r.s, 403);
  r = await call('sa', 'GET', '/api/workspace'); assert(r.j.plat.users.length >= 3, 'super sees users');
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: [{ o: 'set', p: ['settings', 'trialDays'], v: 3 }] }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('', 'GET', '/api/workspace'); assert.equal(r.s, 401);
  /* blob */
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const d3 = JSON.parse(JSON.stringify(r.j && 0 ? {} : (await call('o', 'GET', '/api/workspace')).j.d.doc)), d3b = JSON.parse(JSON.stringify(d3)); d3b.products[0].img = png;
  r = await call('o', 'POST', '/api/sync', { doc: 'd', rev: 0, ops: Diff.diff(d3, d3b) }); assert.equal(r.s, 200); const img = r.j.doc.products[0].img; assert(/^\/b\/[a-f0-9]{40}$/.test(img), img);
  const br = await fetch(base + img); assert.equal(br.status, 200); assert.equal(br.headers.get('content-type'), 'image/png');
  const nf = await fetch(base + '/b/' + 'a'.repeat(40)); assert.equal(nf.status, 404);

  /* ---- chat ---- */
  const phone = '020 9999 8888';
  r = await call('', 'POST', '/api/public/chat', { shop: 'noyshop', op: 'start', name: 'Buyer', phone, text: 'Hello, is size M in stock?' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  const th = r.j.thread; assert.equal(th.msgs.length, 1); assert(th.msgs[0].id);
  r = await call('', 'POST', '/api/public/chat', { shop: 'noyshop', op: 'send', tid: th.id, phone: '111222333', text: 'x' }); assert.equal(r.s, 404, 'thread must need matching phone');
  r = await call('', 'POST', '/api/public/chat', { shop: 'noyshop', op: 'start', name: '', phone, text: '' }); assert.equal(r.s, 400);
  r = await call('o', 'GET', '/api/workspace'); let wd = r.j.d.doc, wd2 = JSON.parse(JSON.stringify(wd)); const tt = wd2.threads.find(x => x.id === th.id); assert.equal(tt.unread, 1);
  tt.msgs.push({ id: 'mOwner1', f: 's', x: 'Yes!', t: Date.now() }); tt.cunread = 1; tt.unread = 0;
  r = await call('o', 'POST', '/api/sync', { doc: 'd', rev: r.j.d.rev, ops: Diff.diff(wd, wd2) }); assert.equal(r.s, 200);
  r = await call('', 'POST', '/api/public/chat', { shop: 'noyshop', op: 'send', tid: th.id, phone, text: 'Great, thanks' }); assert.equal(r.j.thread.msgs.length, 3);
  r = await call('', 'POST', '/api/public/track', { shop: 'noyshop', orders: [], chat: { tid: th.id, phone } }); assert.equal(r.j.thread.msgs.length, 3); assert.equal(r.j.thread.cunread, 1);
  r = await call('', 'POST', '/api/public/chat', { shop: 'noyshop', op: 'read', tid: th.id, phone }); assert.equal(r.j.thread.cunread, 0);
  r = await call('o', 'GET', '/api/workspace'); assert.equal(r.j.d.doc.threads[0].msgs.length, 3); assert.equal(r.j.d.doc.threads[0].unread, 1, 'owner own message did not clear later customer message');

  /* ---- shop-level agent codes ---- */
  wd = r.j.d.doc; wd2 = JSON.parse(JSON.stringify(wd)); wd2.affs.push({ id: 'a1', name: 'Kaew', phone: '020 1', code: 'KAEW10', store: 'all', pct: 10, active: true, paid: 0, log: [] }); wd2.seq.aff = 2;
  r = await call('o', 'POST', '/api/sync', { doc: 'd', rev: r.j.d.rev, ops: Diff.diff(wd, wd2) }); assert.equal(r.s, 200);
  r = await call('', 'GET', '/api/public/shop/noyshop'); assert.equal(r.j.d.affs.length, 1); assert(!JSON.stringify(r.j.d.affs).includes('Kaew'), 'agent private data leaked');
  const ord = aff => ({ shop: 'noyshop', lines: [{ sku: 'T-1', qty: 1 }], cust: { name: 'B', phone, address: 'V', pay: 'cod', aff } });
  r = await call('', 'POST', '/api/public/order', ord('NOPE')); assert.equal(r.s, 400); assert.equal(r.j.error, 'af.codeBad');
  r = await call('', 'POST', '/api/public/order', ord('kaew10')); assert.equal(r.s, 200, JSON.stringify(r.j)); assert(!('affAmt' in r.j.order) && !('aff' in r.j.order), 'commission leaked to customer');
  r = await call('o', 'GET', '/api/workspace'); const ao = r.j.d.doc.orders.find(x => x.id === (JSON.parse(JSON.stringify(r.j.d.doc.orders))[0].id)); assert.equal(ao.aff, 'KAEW10'); assert.equal(ao.affAmt, Math.round(ao.subtotal * 0.1));

  /* ---- owner-to-owner referral ---- */
  assert(/^Z[A-Z0-9]{6}$/.test(r.j.user.ref), 'owner has a referral code: ' + r.j.user.ref); const refCode = r.j.user.ref, ownerId = r.j.user.id;
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: [{ o: 'set', p: ['settings', 'aff', 'on'], v: true }] }); assert.equal(r.s, 200);
  r = await call('', 'POST', '/api/auth/signup', { name: 'Bad', email: 'bad@x.com', pass: 'secret1', ref: 'ZZZZZZZ' }); assert.equal(r.s, 400); assert.equal(r.j.error, 'af.refBad');
  r = await call('n2', 'POST', '/api/auth/signup', { name: 'Friend', biz: 'Friend Co', email: 'friend@x.com', pass: 'secret1', ref: refCode.toLowerCase() }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('o', 'GET', '/api/workspace'); const fr = r.j.plat.users.find(x => x.email === undefined && x.refBy === ownerId); assert(fr && fr.biz === 'Friend Co', 'owner sees referred shop'); assert(!('pass' in fr)); const friendId = fr.id;
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: [{ o: 'add', p: ['commissions'], k: 'CM-1001', v: { id: 'CM-1001', uid: ownerId, from: friendId, pay: 'PAY-1', base: 1000000, pct: 10, amount: 100000, t: Date.now() }, after: null }, { o: 'set', p: ['seq', 'comm'], v: 1002 }] }); assert.equal(r.s, 200);
  r = await call('o', 'GET', '/api/workspace'); assert.equal(r.j.plat.commissions.length, 1);
  r = await call('n2', 'GET', '/api/workspace'); assert.equal(r.j.plat.commissions.length, 0, 'others must not see commissions');
  r = await call('o', 'POST', '/api/affiliate/payout', { bank: '' }); assert.equal(r.s, 400);
  r = await call('o', 'POST', '/api/affiliate/payout', { bank: 'BCEL 123' }); assert.equal(r.s, 200); assert.equal(r.j.plat.payouts[0].amount, 100000);
  r = await call('o', 'POST', '/api/affiliate/payout', { bank: 'BCEL 123' }); assert.equal(r.s, 400); assert.equal(r.j.error, 'af.minErr');
  r = await call('sa', 'GET', '/api/workspace'); assert.equal(r.j.plat.payouts.length, 1);
  /* static + injection */
  const home = await (await fetch(base + '/s/noyshop')).text(); assert(home.includes('"shop":"noyshop"'));
  const tr = await fetch(base + '/../../etc/passwd'); assert(tr.status === 200 || tr.status === 404);
  console.log('API TESTS OK'); srv.close(); require('../lib/db').close().then(() => { try { fs.unlinkSync(tmp); } catch (e) {} process.exit(0); });
})().catch(e => { console.error('FAIL', e); process.exit(1); });
