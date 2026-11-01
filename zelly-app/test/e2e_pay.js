'use strict';
/* Browser test of the online-payment sheet:  NODE_PATH=$(npm root -g) node test/e2e_pay.js [screenshotDir] */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert');
const tmp = path.join(os.tmpdir(), 'zelly-e2epay-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
Object.assign(process.env, { ZELLY_NO_AUTOSTART: '1', SQLITE_PATH: tmp, PORT: '0', ADMIN_EMAIL: 'root@test.io', ADMIN_PASSWORD: 'rootpass1', PHAJAY_SECRET_KEY: 'sk_test' }); delete process.env.DB_HOST;
const { chromium } = require('playwright'), { start } = require('../server');
const SHOTS = process.argv[2] || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const tx = {}; let n = 1;
const gw = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const out = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST') { const j = JSON.parse(b), id = 'TX' + n++; tx[id] = { amount: j.amount, paid: false }; return out({ message: 'SUCCESSFULLY', transactionId: id, qrCode: '00020101021133730004BCEL' + id, link: 'https://example.com/pay/' + id }); }
    const id = req.url.split('/').pop(), t = tx[id]; out({ message: 'SUCCESSFULLY', data: { status: t.paid ? 'PAYMENT_COMPLETED' : 'WAITING', isPaid: t.paid, amount: t.amount } });
  });
});
(async () => {
  await new Promise(ok => gw.listen(0, '127.0.0.1', ok)); process.env.PHAJAY_BASE = 'http://127.0.0.1:' + gw.address().port;
  const srv = await start(), base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch(), errs = [];
  const ctx = await br.newContext({ viewport: { width: 420, height: 860 } }), pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|cdnjs|fonts/.test(m.text())) errs.push(m.text()); });
  await pg.addInitScript(() => { window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 25, isDark: (r, c) => ((r * 7 + c * 3 + r * c) % 5) < 2 }); });
  await pg.route(/fonts\.(googleapis|gstatic)\.com|cdnjs/, r => r.abort());
  const shot = n => SHOTS ? pg.screenshot({ path: path.join(SHOTS, n + '.png') }) : null;
  await pg.goto(base + '/'); await pg.waitForSelector('.lp2-top');
  await pg.click('.lp2-top [data-act=authopen][data-m=signup]'); await pg.waitForSelector('#f-signup');
  await pg.fill('#f-signup [name=name]', 'Noy'); await pg.fill('#f-signup [name=biz]', 'Noy Shop'); await pg.fill('#f-signup [name=email]', 'noy@shop.la'); await pg.fill('#f-signup [name=phone]', '020 5555 1234');
  await pg.fill('#f-signup [name=pass]', 'secret12'); await pg.check('#f-signup [name=agree]'); await pg.click('button[form=f-signup]');
  await pg.waitForFunction(() => !!curUser(), null, { timeout: 8000 });
  assert.equal(await pg.evaluate(() => PLAT.online), true, 'client must know online payment is on');
  await pg.evaluate(() => { S.sheet = { k: 'upgrade', planId: 'basic', months: 1 }; renderSheet(); });
  await pg.waitForSelector('[data-act=sendreqpay]'); await shot('p1_upgrade');
  await pg.click('[data-act=sendreqpay]');
  await pg.waitForSelector('.qrbox svg.qr', { timeout: 8000 }); await shot('p2_qr');
  assert(await pg.locator('a.btn[href^="https://example.com/pay/"]').count() === 1, 'open-app link');
  assert((await pg.textContent('.sheet')).includes('REQ-'));
  /* pay on the gateway side; the sheet detects it by polling */
  Object.values(tx).forEach(t => { t.paid = true; });
  await pg.waitForFunction(() => S.sheet && S.sheet.state === 'paid', null, { timeout: 12000 }); await shot('p3_paid');
  assert.equal(await pg.evaluate(() => [curUser().planId, !!curUser().exp].join()), 'basic,true');
  await pg.click('[data-act=close]'); await pg.waitForFunction(() => !S.sheet);
  /* second request from the reqdone sheet: "pay online" card + switch to slip */
  await pg.evaluate(() => { S.sheet = { k: 'upgrade', planId: 'pro', months: 3 }; renderSheet(); });
  await pg.click('[data-act=sendreq]'); await pg.waitForSelector('[data-act=payonline]'); await shot('p4_reqdone');
  await pg.click('[data-act=payonline]'); await pg.waitForSelector('.qrbox svg.qr'); await pg.click('[data-act=reqpay]'); await pg.waitForSelector('[data-act=reqslipsample], .sheet [data-chg]');
  assert.equal(await pg.evaluate(() => S.sheet.k), 'reqdone');
  /* admin sees the status card */
  const ap = await (await br.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  ap.on('pageerror', e => errs.push(e.message)); await ap.addInitScript(() => { window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 25, isDark: () => true }); }); await ap.route(/fonts\.(googleapis|gstatic)\.com|cdnjs/, r => r.abort());
  await ap.goto(base + '/'); await ap.waitForSelector('.lp2-top'); await ap.click('.lp2-top [data-act=authopen][data-m=login]');
  await ap.fill('#f-login [name=email]', 'root@test.io'); await ap.fill('#f-login [name=pass]', 'rootpass1'); await ap.click('button[form=f-login]');
  await ap.waitForFunction(() => !!curUser(), null, { timeout: 8000 });
  await ap.evaluate(() => { S.sa = 'policy'; render(); }); await ap.waitForSelector('#f-policy'); const st = await ap.textContent('#app');
  assert(/PhaJay/.test(st), 'status card shows payment provider'); await (SHOTS ? ap.screenshot({ path: path.join(SHOTS, 'p5_admin_status.png') }) : null);
  assert.deepEqual(errs, [], 'console/page errors: ' + errs.join(' | '));
  console.log('E2E PAY OK'); await br.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
