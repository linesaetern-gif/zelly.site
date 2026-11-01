'use strict';
/* Online payment + e-mail test: mock PhaJay gateway + mock SMTP server (implicit TLS and STARTTLS).  node test/pay.test.js */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), tls = require('tls'), crypto = require('crypto');
const tmp = path.join(os.tmpdir(), 'zelly-pay-' + process.pid + '.sqlite'); try { fs.unlinkSync(tmp); } catch (e) {}
/* throw-away self-signed certificate for the mock SMTP server (needs the openssl command) */
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelly-cert-'));
require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const KEY = fs.readFileSync(path.join(certDir, 'k.pem')), CERT = fs.readFileSync(path.join(certDir, 'c.pem'));
Object.assign(process.env, { ZELLY_NO_AUTOSTART: '1', SQLITE_PATH: tmp, PORT: '0', ADMIN_EMAIL: 'root@test.io', ADMIN_PASSWORD: 'rootpass1', PHAJAY_SECRET_KEY: 'sk_test', PHAJAY_WEBHOOK_KEY: 'wk_test', SMTP_USER: 'bot@zelly.test', SMTP_PASS: 'pw', SMTP_FROM: 'Zelly <bot@zelly.test>', SMTP_INSECURE: '1', APP_URL: 'https://zelly.test' });
delete process.env.DB_HOST;
const assert = require('assert'), Diff = require('../lib/diff');

/* ---------- mock SMTP ---------- */
function smtpServer(implicit) {
  const mails = [], log = [];
  const onSock = (sock0) => {
    let sock = sock0, buf = '', data = null, authed = false, from = '', rcpt = '';
    const w = s => sock.write(s + '\r\n');
    const feed = d => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; data += buf.slice(0, i); buf = buf.slice(i + 5); mails.push(parse(data, from, rcpt)); data = null; w('250 queued'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line.slice(0, 20));
        if (/^EHLO/i.test(line)) { w('250-mock'); if (!(sock instanceof tls.TLSSocket) && !implicit) w('250-STARTTLS'); w('250 AUTH PLAIN LOGIN'); }
        else if (/^STARTTLS/i.test(line)) { w('220 go'); sock.removeListener('data', feed); const t = new tls.TLSSocket(sock, { isServer: true, key: KEY, cert: CERT }); sock = t; t.on('data', feed); t.on('error', () => {}); }
        else if (/^AUTH PLAIN/i.test(line)) { const p = Buffer.from(line.slice(11), 'base64').toString().split('\0'); if (p[1] === 'bot@zelly.test' && p[2] === 'pw') { authed = true; w('235 ok'); } else w('535 bad'); }
        else if (/^MAIL FROM:/i.test(line)) { if (!authed) w('530 auth'); else { from = line.slice(10); w('250 ok'); } }
        else if (/^RCPT TO:/i.test(line)) { rcpt = line.slice(8).replace(/[<>]/g, ''); w('250 ok'); }
        else if (/^DATA/i.test(line)) { data = ''; w('354 go'); }
        else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
        else w('500 ?');
      }
    };
    sock.on('data', feed); sock.on('error', () => {}); w('220 mock ESMTP');
  };
  const server = implicit ? tls.createServer({ key: KEY, cert: CERT }, onSock) : net.createServer(onSock);
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, mails, log })));
}
function parse(raw, from, rcpt) {
  const [head, ...rest] = raw.split('\r\n\r\n'); let subj = (/^Subject: (.*)$/m.exec(head) || [])[1] || '';
  subj = subj.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  const text = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map(m => Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8')).join('\n');
  return { subject: subj, to: rcpt, from, text, raw };
}

/* ---------- mock PhaJay ---------- */
function phajay() {
  const tx = {}; let n = 1, calls = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && (req.url === '/v1/api/payment/generate-bcel-qr' || (process.env.PHAJAY_SANDBOX === '1' && req.url === '/v1/api/test/payment/generate-bcel-qr'))) {
        if (req.headers.secretkey !== 'sk_test') return out(401, { message: 'UNAUTHORIZED' });
        const j = JSON.parse(b); calls.push(j); const id = 'TX' + (n++); tx[id] = { amount: j.amount, orderNo: j.orderNo, paid: false, report: j.amount };
        return out(200, { message: 'SUCCESSFULLY', transactionId: id, qrCode: '00020101021133730004BCEL' + id, link: 'onepay://qr/' + id });
      }
      const m = /^\/v1\/api\/payment\/check-transaction\/status\/(.+)$/.exec(req.url);
      if (m && req.method === 'GET') {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('sk_test').toString('base64')) return out(401, { message: 'UNAUTHORIZED' });
        const t = tx[m[1]]; if (!t) return out(404, { message: 'PAYMENT_NOT_FOUND' });
        return out(200, { message: 'SUCCESSFULLY', data: { transactionId: m[1], orderNo: t.orderNo, status: t.paid ? 'PAYMENT_COMPLETED' : 'WAITING', isPaid: t.paid, amount: t.report, currency: 'LAK', paymentMethod: 'BCEL', paymentTime: t.paid ? new Date().toISOString() : null } });
      }
      out(404, {});
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, tx, calls })));
}

