'use strict';
/* Database layer. MySQL (Hostinger) when DB_HOST is set, otherwise a local SQLite file (dev / small installs). */
const path = require('path');
const fs = require('fs');
const CLIENT = process.env.DB_CLIENT || (process.env.DB_HOST ? 'mysql' : 'sqlite');
let q, close;

if (CLIENT === 'mysql') {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 8, charset: 'utf8mb4', dateStrings: true
  });
  q = async (sql, params) => { const [rows] = await pool.query(sql, params || []); return rows; };
  close = () => pool.end();
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'zelly.sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  q = async (sql, params) => {
    const st = db.prepare(sql);
    if (/^\s*(select|pragma)/i.test(sql)) return st.all(...(params || [])).map(r => { for (const k in r) if (r[k] instanceof Uint8Array) r[k] = Buffer.from(r[k]); return r; });
    const r = st.run(...(params || [])); return { affectedRows: Number(r.changes) };
  };
  close = async () => db.close();
}

const T = CLIENT === 'mysql' ? { text: 'LONGTEXT', blob: 'LONGBLOB', big: 'BIGINT', tail: ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' } : { text: 'TEXT', blob: 'BLOB', big: 'INTEGER', tail: '' };

async function migrate() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (id VARCHAR(40) NOT NULL PRIMARY KEY, email VARCHAR(190) NOT NULL, role VARCHAR(12) NOT NULL, owner_id VARCHAR(40) NULL, pass_hash VARCHAR(255) NOT NULL, data ${T.text} NOT NULL, created ${T.big} NOT NULL, UNIQUE (email))${T.tail}`,
    `CREATE TABLE IF NOT EXISTS sessions (token VARCHAR(64) NOT NULL PRIMARY KEY, user_id VARCHAR(40) NOT NULL, exp ${T.big} NOT NULL)${T.tail}`,
    `CREATE TABLE IF NOT EXISTS docs (id VARCHAR(80) NOT NULL PRIMARY KEY, rev INT NOT NULL, json ${T.text} NOT NULL)${T.tail}`,
    `CREATE TABLE IF NOT EXISTS blobs (id VARCHAR(64) NOT NULL PRIMARY KEY, mime VARCHAR(60) NOT NULL, data ${T.blob} NOT NULL, created ${T.big} NOT NULL)${T.tail}`,
    `CREATE TABLE IF NOT EXISTS shops (slug VARCHAR(120) NOT NULL PRIMARY KEY, owner_id VARCHAR(40) NOT NULL, store_id VARCHAR(40) NOT NULL)${T.tail}`
  ];
  for (const s of stmts) await q(s);
  try { await q('CREATE INDEX idx_users_owner ON users (owner_id)'); } catch (e) { /* exists */ }
  try { await q('CREATE INDEX idx_sessions_user ON sessions (user_id)'); } catch (e) { /* exists */ }
  try { await q('CREATE INDEX idx_shops_owner ON shops (owner_id)'); } catch (e) { /* exists */ }
}
module.exports = { q, close, migrate, CLIENT };
