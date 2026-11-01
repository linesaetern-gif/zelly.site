'use strict';
/* Browser end-to-end test:  node test/e2e.js [screenshotDir]   (needs playwright + chromium) */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = path.join(os.tmpdir(), 'zelly-e2e-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
process.env.ZELLY_NO_AUTOSTART = '1'; process.env.SQLITE_PATH = tmp; process.env.PORT = '0'; process.env.ADMIN_EMAIL = 'root@test.io'; process.env.ADMIN_PASSWORD = 'rootpass1'; delete process.env.DB_HOST;
const { chromium } = require('playwright'), { start } = require('../server'), { wizard } = require('./helpers');
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
  await wizard(ow, { email: 'noy@shop.la', name: 'Noy Vongsa', biz: 'Noy Shop', type: 'cosmetics', prov: 'lpb', dist: 'Louangphabang', vill: 'Xiengthong', shot: n => shot(ow, n) });
  await ow.waitForFunction(() => !!curUser(), null, { timeout: 8000 });
  assert.equal(await ev(ow, () => [curUser().email, curUser().role, D.stores.length, curUser().bizType, curUser().prov, curUser().dist, curUser().addr].join()), 'noy@shop.la,owner,0,cosmetics,lpb,Louangphabang,Xiengthong, Louangphabang, ຫຼວງພະບາງ');
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
  /* ---- 3b. the tracking link the owner sends (WhatsApp) opens that order's tracking page ---- */
  const link = await ev(ow, id => trackUrl({ id, store: S.shop }), oid); assert.equal(link, base + '/s/noyshop?track=' + oid, 'link format');
  const tk = await mk(390, 800); await tk.goto(link); await tk.waitForSelector('#f-trackphone');           // fresh device: asks for the phone number
  await tk.fill('#f-trackphone [name=phone]', '020 1111 2222'); await tk.click('button[form=f-trackphone]'); await tk.waitForSelector('#f-trackphone .err:not(:empty)');
  await shot(tk, '07b_track_phone');
  await tk.fill('#f-trackphone [name=phone]', '020 9999 8888'); await tk.click('button[form=f-trackphone]');
  await tk.waitForFunction(id => S.sheet && S.sheet.k === 'track' && S.sheet.id === id, oid, { timeout: 8000 }); await shot(tk, '07c_track_open');
  assert(!/track=/.test(tk.url()), 'query cleaned from the address bar');
  await tk.goto(link); await tk.waitForFunction(id => S.sheet && S.sheet.k === 'track' && S.sheet.id === id, oid, { timeout: 8000 });   // known device: opens directly
  const old = await mk(390, 800); await old.goto(base + '/t/' + oid); await old.waitForSelector('#f-trackphone');   // old-style link still lands on the tracking page

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

  /* ---- 9. chat: customer -> owner -> customer ---- */
  await ev(ow, () => closeSheet()); await login(ow, 'noy@shop.la', 'secret12'); await ow.waitForFunction(() => D.stores.length === 1);
  await cu.reload(); await cu.waitForSelector('.sf');
  await cu.click('[data-act=chat]'); await cu.waitForSelector('#f-chat');
  await cu.fill('#f-chat [name=name]', 'Buyer One'); await cu.fill('#f-chat [name=phone]', '020 9999 8888'); await cu.fill('#f-chat [name=text]', 'Is size M available?'); await shot(cu, '13_chat_start');
  await cu.click('#f-chat button[type=submit], button[form=f-chat]'); await cu.waitForSelector('.cmsg.me');
  await ow.waitForFunction(() => D.threads.length === 1 && D.threads[0].unread === 1, null, { timeout: 20000 });
  await ev(ow, () => { act('tab', { t: 'chat' }); act('chatopen', { id: D.threads[0].id }); });
  await ow.fill('.chat-form textarea', 'Yes, we have it!'); await ow.press('.chat-form textarea', 'Enter'); await synced(ow); await shot(ow, '14_owner_chat');
  await cu.waitForFunction(() => document.querySelectorAll('.cmsg.them').length === 1, null, { timeout: 12000 }); await shot(cu, '15_chat_reply');
  await cu.fill('.chat-form textarea', 'Thanks!'); await cu.press('.chat-form textarea', 'Enter'); await cu.waitForFunction(() => document.querySelectorAll('.cmsg.me').length === 2);
  await ow.waitForFunction(() => D.threads[0].msgs.length === 3 && D.threads[0].msgs.every(m => m.id), null, { timeout: 20000 });

  /* ---- 10. shop agent code on an order ---- */
  await ev(ow, () => { D.affs.push({ id: 'a1', name: 'Kaew', phone: '020 1', code: 'KAEW10', store: 'all', pct: 10, active: true, paid: 0, log: [] }); D.seq.aff = 2; }); await synced(ow);
  await cu.reload(); await cu.waitForSelector('.sf'); await cu.click('[data-act=openp]'); await cu.click('[data-act=addcart]'); await cu.click('.cartbar [data-act=cart]'); await cu.click('[data-act=tocheckout]'); await cu.waitForSelector('#f-co [name=aff]');
  await cu.fill('#f-co [name=name]', 'Buyer One'); await cu.fill('#f-co [name=phone]', '020 9999 8888'); await cu.fill('#f-co [name=address]', 'Vientiane'); await cu.selectOption('#f-co [name=pay]', 'cod'); await cu.fill('#f-co [name=aff]', 'nope');
  await cu.click('button[form=f-co]'); await cu.waitForFunction(() => document.querySelector('#f-co .err').textContent.length > 0);
  await cu.fill('#f-co [name=aff]', 'kaew10'); await cu.click('button[form=f-co]'); await cu.waitForFunction(() => S.sheet && S.sheet.k === 'done', null, { timeout: 8000 });
  await ow.waitForFunction(() => D.orders.some(o => o.aff === 'KAEW10'), null, { timeout: 20000 });
  assert.equal(await ev(ow, () => { const o = D.orders.find(x => x.aff); return o.affAmt === Math.round((o.subtotal - o.discount) * 0.1) && o.affAmt > 0; }), true);

  /* ---- 11. owner-to-owner referral, commission and payout ---- */
  await ev(sa, () => { AFF().on = true; AFF().min = 1000; AFF().pct = 10; }); await sa.waitForTimeout(2500);
  await ow.reload(); await ow.waitForFunction(() => !!curUser()); const refCode = await ev(ow, () => curUser().ref); assert(/^Z[A-Z0-9]{6}$/.test(refCode), refCode);
  const fr = await mk(1280, 900); await fr.goto(base + '/?ref=' + refCode); await fr.waitForSelector('.lp2-top');
  await wizard(fr, { email: 'friend@shop.la', name: 'Friend', biz: 'Friend Co', refExpect: refCode });
  await ev(fr, () => act('upgrade', { plan: 'basic' })); await fr.waitForFunction(() => S.sheet && S.sheet.k === 'upgrade'); await ev(fr, () => act('sendreq', {})); await fr.waitForFunction(() => PLAT.requests.length === 1, null, { timeout: 8000 });
  await sa.reload(); await sa.waitForFunction(() => !!curUser() && PLAT.requests.some(r => r.status === 'pending')); 
  const rid = await ev(sa, () => PLAT.requests.find(r => r.status === 'pending' && userById(r.uid).email === 'friend@shop.la').id); await ev(sa, i => { approveRequest(i); render(); }, rid);
  await sa.waitForTimeout(2800); await ow.reload(); await ow.waitForFunction(() => !!curUser());
  assert.equal(await ev(ow, () => [PLAT.commissions.length, PLAT.commissions[0] && PLAT.commissions[0].amount > 0, PLAT.users.filter(u => u.refBy === curUser().id).length].join()), '1,true,1');
  await ev(ow, () => act('tab', { t: 'affiliate' })); await shot(ow, '16_affiliate');
  await ev(ow, () => act('wdnew', {})); await ow.waitForSelector('#f-wd'); await ow.fill('#f-wd [name=bank]', 'BCEL One 000 111'); await ow.click('button[form=f-wd]');
  await ow.waitForFunction(() => PLAT.payouts.length === 1, null, { timeout: 8000 }); assert.equal(await ev(ow, () => affBalance(curUser().id)), 0);
  await sa.reload(); await sa.waitForFunction(() => !!curUser()); assert.equal(await ev(sa, () => PLAT.payouts.length), 1); await ev(sa, () => act('satab', { t: 'affiliate' })); await shot(sa, '17_super_affiliate');
  assert.deepEqual(errs, [], 'page errors: ' + errs.join(' | '));
  console.log('E2E OK'); await br.close(); srv.close(); require('../lib/db').close().then(() => { try { fs.unlinkSync(tmp); } catch (e) {} process.exit(0); });
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
