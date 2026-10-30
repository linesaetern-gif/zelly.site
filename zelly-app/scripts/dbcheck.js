'use strict';
/* node scripts/dbcheck.js — checks DB connection and creates tables */
require('fs').existsSync('.env') && require('fs').readFileSync('.env', 'utf8').split(/\r?\n/).forEach(l => { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); });
const DB = require('../lib/db');
(async () => {
  console.log('driver:', DB.CLIENT);
  await DB.migrate(); const r = await DB.q('SELECT COUNT(*) AS n FROM users');
  console.log('OK — tables ready, users:', r[0].n); await DB.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
