'use strict';
/* Browser end-to-end test:  node test/e2e.js [screenshotDir]   (needs playwright + chromium) */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = path.join(os.tmpdir(), 'zelly-e2e-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
process.env.SQLITE_PATH = tmp; process.env.PORT = '0'; process.env.ADMIN_EMAIL = 'root@test.io'; process.env.ADMIN_PASSWORD = 'rootpass1'; delete process.env.DB_HOST;
const { chromium } = require('playwright'), { start } = require('../server');
const SHOTS = process.argv[2] || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
(async () => {
  const srv = await start(), base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch(), errs = [];
  const mk = async (w, h) => {
    const ctx = await br.newContext({ viewport: { width: w, height: h } }), pg = await ctx.newPage();
    pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|cdnjs|fonts/.test(m.text())) errs.push(m.text()); });
    await pg.addInitScript(() => { window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 25, isDark: (r, c) => ((r * 7 + c * 3 + r * c) % 5) < 2 }); });
    await pg.route(/fonts\.(googleapis|gstatic)\.com|cdnjs/, r => r.abort());
    return pg;
  };
  const shot = (pg, n) => SHOTS ? pg.screenshot({ path: path.join(SHOTS, n + '.png') }) : null;
  const synced = pg => pg.waitForFunction(() => ZL_SY.base && JSON.stringify(D) === ZL_SY.baseStr && !ZL_SY.inflight, null, { timeout: 15000 });
  const ev = (pg, f, a) => pg.evaluate(f, a);
  const login = async (pg, email, pass) => {
    await pg.click('.lp2-top [data-act=authopen][data-m=login]');
    assert.equal(await pg.locator('[data-act=fillacct]').count(), 0, 'demo accounts must not show in live mode');
    await pg.fill('#f-login [name=email]', email); await pg.fill('#f-login [name=pass]', pass); await pg.click('button[form=f-login]');
    await pg.waitForFunction(() => !!curUser(), null, { timeout: 8000 });
  };

  /* ---- 1. owner signs up ---- */
  const ow = await mk(1280, 900); await ow.goto(base + '/'); await ow.waitForSelector('.lp2-top');
  assert.equal(await ev(ow, () => PLAT.users.length), 0, 'no demo users leak to guests');
  await shot(ow, '01_landing');
  await ow.click('.lp2-top [data-act=authopen][data-m=signup]'); await ow.waitForSelector('#f-signup');
  await ow.fill('#f-signup [name=name]', 'Noy Vongsa'); await ow.fill('#f-signup [name=biz]', 'Noy Shop'); await ow.fill('#f-signup [name=email]', 'noy@shop.la'); await ow.fill('#f-signup [name=phone]', '020 5555 1234');
  await ow.fill('#f-signup [name=pass]', 'secret12'); await ow.check('#f-signup [name=agree]'); await ow.click('button[form=f-signup]');
  await ow.waitForFunction(() => !!curUser(), null, { timeout: 8000 });
  assert.equal(await ev(ow, () => [curUser().email, curUser().role, D.stores.length].join()), 'noy@shop.la,owner,0');
  await shot(ow, '02_owner_empty');

  /* ---- 2. owner builds a shop (sync to server) ---- */
  await ev(ow, () => {
    const id = saveStore({ name: 'Noy Shop', slug: 'noyshop', type: 'fashion', wh: 'w1', color: '#2563eb', tagline: 'Hello', layout: 'grid', shipFee: 10000, freeShipMin: 0 });
    store(id).pay = { transfer: { on: true, bank: 'BCEL', accName: 'NOY', accNo: '123 456', qr: '', note: '' }, cod: { on: true }, chat: { on: false, contact: '' }, holdMin: 30 };
    addProduct({ name: 'Basic Tee', cat: 'Tops', price: 100000, cost: 40000, stores: [id], initial: 10, combos: [{ label: 'M', opts: [], stock: 10 }] });
    S.shop = id; render();
  });
  await synced(ow); await shot(ow, '03_owner_shop');
  const pub = await (await fetch(base + '/api/public/shop/noyshop')).json();
  assert.equal(pub.d.products.length, 1); assert(!JSON.stringify(pub).includes('"cost"'), 'cost leaked to public');

  /* ---- 3. a customer orders from /s/noyshop (separate browser) ---- */
  const cu = await mk(390, 800); await cu.goto(base + '/s/noyshop'); await cu.waitForSelector('.sf');
  assert.equal(await cu.locator('.sidebtn, .topbar').count(), 0, 'customers must not see admin UI');
  await shot(cu, '04_storefront');
  await cu.click('[data-act=openp]'); await cu.waitForSelector('[data-act=addcart]');
  await shot(cu, '05_product'); await cu.click('[data-act=addcart]'); await cu.click('.cartbar [data-act=cart]');
  await cu.waitForSelector('[data-act=tocheckout]'); await cu.click('[data-act=tocheckout]'); await cu.waitForSelector('#f-co');
  await cu.fill('#f-co [name=name]', 'Buyer One'); await cu.fill('#f-co [name=phone]', '020 9999 8888'); await cu.fill('#f-co [name=address]', 'Ban Phonxay, Vientiane');
  await cu.selectOption('#f-co [name=pay]', 'cod'); await shot(cu, '06_checkout');
  await cu.click('button[form=f-co]'); await cu.waitForFunction(() => S.sheet && S.sheet.k === 'done', null, { timeout: 8000 });
  const oid = await ev(cu, () => S.sheet.id); assert(/^SK-\d+$/.test(oid), oid); await shot(cu, '07_done');
  assert.equal(await ev(cu, () => stockOf('w1', 'P1-1')), 9, 'public stock updated');
  assert.deepEqual(await cu.evaluate(() => JSON.parse(localStorage.getItem('zl-mine:noyshop')).map(x => x.id)), [oid]);

  /* ---- 4. owner receives the order without losing own edits, then packs it ---- */
  await ev(ow, () => { store(S.shop).tagline = 'Hello v2'; });                       // local edit racing with the incoming order
  await ow.waitForFunction(o => D.orders.some(x => x.id === o), oid, { timeout: 20000 });
  await synced(ow);
  assert.equal(await ev(ow, () => store(S.shop).tagline), 'Hello v2');
  assert.equal(await ev(ow, () => stockOf('w1', 'P1-1')), 9);
  await ev(ow, o => { S.mode = 'pack'; S.pack = 'new'; setStatus(o, 'packing'); render(); }, oid); await synced(ow); await shot(ow, '08_pack');
  const tr = await (await fetch(base + '/api/public/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shop: 'noyshop', orders: [{ id: oid, phone: '020 9999 8888' }] }) })).json();
  assert.equal(tr.orders[0].status, 'packing', 'customer sees new status');

  /* ---- 5. reload keeps session and data ---- */
  await ow.reload(); await ow.waitForFunction(() => !!curUser() && D.stores.length === 1, null, { timeout: 8000 });
  assert.equal(await ev(ow, () => D.orders.length), 1);

  /* ---- 6. staff account with limited rights ---- */
  const r = await ev(ow, async () => (await fetch('/api/staff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Packer', email: 'pk@shop.la', pass: 'packer12', perms: ['pack', 'orders'], status: 'active' }) })).status);
  assert.equal(r, 200);
  const sf = await mk(390, 800); await sf.goto(base + '/'); await sf.waitForSelector('.lp2-top'); await login(sf, 'pk@shop.la', 'packer12');
  await sf.waitForFunction(() => D.orders.length === 1); assert.equal(await ev(sf, () => curUser().role), 'staff'); await shot(sf, '09_staff');

  /* ---- 7. owner asks to upgrade; super admin approves ---- */
  await ev(ow, () => { act('upgrade', { plan: 'pro' }); });
  await ow.waitForFunction(() => S.sheet && S.sheet.k === 'upgrade'); await ev(ow, () => act('sendreq', {}));
  await ow.waitForFunction(() => PLAT.requests.length === 1, null, { timeout: 8000 });
  const sa = await mk(1280, 900); await sa.goto(base + '/'); await sa.waitForSelector('.lp2-top'); await login(sa, 'root@test.io', 'rootpass1');
  await sa.waitForFunction(() => PLAT.users.length >= 3 && PLAT.requests.length === 1); await shot(sa, '10_super');
  await ev(sa, () => { approveRequest(PLAT.requests[0].id); render(); });
  await sa.waitForFunction(() => ZL_SY.inflight === false); await sa.waitForTimeout(2500);
  await ow.reload(); await ow.waitForFunction(() => !!curUser());
  assert.equal(await ev(ow, () => curUser().planId), 'pro', 'approval reached the owner'); assert.equal(await ev(ow, () => PLAT.payments.length), 1);
  await shot(ow, '11_owner_pro');

  /* ---- 8. logout, wrong password, unknown shop ---- */
  await ev(ow, () => act('logout', {})); await ow.waitForSelector('.lp2-top');
  assert.equal(await ev(ow, () => [!!curUser(), PLAT.users.length].join()), 'false,0');
  await ow.click('.lp2-top [data-act=authopen][data-m=login]'); await ow.fill('#f-login [name=email]', 'noy@shop.la'); await ow.fill('#f-login [name=pass]', 'wrong'); await ow.click('button[form=f-login]');
  await ow.waitForFunction(() => document.querySelector('#f-login .err').textContent.length > 0); 
  const nf = await mk(390, 700); await nf.goto(base + '/s/nope'); await nf.waitForSelector('.pub-nf'); await shot(nf, '12_notfound');
  assert.deepEqual(errs, [], 'page errors: ' + errs.join(' | '));
  console.log('E2E OK'); await br.close(); srv.close(); require('../lib/db').close().then(() => { try { fs.unlinkSync(tmp); } catch (e) {} process.exit(0); });
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
