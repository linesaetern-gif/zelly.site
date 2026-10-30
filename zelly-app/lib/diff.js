'use strict';
/* Shared by browser and server (UMD). Computes / applies path-based ops between two JSON documents.
   Keyed arrays (items with unique `id` or `code`, or the stock `log`) are merged per item, so two writers
   editing different records never overwrite each other.
   op: {o:'set',p:[..],v} | {o:'del',p:[..]} | {o:'add',p:[arr],k,v,after} | {o:'rm',p:[arr],k} */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ZDiff = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const logKey = e => e.t + '|' + (e.sku || '') + '|' + (e.wh || '') + '|' + (e.ref || '');
  function keyFn(arr, path) {
    if (path[path.length - 1] === 'log') return logKey;
    if (!arr.length) return null;
    for (const f of ['id', 'code']) if (arr.every(e => isObj(e) && typeof e[f] === 'string' && e[f] && e[f].indexOf('#') < 0)) return e => e[f];
    return null;
  }
  function keyFor(a, b, path) { return keyFn(b.length ? b : a, path) || keyFn(a, path); }
  function eq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false; return true; }
    const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !eq(a[k], b[k])) return false; return true;
  }
  function diff(a, b, path, ops) {
    path = path || []; ops = ops || [];
    if (a === b) return ops;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(b)) { if (!(k in a)) ops.push({ o: 'set', p: path.concat(k), v: b[k] }); else diff(a[k], b[k], path.concat(k), ops); }
      for (const k of Object.keys(a)) if (!(k in b)) ops.push({ o: 'del', p: path.concat(k) });
      return ops;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const kf = keyFor(a, b, path);
      if (kf && a.every(e => isObj(e)) && b.every(e => isObj(e))) {
        const am = new Map(a.map(e => [kf(e), e])), bm = new Map(b.map(e => [kf(e), e]));
        if (am.size === a.length && bm.size === b.length) {
          let prev = null;
          for (const e of b) { const k = kf(e); if (!am.has(k)) ops.push({ o: 'add', p: path, k, v: e, after: prev }); else diff(am.get(k), e, path.concat('#' + k), ops); prev = k; }
          for (const e of a) { const k = kf(e); if (!bm.has(k)) ops.push({ o: 'rm', p: path, k }); }
          return ops;
        }
      }
      if (!eq(a, b)) ops.push({ o: 'set', p: path, v: b });
      return ops;
    }
    if (!eq(a, b)) ops.push({ o: 'set', p: path, v: b });
    return ops;
  }
  /* walk to the parent of the last segment; returns null if the path no longer exists */
  function walk(doc, path) {
    let cur = doc;
    for (let i = 0; i < path.length; i++) {
      const s = path[i];
      if (cur === null || typeof cur !== 'object') return null;
      if (s[0] === '#' && Array.isArray(cur)) {
        const kf = keyFn(cur, path.slice(0, i)); if (!kf) return null;
        const hit = cur.find(e => isObj(e) && kf(e) === s.slice(1)); if (!hit) return null; cur = hit;
      } else { if (!(s in cur)) return null; cur = cur[s]; }
    }
    return cur;
  }
  function apply(doc, ops) {
    let n = 0;
    for (const op of ops) {
      const p = op.p; if (!Array.isArray(p) || p.some(s => typeof s !== 'string' || s === '__proto__' || s === 'constructor' || s === 'prototype')) continue;
      if (op.o === 'add' || op.o === 'rm') {
        const arr = walk(doc, p); if (!Array.isArray(arr)) continue;
        const kf = keyFn(arr.length ? arr : [op.v], p); if (!kf && op.o === 'rm') continue;
        if (op.o === 'rm') { const i = arr.findIndex(e => isObj(e) && kf(e) === op.k); if (i >= 0) { arr.splice(i, 1); n++; } continue; }
        if (!isObj(op.v)) continue;
        const k2 = kf || (e => e.id || e.code), i = arr.findIndex(e => isObj(e) && k2(e) === op.k);
        if (i >= 0) { arr[i] = op.v; n++; continue; }
        const at = op.after == null ? 0 : (arr.findIndex(e => isObj(e) && k2(e) === op.after) + 1);
        arr.splice(at, 0, op.v); n++; continue;
      }
      if (!p.length) continue;
      const parent = walk(doc, p.slice(0, -1)), last = p[p.length - 1]; if (parent === null || typeof parent !== 'object') continue;
      if (op.o === 'set') {
        if (last[0] === '#' && Array.isArray(parent)) { const kf = keyFn(parent, p.slice(0, -2)); const i = kf ? parent.findIndex(e => isObj(e) && kf(e) === last.slice(1)) : -1; if (i >= 0) { parent[i] = op.v; n++; } }
        else if (!Array.isArray(parent)) { parent[last] = op.v; n++; }
      } else if (op.o === 'del') { if (!Array.isArray(parent) && last in parent) { delete parent[last]; n++; } }
    }
    return n;
  }
  return { diff, apply, eq, keyFn };
});
