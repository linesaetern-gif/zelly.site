'use strict';
/* PWA browser test:  NODE_PATH=$(npm root -g) node test/e2e_pwa.js [shotsDir] */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = path.join(os.tmpdir(), 'zelly-pwa-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
Object.assign(process.env, { ZELLY_NO_AUTOSTART: '1', SQLITE_PATH: tmp, PORT: '0', ADMIN_EMAIL: 'root@test.io', ADMIN_PASSWORD: 'rootpass1' }); delete process.env.DB_HOST;
const { chromium } = require('playwright'), { start } = require('../server');
const SHOTS = process.argv[2] || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
(async () => {
  const srv = await start(), base = 'http://127.0.0.1:' + srv.address().port, br = await chromium.launch(), errs = [];
  const mk = async (opts) => { const c = await br.newContext(Object.assign({ viewport: { width: 400, height: 800 } }, opts || {})), pg = await c.newPage(); pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|cdnjs|fonts/.test(m.text())) errs.push(m.text()); }); await pg.route(/fonts\.(googleapis|gstatic)\.com|cdnjs/, r => r.abort()); return pg; };
  /* Android/Chrome: service worker registers, install chip appears on beforeinstallprompt and triggers prompt() */
  const pg = await mk(); await pg.goto(base + '/'); await pg.waitForSelector('.lp2-top');
  await pg.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 8000 });
  const reg = await pg.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }); assert(reg, 'service worker active');
  assert.equal(await pg.evaluate(() => document.querySelector('link[rel=manifest]').getAttribute('href')), '/manifest.webmanifest');
  await pg.evaluate(() => { window.__prompted = 0; const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await pg.waitForSelector('#pwa-chip', { timeout: 4000 }); if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'w1_chip.png') });
  await pg.click('#pwa-chip .pwa-go'); await pg.waitForFunction(() => window.__prompted === 1); assert.equal(await pg.locator('#pwa-chip').count(), 0);
  /* offline navigation falls back to the friendly page */
  await pg.context().setOffline(true); await pg.goto(base + '/s/whatever').catch(() => { }); const body = await pg.textContent('body'); assert(/offline|ອິນເຕີເນັດ|อินเทอร์เน็ต/i.test(body), 'offline page: ' + body.slice(0, 80)); await pg.context().setOffline(false);
  /* dismiss is remembered */
  const pg2 = await mk(); await pg2.goto(base + '/'); await pg2.waitForSelector('.lp2-top');
  const fire = () => pg2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { }; e.userChoice = Promise.resolve({}); window.dispatchEvent(e); });
  await fire(); await pg2.waitForSelector('#pwa-chip'); await pg2.click('#pwa-chip .pwa-x'); assert.equal(await pg2.locator('#pwa-chip').count(), 0);
  await pg2.reload(); await pg2.waitForSelector('.lp2-top'); await fire(); await pg2.waitForTimeout(2200); assert.equal(await pg2.locator('#pwa-chip').count(), 0, 'dismissed chip stays hidden');
  /* iPhone Safari: no install event, chip explains Add to Home Screen */
  const ip = await mk({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', hasTouch: true, isMobile: true });
  await ip.goto(base + '/'); await ip.waitForSelector('#pwa-chip', { timeout: 8000 }); await ip.click('#pwa-chip .pwa-go'); await ip.waitForFunction(() => S.sheet && S.sheet.k === 'pwaios'); if (SHOTS) await ip.screenshot({ path: path.join(SHOTS, 'w2_ios.png') });
  assert((await ip.textContent('.sheet')).match(/Share|ແຊຣ໌|แชร์/));
  assert.deepEqual(errs, [], errs.join(' | ')); console.log('E2E PWA OK'); await br.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
