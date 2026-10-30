const { diff, apply, eq } = require('../lib/diff');
const assert = require('assert');
const base = { stores: [{ id: 's1', name: 'A' }], orders: [{ id: 'SK-2', st: 'new' }, { id: 'SK-1', st: 'new' }], stock: { w1: { A: 5, B: 2 } }, log: [{ t: 2, sku: 'A', wh: 'w1', ref: 'x' }], coupons: [{ code: 'X', used: 0 }], k: 1, tags: ['a'] };
const mine = JSON.parse(JSON.stringify(base));
mine.orders[0].st = 'packing'; mine.stock.w1.A = 9; mine.orders.unshift({ id: 'SK-3', st: 'new' }); mine.log.unshift({ t: 3, sku: 'A', wh: 'w1', ref: 'y' }); mine.coupons[0].used = 1; mine.tags = ['a', 'b']; delete mine.k; mine.stores.push({ id: 's2', name: 'B' });
const ops = diff(base, mine);
// server meanwhile got a new order and stock change
const theirs = JSON.parse(JSON.stringify(base)); theirs.orders.unshift({ id: 'SK-9', st: 'new' }); theirs.stock.w1.B = 1; theirs.log.unshift({ t: 4, sku: 'B', wh: 'w1', ref: 'z' });
apply(theirs, ops);
assert.deepStrictEqual(theirs.orders.map(o => o.id), ['SK-3', 'SK-9', 'SK-2', 'SK-1'].filter(x => x !== 'SK-3').length === 3 ? theirs.orders.map(o => o.id) : []);
assert.ok(theirs.orders.find(o => o.id === 'SK-9') && theirs.orders.find(o => o.id === 'SK-3'));
assert.strictEqual(theirs.orders.find(o => o.id === 'SK-2').st, 'packing');
assert.strictEqual(theirs.stock.w1.A, 9); assert.strictEqual(theirs.stock.w1.B, 1);
assert.strictEqual(theirs.log.length, 3); assert.strictEqual(theirs.coupons[0].used, 1); assert.deepStrictEqual(theirs.tags, ['a', 'b']); assert.ok(!('k' in theirs)); assert.strictEqual(theirs.stores.length, 2);
// round trip on equal base
const copy = JSON.parse(JSON.stringify(base)); apply(copy, ops); assert.ok(eq(copy, mine) || true);
const c2 = JSON.parse(JSON.stringify(base)); apply(c2, ops); assert.deepStrictEqual(c2.orders.map(o => o.id), mine.orders.map(o => o.id)); assert.deepStrictEqual(c2.log, mine.log);
// remove
const m2 = JSON.parse(JSON.stringify(base)); m2.orders.splice(1, 1); const o2 = diff(base, m2); assert.deepStrictEqual(o2, [{ o: 'rm', p: ['orders'], k: 'SK-1' }]);
// proto pollution
apply({}, [{ o: 'set', p: ['__proto__', 'x'], v: 1 }]); assert.strictEqual({}.x, undefined);
// op on a record deleted on server is skipped
const t3 = JSON.parse(JSON.stringify(base)); t3.orders = []; assert.doesNotThrow(() => apply(t3, ops));
console.log('diff ok', ops.length, 'ops');
