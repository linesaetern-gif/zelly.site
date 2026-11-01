'use strict';
/* walks through the 7-page sign-up wizard. o = { email, name, biz, phone, pass, type, prov, dist, vill, refExpect, shots(fn) } */
const assert = require('assert');
module.exports.wizard = async function wizard(pg, o) {
  const next = async () => { await pg.click('button[form=f-wz]'); };
  const step = async n => { await pg.waitForFunction(k => S.sheet && S.sheet.k === 'signup' && (S.sheet.step || 1) === k, n, { timeout: 8000 }); };
  const shot = async n => { if (o.shot) await o.shot(n); };
  await pg.click('.lp2-top [data-act=authopen][data-m=signup]'); await pg.waitForSelector('#f-wz'); await step(1); await shot('w1_email');
  await pg.fill('#f-wz [name=email]', o.email); await next(); await step(2);
  if (o.refExpect !== undefined) assert.equal(await pg.inputValue('#f-wz [name=ref]'), o.refExpect, 'referral code prefilled from link');
  await shot('w2_info'); await pg.fill('#f-wz [name=name]', o.name); await pg.fill('#f-wz [name=biz]', o.biz); await pg.fill('#f-wz [name=phone]', o.phone || '020 5555 1234'); await next(); await step(3);
  await shot('w3_pass'); await pg.fill('#f-wz [name=pass]', o.pass || 'secret12'); await pg.fill('#f-wz [name=pass2]', o.pass || 'secret12'); await pg.check('#f-wz [name=agree]'); await next(); await step(4);
  await shot('w4_type'); await pg.click('[data-act=wiztype][data-v=' + (o.type || 'fashion') + ']'); await next(); await step(5);
  await shot('w5_photo'); await next(); await step(6);
  await shot('w6_addr'); await pg.selectOption('#f-wz [name=prov]', o.prov || 'vtc'); await pg.fill('#f-wz [name=dist]', o.dist || 'Chanthabury'); await pg.fill('#f-wz [name=vill]', o.vill || 'Phonxay'); await next();
  await step(7); await shot('w7_welcome'); await pg.click('[data-act=wizenter]');
  await pg.waitForFunction(() => !!curUser() && !S.sheet, null, { timeout: 8000 });
};