let base; const jars = {};
async function call(who, method, url, body, hdr, raw) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, hdr || {}); if (jars[who]) h.Cookie = jars[who];
  const r = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) { /* none */ } return { s: r.status, j };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > (ms || 6000)) throw new Error('timeout waiting for ' + what); await sleep(40); } }
const hook = (o, key) => { const raw = JSON.stringify(o); return { raw, sig: crypto.createHmac('sha256', key || 'wk_test').update(raw).digest('base64') }; };
const ymd = d => d.toISOString().slice(0, 10);
const today = () => ymd(new Date(Date.now() + 7 * 36e5));

(async () => {
  const pj = await phajay(), sm = await smtpServer(true), st = await smtpServer(false);
  process.env.PHAJAY_BASE = 'http://127.0.0.1:' + pj.port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sm.port), SMTP_SECURE: '1' });
  const { start } = require('../server'), Bill = require('../routes/billing'), Mailer = require('../lib/mailer'), M = require('../lib/model');
  const srv = await start(); base = 'http://127.0.0.1:' + srv.address().port;
  const mailTo = (to, re) => sm.mails.find(m => m.to === to && re.test(m.subject + '\n' + m.text));

  /* --- mailer direct: implicit TLS and STARTTLS both deliver UTF-8 --- */
  await Mailer.sendNow({ to: 'x@y.com', subject: 'ສະບາຍດີ ทดสอบ', text: 'ຂໍ້ຄວາມ ภาษาไทย\n.dot line' });
  assert.equal(sm.mails.at(-1).subject, 'ສະບາຍດີ ทดสอบ'); assert(sm.mails.at(-1).text.includes('ภาษาไทย') && sm.mails.at(-1).text.includes('\n.dot line'));
  process.env.SMTP_PORT = String(st.port); process.env.SMTP_SECURE = '0';
  await Mailer.sendNow({ to: 'z@y.com', subject: 'starttls', text: 'hello' }); assert.equal(st.mails.at(-1).subject, 'starttls'); assert(st.log.includes('STARTTLS'));
  process.env.SMTP_PASS = 'wrong'; await assert.rejects(Mailer.sendNow({ to: 'z@y.com', subject: 's', text: 't' }), /SMTP/); process.env.SMTP_PASS = 'pw';
  process.env.SMTP_PORT = String(sm.port); process.env.SMTP_SECURE = '1';
  const mail0 = sm.mails.length;

  /* --- accounts --- */
  let r = await call('sa', 'POST', '/api/auth/login', { email: 'root@test.io', pass: 'rootpass1', lang: 'en' }); assert.equal(r.s, 200);
  r = await call('sa', 'GET', '/api/workspace'); assert.equal(r.j.plat.online, true); assert.equal(r.j.plat.emailOn, true);
  let plat0 = r.j.plat, plat1 = JSON.parse(JSON.stringify(plat0)); plat1.settings.aff = { on: true, pct: 10, min: 1000 };
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: Diff.diff({ settings: plat0.settings }, { settings: plat1.settings }).map(o => o) }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('rf', 'POST', '/api/auth/signup', { name: 'Referrer', email: 'ref@x.com', pass: 'secret1', biz: 'Ref Co', lang: 'th' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await waitFor(() => mailTo('ref@x.com', /ยินดีต้อนรับ/), 'welcome mail (th)');
  r = await call('rf', 'GET', '/api/workspace'); const refCode = r.j.user.ref; assert(refCode);
  r = await call('by', 'POST', '/api/auth/signup', { name: 'Buyer', email: 'buy@x.com', pass: 'secret1', biz: 'Buy Co', ref: refCode, lang: 'en' }); assert.equal(r.s, 200);
  await waitFor(() => mailTo('buy@x.com', /Welcome to Zelly/), 'welcome mail (en)');
  r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.plat.online, true); const buyer = r.j.user;

  /* --- pay online: QR --- */
  r = await call('by', 'POST', '/api/billing/request', { planId: 'basic', months: 1 }); assert.equal(r.s, 200); const rid = r.j.id; const amount = r.j.plat.requests.find(x => x.id === rid).amount; assert(amount > 0);
  r = await call('', 'POST', '/api/billing/pay', { id: rid }); assert.equal(r.s, 401);
  r = await call('rf', 'POST', '/api/billing/pay', { id: rid }); assert.equal(r.s, 404, 'someone else must not pay/see my request');
  r = await call('by', 'POST', '/api/billing/pay', { id: rid }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert(r.j.pay.qr.startsWith('00020101021133730004BCEL')); assert.equal(r.j.pay.amount, amount);
  assert.equal(pj.calls.at(-1).amount, amount); assert.equal(pj.calls.at(-1).orderNo, rid); assert(/^[\x20-\x7e]+$/.test(pj.calls.at(-1).description), 'description must be ASCII for BCEL');
  const tx1 = Object.keys(pj.tx).at(-1), n1 = pj.calls.length;
  r = await call('by', 'POST', '/api/billing/pay', { id: rid }); assert.equal(r.j.pay.qr, '00020101021133730004BCEL' + tx1); assert.equal(pj.calls.length, n1, 'QR should be reused within 10 min');
  r = await call('by', 'GET', '/api/billing/status?id=' + rid); assert.equal(r.s, 200); assert.equal(r.j.paid, false);

  /* --- webhook: bad signature / junk / not-yet-paid --- */
  let h = hook({ transactionId: tx1, status: 'PAYMENT_COMPLETED', txnAmount: amount, paymentMethod: 'BCEL' });
  r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': 'AAAA' }, h.raw); assert.equal(r.s, 401);
  r = await call('', 'POST', '/api/webhooks/phajay', null, {}, h.raw); assert.equal(r.s, 401);
  r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': hook({ transactionId: tx1 }, 'other').sig }, h.raw); assert.equal(r.s, 401);
  r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': h.sig }, h.raw); assert.equal(r.s, 200);
  r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.plat.requests.find(x => x.id === rid).status, 'pending', 'signed webhook must be confirmed with the gateway before activating');
  assert.equal(r.j.user.planId, buyer.planId); assert.equal(r.j.user.exp, buyer.exp);

  /* --- really paid: webhook activates once --- */
  pj.tx[tx1].paid = true;
  r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': h.sig }, h.raw); assert.equal(r.s, 200);
  r = await call('by', 'GET', '/api/workspace'); let rq = r.j.plat.requests.find(x => x.id === rid);
  assert.equal(rq.status, 'paid'); assert.equal(r.j.user.planId, 'basic'); assert.equal(r.j.user.exp, Bill.addMonths(today(), 1)); assert.equal(r.j.plat.payments.length, 1); assert.equal(r.j.plat.payments[0].amount, amount);
  await waitFor(() => mailTo('buy@x.com', /Receipt PAY-/), 'receipt mail'); assert(mailTo('buy@x.com', /Receipt PAY-/).text.includes(r.j.user.exp));
  r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': h.sig }, h.raw); assert.equal(r.s, 200);
  r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.plat.payments.length, 1, 'webhook replay must not double-activate');
  r = await call('sa', 'GET', '/api/workspace'); const com = r.j.plat.commissions; assert.equal(com.length, 1); assert.equal(com[0].uid, buyer.refBy); assert.equal(com[0].amount, Math.round(amount * 0.1));
  await waitFor(() => mailTo('ref@x.com', /ได้รับค่าแนะนำ/), 'commission mail (th)');
  h = hook({ transactionId: 'NOPE', status: 'PAYMENT_COMPLETED', txnAmount: 1 }); r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': h.sig }, h.raw); assert.equal(r.s, 200);
  r = await call('by', 'GET', '/api/billing/status?id=' + rid); assert.equal(r.j.paid, true);

  /* --- renewal via status polling (no webhook) extends from the current expiry --- */
  r = await call('by', 'POST', '/api/billing/request', { planId: 'basic', months: 3 }); const rid2 = r.j.id, amt2 = r.j.plat.requests.find(x => x.id === rid2).amount;
  r = await call('by', 'POST', '/api/billing/pay', { id: rid2 }); assert.equal(r.s, 200); const tx2 = Object.keys(pj.tx).at(-1);
  pj.tx[tx2].paid = true; pj.tx[tx2].report = amt2 - 1000;   /* paid but too little */
  r = await call('by', 'GET', '/api/billing/status?id=' + rid2); assert.equal(r.j.paid, false, 'underpaid must not activate');
  pj.tx[tx2].report = amt2;
  r = await call('by', 'GET', '/api/billing/status?id=' + rid2); assert.equal(r.j.paid, true); assert(r.j.plat);
  r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.user.exp, Bill.addMonths(Bill.addMonths(today(), 1), 3)); assert.equal(r.j.plat.payments.length, 2);
  r = await call('by', 'POST', '/api/billing/pay', { id: rid2 }); assert.equal(r.s, 400, 'a paid request cannot be paid twice');

  /* --- paying an expired request still honours the money --- */
  r = await call('by', 'POST', '/api/billing/request', { planId: 'pro', months: 1 }); const rid3 = r.j.id;
  r = await call('by', 'POST', '/api/billing/pay', { id: rid3 }); const tx3 = Object.keys(pj.tx).at(-1);
  const pl = await M.getPlat(); pl.doc.requests.find(x => x.id === rid3).status = 'expired'; await M.putDoc('plat', pl.doc);
  pj.tx[tx3].paid = true; h = hook({ transactionId: tx3, status: 'PAYMENT_COMPLETED', txnAmount: 1 }); r = await call('', 'POST', '/api/webhooks/phajay', null, { 'X-Signature': h.sig }, h.raw);
  r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.user.planId, 'pro'); assert.equal(r.j.user.exp, Bill.addMonths(today(), 1), 'plan switch starts from today');

  /* --- manual slip flow still works + admin e-mails --- */
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await call('by', 'POST', '/api/billing/request', { planId: 'basic', months: 1 }); const rid4 = r.j.id;
  r = await call('by', 'POST', '/api/billing/slip', { id: rid4, img: png, name: 's.png' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await waitFor(() => mailTo('root@test.io', new RegExp('Slip waiting for review . ' + rid4)), 'admin slip mail');
  r = await call('sa', 'GET', '/api/workspace'); let pa = r.j.plat, pb = JSON.parse(JSON.stringify(pa)); const q4 = pb.requests.find(x => x.id === rid4); q4.slip = null; q4.slipRejected = true;
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: Diff.diff({ requests: pa.requests }, { requests: pb.requests }) }); assert.equal(r.s, 200);
  await waitFor(() => mailTo('buy@x.com', /Slip rejected . REQ|Please send a new slip/), 'slip rejected mail');
  pa = pb; pb = JSON.parse(JSON.stringify(pa)); pb.requests.find(x => x.id === rid4).status = 'paid';
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: Diff.diff({ requests: pa.requests }, { requests: pb.requests }) }); assert.equal(r.s, 200);
  await waitFor(() => mailTo('buy@x.com', new RegExp('Payment approved')), 'approved mail');

  /* --- affiliate payout mails --- */
  r = await call('rf', 'POST', '/api/affiliate/payout', { bank: 'BCEL 123' }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await waitFor(() => mailTo('root@test.io', /Affiliate payout request WD-/), 'admin payout request mail');
  r = await call('sa', 'GET', '/api/workspace'); pa = r.j.plat; pb = JSON.parse(JSON.stringify(pa)); pb.payouts[0].status = 'paid';
  r = await call('sa', 'POST', '/api/sync', { doc: 'plat', ops: Diff.diff({ payouts: pa.payouts }, { payouts: pb.payouts }) }); assert.equal(r.s, 200);
  await waitFor(() => mailTo('ref@x.com', /โอนค่าแนะนำแล้ว/), 'payout paid mail (th)');

  /* --- new order mail to the shop owner --- */
  r = await call('by', 'GET', '/api/workspace'); const bd = r.j.d.doc, bd2 = JSON.parse(JSON.stringify(bd)); const rev = r.j.d.rev;
  bd2.stores.push({ id: 's1', name: 'Buy Shop', slug: 'buyshop', wh: 'w1', color: '#2563eb', pay: { transfer: { on: true, bank: 'B', acc: '1', name: 'n' }, cod: { on: true } }, open: true });
  bd2.products.push({ id: 'p1', name: 'Tee', price: 100000, cost: 1, stores: ['s1'], active: true, variants: [{ sku: 'T-1', name: 'M', price: 100000, cost: 1 }] }); bd2.stock.w1['T-1'] = 5; bd2.seq.store = 2; bd2.seq.prod = 2;
  r = await call('by', 'POST', '/api/sync', { doc: 'd', rev, ops: Diff.diff(bd, bd2) }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await call('', 'POST', '/api/public/order', { shop: 'buyshop', lines: [{ sku: 'T-1', qty: 1 }], cust: { name: 'Cust', phone: '020 9999 8888', address: 'VTE', pay: 'cod' } }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await waitFor(() => mailTo('buy@x.com', new RegExp('New order ' + r.j.order.id)), 'new order mail');

  /* --- expiry reminders: once per stage --- */
  r = await call('sa', 'POST', '/api/admin/user', { id: buyer.id, name: 'Buyer', email: 'buy@x.com', planId: 'basic', status: 'active', exp: Bill.addMonths(today(), 0).slice(0, 8) + '01' }); assert.equal(r.s, 200);
  const soon = ymd(new Date(Date.now() + 7 * 36e5 + 3 * 864e5));
  r = await call('sa', 'POST', '/api/admin/user', { id: buyer.id, name: 'Buyer', email: 'buy@x.com', planId: 'basic', status: 'active', exp: soon }); assert.equal(r.s, 200);
  const before = sm.mails.length; let sent = await Bill.remindTick(); assert(sent >= 1);
  await waitFor(() => mailTo('buy@x.com', /expires in 3 day/), 'expiry reminder'); sent = await Bill.remindTick(); await sleep(300);
  assert.equal(sm.mails.filter(m => /expires in 3 day/.test(m.subject)).length, 1, 'reminder must not repeat');

  /* --- admin mail test --- */
  r = await call('by', 'POST', '/api/admin/mailtest', {}); assert(r.s === 403);
  r = await call('sa', 'POST', '/api/admin/mailtest', { lang: 'en' }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert(mailTo('root@test.io', /Zelly test email/));

  /* --- sandbox key against the production path is refused by the gateway; PHAJAY_SANDBOX=1 switches to the /test/ path --- */
  r = await call('by', 'POST', '/api/billing/request', { planId: 'basic', months: 1 }); const ridS = r.j.id; process.env.PHAJAY_SANDBOX = '1';
  r = await call('by', 'POST', '/api/billing/pay', { id: ridS }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert(r.j.pay.qr.includes('BCEL')); delete process.env.PHAJAY_SANDBOX;
  /* --- gateway down: pay returns an error, no crash --- */
  process.env.PHAJAY_BASE = 'http://127.0.0.1:1'; r = await call('by', 'POST', '/api/billing/request', { planId: 'basic', months: 1 });
  r = await call('by', 'POST', '/api/billing/pay', { id: r.j.id }); assert.equal(r.s, 502); assert.equal(r.j.error, 'pay.fail'); assert(/ECONNREFUSED/.test(r.j.detail), 'reason must be reported');
  /* --- not configured --- */
  delete process.env.PHAJAY_SECRET_KEY; r = await call('by', 'GET', '/api/workspace'); assert.equal(r.j.plat.online, false);
  r = await call('by', 'POST', '/api/billing/pay', { id: 'REQ-1' }); assert.equal(r.s, 503);
  console.log('PAY + MAIL TESTS OK (' + (sm.mails.length - mail0) + ' mails delivered via mock SMTP)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
