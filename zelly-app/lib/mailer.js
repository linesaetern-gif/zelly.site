'use strict';
/* Minimal zero-dependency SMTP client (implicit TLS on 465 or STARTTLS on 587). Mail is queued and never blocks a request. */
const net = require('net'), tls = require('tls');
const cfg = () => ({ host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT) || 465, user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '', from: process.env.SMTP_FROM || process.env.SMTP_USER || '', secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== '0' : (Number(process.env.SMTP_PORT) || 465) === 465, rejectUnauthorized: process.env.SMTP_INSECURE !== '1' });
const enabled = () => !!(cfg().host && cfg().from);
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const wrap = s => b64(s).replace(/(.{76})/g, '$1\r\n');
const hdr = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
const addrOf = s => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); };
const nameOf = s => { const m = /^\s*"?([^"<]*?)"?\s*</.exec(s); return m ? m[1].trim() : ''; };
const clean = s => String(s).replace(/[\r\n]+/g, ' ').trim();

function buildMessage(c, m) {
  const to = clean(m.to), from = clean(c.from), fromName = nameOf(from), bnd = '=_zl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const head = ['From: ' + (fromName ? hdr(fromName) + ' <' + addrOf(from) + '>' : addrOf(from)), 'To: ' + to, 'Subject: ' + hdr(clean(m.subject)), 'Date: ' + new Date().toUTCString(), 'Message-ID: <' + Date.now().toString(36) + Math.random().toString(36).slice(2) + '@' + (addrOf(from).split('@')[1] || 'zelly') + '>', 'MIME-Version: 1.0'];
  if (m.replyTo) head.push('Reply-To: ' + clean(m.replyTo));
  let body;
  if (m.html) body = head.concat(['Content-Type: multipart/alternative; boundary="' + bnd + '"', '', '--' + bnd, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(m.text || ''), '--' + bnd, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(m.html), '--' + bnd + '--', '']).join('\r\n');
  else body = head.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(m.text || ''), '']).join('\r\n');
  return body.replace(/^\./gm, '..');
}

/* one SMTP conversation */
function smtpSend(c, m) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', step = 0, done = false, starttls = false, queue = [];
    const fail = e => { if (done) return; done = true; try { sock && sock.destroy(); } catch (x) { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const ok = () => { if (done) return; done = true; try { sock.end(); } catch (x) { /* ignore */ } resolve(true); };
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 30000);
    const write = s => sock.write(s + '\r\n');
    const rcpt = addrOf(m.to), sender = addrOf(c.from), auth = Buffer.from('\0' + c.user + '\0' + c.pass).toString('base64');
    /* each entry: [command or null, expected code prefix] */
    const plan = () => {
      const p = [['EHLO zelly', '250']];
      if (c.user) p.push(['AUTH PLAIN ' + auth, '235']);
      p.push(['MAIL FROM:<' + sender + '>', '250'], ['RCPT TO:<' + rcpt + '>', '25'], ['DATA', '354'], [buildMessage(c, m) + '\r\n.', '250'], ['QUIT', '']);
      return p;
    };
    queue = [[null, '220']];
    const onData = d => {
      buf += d.toString('utf8');
      for (;;) {
        const lines = buf.split('\r\n'); if (lines.length < 2) return;
        /* a reply is complete when a line looks like "250 text" (space after code) */
        let end = -1; for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { end = i; break; }
        if (end < 0) return;
        const reply = lines.slice(0, end + 1); buf = lines.slice(end + 1).join('\r\n');
        const code = reply[end].slice(0, 3), want = queue[0][1];
        if (want && code.indexOf(want) !== 0) return fail(new Error('SMTP ' + reply.join(' | ')));
        const cur = queue.shift();
        if (cur[2] === 'starttls') { starttls = true; sock.removeAllListeners('data'); const s2 = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: c.rejectUnauthorized }, () => { sock = s2; sock.on('data', onData); sock.on('error', fail); queue = plan(); next(); }); s2.on('error', fail); return; }
        if (!queue.length) { if (cur[0] === 'QUIT' || cur[1] === '') { clearTimeout(timer); return ok(); } }
        next(); if (done) return;
      }
    };
    const next = () => {
      if (!queue.length) return;
      const [cmd] = queue[0]; if (cmd === null) return;
      write(cmd);
      if (cmd === 'QUIT') { clearTimeout(timer); setTimeout(ok, 50); }
    };
    const onConnect = () => { /* wait for 220 greeting */ };
    /* STARTTLS handshake is handled by prepending commands after greeting when port != 465 */
    const startPlain = () => {
      queue = [[null, '220'], ['EHLO zelly', '250'], ['STARTTLS', '220', 'starttls']];
    };
    const afterGreetingTls = () => { queue = [[null, '220']].concat(plan()); };
    if (c.secure) { sock = tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: c.rejectUnauthorized }, onConnect); afterGreetingTls(); }
    else { sock = net.connect({ host: c.host, port: c.port }, onConnect); startPlain(); }
    sock.on('data', onData); sock.on('error', fail);
    sock.on('close', () => { if (!done) fail(new Error('SMTP connection closed')); });
  });
}

const q = []; let running = false, warned = false;
async function drain() {
  if (running) return; running = true;
  while (q.length) {
    const job = q.shift();
    try { await smtpSend(cfg(), job.m); if (job.cb) job.cb(null); }
    catch (e) {
      if (job.tries < 2) { job.tries++; setTimeout(() => { q.push(job); drain(); }, 15000 * job.tries).unref(); }
      else { console.error('[mail] failed to', job.m.to, '-', e.message); if (job.cb) job.cb(e); }
    }
  }
  running = false;
}
/* fire-and-forget; returns false when mail is not configured */
function send(m) {
  if (!enabled()) { if (!warned) { warned = true; console.log('[mail] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — email notifications are off'); } return false; }
  if (!m || !m.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addrOf(m.to))) return false;
  q.push({ m, tries: 0 }); drain(); return true;
}
/* awaitable single attempt (used by the admin "send test email") */
async function sendNow(m) { if (!enabled()) throw new Error('SMTP is not configured'); await smtpSend(cfg(), m); return true; }
module.exports = { send, sendNow, enabled, buildMessage };
