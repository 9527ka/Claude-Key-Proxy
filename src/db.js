'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'usage.db'));
db.pragma('journal_mode = WAL');

// ─── Schema ───

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_name TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    status_code INTEGER,
    error_type TEXT,
    duration_ms INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_usage_key_ts ON usage_log(key_name, ts);

  CREATE TABLE IF NOT EXISTS key_state (
    key_name TEXT PRIMARY KEY,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_creation INTEGER DEFAULT 0,
    total_cache_read INTEGER DEFAULT 0,
    total_requests INTEGER DEFAULT 0,
    rate_limited_until INTEGER DEFAULT 0,
    last_error TEXT,
    last_used INTEGER DEFAULT 0,
    rl_tokens_limit INTEGER DEFAULT 0,
    rl_tokens_remaining INTEGER DEFAULT -1,
    rl_tokens_reset TEXT,
    rl_requests_limit INTEGER DEFAULT 0,
    rl_requests_remaining INTEGER DEFAULT -1,
    rl_requests_reset TEXT,
    daily_date TEXT,
    daily_input_tokens INTEGER DEFAULT 0,
    daily_output_tokens INTEGER DEFAULT 0,
    daily_requests INTEGER DEFAULT 0
  );
`);

// Migrate: add columns if missing (for existing DBs)
const migrations = [
  'rl_tokens_limit INTEGER DEFAULT 0',
  'rl_tokens_remaining INTEGER DEFAULT -1',
  'rl_tokens_reset TEXT',
  'rl_requests_limit INTEGER DEFAULT 0',
  'rl_requests_remaining INTEGER DEFAULT -1',
  'rl_requests_reset TEXT',
  'daily_date TEXT',
  'daily_input_tokens INTEGER DEFAULT 0',
  'daily_output_tokens INTEGER DEFAULT 0',
  'daily_requests INTEGER DEFAULT 0',
];
for (const col of migrations) {
  const name = col.split(' ')[0];
  try { db.exec(`ALTER TABLE key_state ADD COLUMN ${col}`); } catch {}
}

// ─── Prepared Statements ───

const stmt = {
  logUsage: db.prepare(`
    INSERT INTO usage_log (key_name, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, status_code, error_type, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  ensureKey: db.prepare(`INSERT OR IGNORE INTO key_state (key_name) VALUES (?)`),

  getAllStates: db.prepare(`SELECT * FROM key_state`),

  getKeyState: db.prepare(`SELECT * FROM key_state WHERE key_name = ?`),

  updateUsage: db.prepare(`
    UPDATE key_state SET
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cache_creation = total_cache_creation + ?,
      total_cache_read = total_cache_read + ?,
      total_requests = total_requests + 1,
      last_used = ?,
      daily_input_tokens = CASE WHEN daily_date = ? THEN daily_input_tokens + ? ELSE ? END,
      daily_output_tokens = CASE WHEN daily_date = ? THEN daily_output_tokens + ? ELSE ? END,
      daily_requests = CASE WHEN daily_date = ? THEN daily_requests + 1 ELSE 1 END,
      daily_date = ?
    WHERE key_name = ?
  `),

  updateRateLimit: db.prepare(`
    UPDATE key_state SET
      rl_tokens_limit = ?,
      rl_tokens_remaining = ?,
      rl_tokens_reset = ?,
      rl_requests_limit = ?,
      rl_requests_remaining = ?,
      rl_requests_reset = ?
    WHERE key_name = ?
  `),

  setBlocked: db.prepare(`
    UPDATE key_state SET rate_limited_until = ?, last_error = ? WHERE key_name = ?
  `),

  getLogs: db.prepare(`SELECT * FROM usage_log ORDER BY id DESC LIMIT ?`),

  deleteLogsByKey: db.prepare(`DELETE FROM usage_log WHERE key_name = ?`),
  deleteStateByKey: db.prepare(`DELETE FROM key_state WHERE key_name = ?`),
};

module.exports = { db, stmt };
