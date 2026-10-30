'use strict';
/* npm test — runs the logic + API tests (no browser needed) */
const { spawnSync } = require('child_process'); const path = require('path');
let bad = 0;
for (const f of ['diff.test.js', 'api.test.js']) { const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' }); if (r.status) bad++; }
process.exit(bad ? 1 : 0);
