'use strict';
/* Online payment adapter. Provider: PhaJay (aggregator that issues BCEL OnePay QR). Replace this file to plug in another gateway
   (e.g. a direct BCEL / LAPNet contract) — the rest of the app only uses: online(), createQr(), status(), verifyWebhook(). */
const crypto = require('crypto'), http = require('http'), https = require('https');
const cfg = () => ({
  provider: (process.env.PAY_PROVIDER || (process.env.PHAJAY_SECRET_KEY ? 'phajay' : '')).toLowerCase(),
  key: process.env.PHAJAY_SECRET_KEY || '',
  hook: [process.env.PHAJAY_WEBHOOK_KEY, process.env.PHAJAY_SECRET_KEY, process.env.PHAJAY_DEV_SECRET_KEY].filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean),
  base: (process.env.PHAJAY_BASE || 'https://payment-gateway.phajay.co').replace(/\/+$/, ''),
  sandbox: /^(1|true|yes)$/i.test(process.env.PHAJAY_SANDBOX || ''),
  bank: (process.env.PHAJAY_BANK || 'bcel').toLowerCase().replace(/[^a-z]/g, '')
});
const online = () => { const c = cfg(); return c.provider === 'phajay' && !!c.key; };

function call(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https, data = body ? JSON.stringify(body) : null;
    const req = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } resolve({ code: res.statusCode, json: j, text: t }); });
    });
    req.setTimeout(20000, () => req.destroy(new Error('payment gateway timeout')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

/* amount in LAK (integer). order = our request id. Returns { txId, qr, link } */
async function createQr({ amount, order, description }) {
  const c = cfg(); if (!online()) throw new Error('online payment is not configured');
  const r = await call('POST', c.base + (c.sandbox ? '/v1/api/test' : '/v1/api') + '/payment/generate-' + c.bank + '-qr', { secretKey: c.key }, {
    amount: Math.round(amount), description: String(description || order).replace(/[^\x20-\x7e]/g, '').slice(0, 60) || order, orderNo: order, tag1: order, tag3: order
  });
  const j = r.json || {};
  if (r.code >= 300 || !j.transactionId || !j.qrCode) throw new Error('gateway ' + r.code + ': ' + String(j.message || j.error || r.text || '').slice(0, 120) + (c.sandbox ? ' [sandbox]' : ''));
  return { txId: String(j.transactionId), qr: String(j.qrCode), link: j.link ? String(j.link) : '' };
}

/* Authoritative status straight from the gateway. paid=true only when isPaid && PAYMENT_COMPLETED */
async function status(txId) {
  const c = cfg(); if (!online()) throw new Error('online payment is not configured');
  const r = await call('GET', c.base + '/v1/api/payment/check-transaction/status/' + encodeURIComponent(txId), { Authorization: 'Basic ' + Buffer.from(c.key).toString('base64') });
  const j = r.json || {}, d = j.data || null;
  if (!d) return { found: false, paid: false, status: j.message || String(r.code), amount: 0 };
  return { found: true, paid: d.isPaid === true && d.status === 'PAYMENT_COMPLETED', status: String(d.status || ''), amount: Number(d.amount) || 0, order: d.orderNo || '', time: d.paymentTime || null };
}

/* raw = Buffer of the request body exactly as received; sig = X-Signature header (base64 HMAC-SHA256) */
function verifyWebhook(raw, sig) {
  const c = cfg(); if (!sig || !raw || !c.hook.length) return false;
  const got = Buffer.from(String(sig).trim());
  return c.hook.some(k => { const want = Buffer.from(crypto.createHmac('sha256', k).update(raw).digest('base64')); return want.length === got.length && crypto.timingSafeEqual(want, got); });
}
module.exports = { online, createQr, status, verifyWebhook, cfg };
