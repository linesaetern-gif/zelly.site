'use strict';
/* sign-up wizard: one URL per step, browser back/forward, draft survives reload (never the password)
   NODE_PATH=$(npm root -g) node test/e2e_wiz.js [shotsDir] */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = path.join(os.tmpdir(), 'zelly-wiz-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
Object.assign(process.env, { ZELLY_NO_AUTOSTART: '1', SQLITE_PATH: tmp, PORT: '0', ADMIN_EMAIL: 'root@test.io', ADMIN_PASSWORD: 'rootpass1' }); delete process.env.DB_HOST;
const { chromium } = require('playwright'), { start } = require('../server');
const SHOTS = process.argv[2] || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
(async () => {
  const srv = await start(), base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch(), errs = [];
  const mk = async () => { const c = await br.newContext({ viewport: { width: 400, height: 800 } }), pg = await c.newPage(); pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|cdnjs|fonts/.test(m.text())) errs.push(m.text()); }); await pg.route(/fonts\.(googleapis|gstatic)\.com|cdnjs/, r => r.abort()); return pg; };
  const at = async (pg, n) => { await pg.waitForFunction(k => S.sheet && S.sheet.k === 'signup' && (S.sheet.step || 1) === k && new URL(location.href).pathname === '/signup/' + (k >= 7 ? 'done' : k), n, { timeout: 8000 }); };
  const next = pg => pg.click('button[form=f-wz]');
  const shot = async (pg, n) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, n + '.png') }); };

  const pg = await mk(); await pg.goto(base + '/'); await pg.waitForSelector('.lp2-top');
  await pg.click('.lp2-top [data-act=authopen][data-m=signup]'); await at(pg, 1);
  await pg.fill('#f-wz [name=email]', 'url@test.io'); await next(pg); await at(pg, 2);
  await pg.fill('#f-wz [name=name]', 'Noy'); await pg.fill('#f-wz [name=biz]', 'Noy Shop'); await pg.fill('#f-wz [name=phone]', '020 5555 1234'); await next(pg); await at(pg, 3);
  await pg.fill('#f-wz [name=pass]', 'secret12'); await pg.fill('#f-wz [name=pass2]', 'secret12'); await pg.check('#f-wz [name=agree]'); await next(pg); await at(pg, 4);
  /* browser back / forward walk the steps and keep what was typed */
  await pg.goBack(); await at(pg, 3); assert.equal(await pg.inputValue('#f-wz [name=pass]'), 'secret12', 'password kept in memory while on the page');
  await pg.goBack(); await at(pg, 2); assert.equal(await pg.inputValue('#f-wz [name=biz]'), 'Noy Shop');
  await pg.goForward(); await at(pg, 3); await pg.goForward(); await at(pg, 4);
  await pg.waitForSelector('.wz-type img'); assert.equal(await pg.locator('.wz-type img').count(), 6, 'six shop-type pictures'); assert(await pg.evaluate(() => [...document.querySelectorAll('.wz-type img')].every(i => i.complete && i.naturalWidth > 0)), 'pictures decoded'); await shot(pg, 'u4_type');
  await pg.click('[data-act=wiztype][data-v=cosmetics]'); await next(pg); await at(pg, 5); await shot(pg, 'u5_photo');
  /* the draft is on the device, the password is not */
  const raw = await pg.evaluate(() => localStorage.getItem('zl.wiz')); assert(raw && raw.includes('Noy Shop') && raw.includes('cosmetics'), 'draft saved'); assert(!raw.includes('secret12') && !/"pass2?"/.test(raw), 'password never stored');
  /* refresh on step 5: lands on step 3 because the password has to be typed again, everything else is still there */
  await pg.reload(); await at(pg, 3); assert(await pg.locator('#f-wz').count() === 1); assert((await pg.textContent('.sheet')).match(/password|ລະຫັດຜ່ານ|รหัสผ่าน/i)); assert.equal(await pg.inputValue('#f-wz [name=pass]'), ''); await shot(pg, 'u3_again');
  await pg.fill('#f-wz [name=pass]', 'secret12'); await pg.fill('#f-wz [name=pass2]', 'secret12'); if (!(await pg.isChecked('#f-wz [name=agree]'))) await pg.check('#f-wz [name=agree]'); await next(pg); await at(pg, 4);
  assert.equal(await pg.getAttribute('[data-act=wiztype][data-v=cosmetics]', 'aria-pressed'), 'true', 'shop type remembered');
  await next(pg); await at(pg, 5); await next(pg); await at(pg, 6);
  await pg.selectOption('#f-wz [name=prov]', 'lpb'); await pg.fill('#f-wz [name=dist]', 'Luang Prabang'); await next(pg); await at(pg, 7); await shot(pg, 'u7_done');
  assert.equal(await pg.evaluate(() => localStorage.getItem('zl.wiz')), null, 'draft cleared after sign-up');
  await pg.click('[data-act=wizenter]'); await pg.waitForFunction(() => !!curUser() && !S.sheet && location.pathname === '/', null, { timeout: 8000 });
  /* profile → "change password" is a button that opens its own sheet */
  await pg.click('.topbar [data-act=profile]'); await pg.waitForSelector('#f-prof'); assert.equal(await pg.locator('#f-prof [type=password]').count(), 0, 'no password fields inside the profile form');
  await pg.click('[data-act=pwopen]'); await pg.waitForSelector('#f-pw'); await shot(pg, 'u8_pw');
  await pg.fill('#f-pw [name=pwcur]', 'wrongpass'); await pg.fill('#f-pw [name=pwnew]', 'newsecret9'); await pg.fill('#f-pw [name=pwconf]', 'newsecret9'); await pg.click('button[form=f-pw]');
  await pg.waitForFunction(() => document.querySelector('#f-pw .err').textContent.trim().length > 0); assert.equal(await pg.evaluate(() => S.sheet.k), 'pw', 'stays open on wrong current password');
  await pg.fill('#f-pw [name=pwcur]', 'secret12'); await pg.fill('#f-pw [name=pwconf]', 'different'); await pg.click('button[form=f-pw]'); await pg.waitForFunction(() => document.querySelector('#f-pw .err').textContent.trim().length > 0);
  await pg.fill('#f-pw [name=pwconf]', 'newsecret9'); await pg.click('button[form=f-pw]'); await pg.waitForFunction(() => S.sheet && S.sheet.k === 'profile');
  const lg = pw => pg.evaluate(async p => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'url@test.io', pass: p }) })).status, pw);
  assert.equal(await lg('secret12'), 401, 'old password no longer works'); assert.equal(await lg('newsecret9'), 200, 'new password works');
  await pg.click('.sheet-h [data-act=close]'); await pg.waitForFunction(() => !S.sheet);
  /* a signed-in visitor opening a sign-up link is sent to the app */
  await pg.goto(base + '/signup/2'); await pg.waitForFunction(() => !!curUser() && location.pathname === '/' && !S.sheet, null, { timeout: 8000 });

  /* deep links */
  const p2 = await mk(); await p2.goto(base + '/signup/6'); await at(p2, 1);                       // nothing filled in → first page
  await p2.goto(base + '/signup/'); await at(p2, 1); await p2.goto(base + '/signup'); await at(p2, 1);
  await p2.fill('#f-wz [name=email]', 'deep@test.io'); await next(p2); await at(p2, 2);
  /* closing the wizard leaves the /signup URL */
  await p2.click('.sheet-h [data-act=close]'); await p2.waitForFunction(() => !S.sheet && location.pathname === '/'); assert.equal(await p2.locator('.lp2-top').count() > 0, true);
  /* the draft is offered again next time (email is already there) */
  await p2.click('.lp2-top [data-act=authopen][data-m=signup]'); await at(p2, 1); assert.equal(await p2.inputValue('#f-wz [name=email]'), 'deep@test.io');
  /* "I already have an account" leaves the wizard URL too */
  await p2.click('.sheet-f [data-act=authopen][data-m=login]'); await p2.waitForFunction(() => S.sheet && S.sheet.k === 'login' && location.pathname === '/');
  assert.deepEqual(errs, [], errs.join(' | ')); console.log('E2E WIZARD URLS OK'); await br.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
