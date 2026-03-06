#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Database = require('better-sqlite3');

// ─── Config ───
const CONFIG_PATH = path.join(__dirname, 'keys.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.settings?.port || 9876;
const ADMIN_TOKEN = config.settings?.adminToken || 'change-me';
const PROXY_TOKEN = config.settings?.proxyToken || '';
const UPSTREAM = config.settings?.upstreamUrl || 'https://api.anthropic.com';

// ─── Database ───
const db = new Database(path.join(__dirname, 'data', 'usage.db'));
db.pragma('journal_mode = WAL');
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
    -- Rate limit info from Anthropic headers
    rl_tokens_limit INTEGER DEFAULT 0,
    rl_tokens_remaining INTEGER DEFAULT -1,
    rl_tokens_reset TEXT,
    rl_requests_limit INTEGER DEFAULT 0,
    rl_requests_remaining INTEGER DEFAULT -1,
    rl_requests_reset TEXT,
    -- Daily tracking
    daily_date TEXT,
    daily_input_tokens INTEGER DEFAULT 0,
    daily_output_tokens INTEGER DEFAULT 0,
    daily_requests INTEGER DEFAULT 0
  );
`);

// Migrate: add columns if missing (for existing DBs)
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_tokens_limit INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_tokens_remaining INTEGER DEFAULT -1`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_tokens_reset TEXT`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_requests_limit INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_requests_remaining INTEGER DEFAULT -1`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN rl_requests_reset TEXT`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN daily_date TEXT`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN daily_input_tokens INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN daily_output_tokens INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE key_state ADD COLUMN daily_requests INTEGER DEFAULT 0`); } catch {}

const stmtLogUsage = db.prepare(`
  INSERT INTO usage_log (key_name, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, status_code, error_type, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtEnsureKey = db.prepare(`INSERT OR IGNORE INTO key_state (key_name) VALUES (?)`);
const stmtGetStates = db.prepare(`SELECT * FROM key_state`);
const stmtGetKeyState = db.prepare(`SELECT * FROM key_state WHERE key_name = ?`);

const stmtUpdateUsage = db.prepare(`
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
`);

const stmtUpdateRateLimit = db.prepare(`
  UPDATE key_state SET
    rl_tokens_limit = ?,
    rl_tokens_remaining = ?,
    rl_tokens_reset = ?,
    rl_requests_limit = ?,
    rl_requests_remaining = ?,
    rl_requests_reset = ?
  WHERE key_name = ?
`);

const stmtSetBlocked = db.prepare(`
  UPDATE key_state SET rate_limited_until = ?, last_error = ? WHERE key_name = ?
`);

// Init key states
for (const k of config.keys) {
  stmtEnsureKey.run(k.name);
}

// ─── Helpers ───
function todayStr() {
  // UTC+8 date string
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

// ─── Key Selection Strategy ───
// Priority: pick the key with the LEAST remaining tokens (use it up before daily reset)
// If remaining = 0 or key is rate-limited, skip it
// If no remaining data yet (never used), treat as low priority (use known keys first)
function pickKey() {
  const now = Date.now();
  const states = stmtGetStates.all();
  const stateMap = Object.fromEntries(states.map(s => [s.key_name, s]));

  const today = todayStr();
  const candidates = config.keys.filter(k => {
    if (!k.enabled) return false;
    const st = stateMap[k.name];
    if (st && st.rate_limited_until > now) return false;
    // Skip if remaining is exactly 0 (fully exhausted)
    if (st && st.rl_tokens_remaining === 0) return false;
    // Skip if daily token limit reached
    if (k.dailyTokenLimit && k.dailyTokenLimit > 0 && st) {
      const todayTokens = st.daily_date === today ? ((st.daily_input_tokens || 0) + (st.daily_output_tokens || 0)) : 0;
      if (todayTokens >= k.dailyTokenLimit) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    // All blocked — pick the one that unblocks soonest
    const enabled = config.keys.filter(k => k.enabled);
    if (enabled.length === 0) return null;
    enabled.sort((a, b) => {
      const sa = stateMap[a.name] || {};
      const sb = stateMap[b.name] || {};
      return (sa.rate_limited_until || 0) - (sb.rate_limited_until || 0);
    });
    return enabled[0];
  }

  // Separate into: keys with known remaining vs unknown
  const withData = candidates.filter(k => {
    const st = stateMap[k.name];
    return st && st.rl_tokens_remaining > 0;
  });

  const withoutData = candidates.filter(k => {
    const st = stateMap[k.name];
    return !st || st.rl_tokens_remaining < 0;
  });

  if (withData.length > 0) {
    // Pick the one with LEAST remaining (use it up first to avoid daily waste)
    withData.sort((a, b) => {
      const sa = stateMap[a.name];
      const sb = stateMap[b.name];
      return sa.rl_tokens_remaining - sb.rl_tokens_remaining;
    });
    return withData[0];
  }

  // No remaining data — pick least used today
  withoutData.sort((a, b) => {
    const sa = stateMap[a.name] || {};
    const sb = stateMap[b.name] || {};
    const da = sa.daily_date === todayStr() ? (sa.daily_input_tokens || 0) : 0;
    const db_ = sb.daily_date === todayStr() ? (sb.daily_input_tokens || 0) : 0;
    return da - db_;
  });
  return withoutData[0];
}

// ─── Extract rate limit headers ───
function extractRateLimitHeaders(headers) {
  return {
    tokensLimit: parseInt(headers['anthropic-ratelimit-tokens-limit'] || '0', 10),
    tokensRemaining: parseInt(headers['anthropic-ratelimit-tokens-remaining'] || '-1', 10),
    tokensReset: headers['anthropic-ratelimit-tokens-reset'] || null,
    requestsLimit: parseInt(headers['anthropic-ratelimit-requests-limit'] || '0', 10),
    requestsRemaining: parseInt(headers['anthropic-ratelimit-requests-remaining'] || '-1', 10),
    requestsReset: headers['anthropic-ratelimit-requests-reset'] || null,
  };
}

// ─── Proxy Logic ───
function proxyRequest(clientReq, clientRes, selectedKey, retryCount = 0) {
  const startTime = Date.now();
  const upstreamUrl = new URL(clientReq.url, UPSTREAM);

  const headers = { ...clientReq.headers };
  delete headers['host'];
  delete headers['x-proxy-token']; // Don't forward proxy auth
  if (headers['authorization']?.startsWith('Bearer ') && headers['authorization'].includes(PROXY_TOKEN)) {
    delete headers['authorization']; // Remove proxy token from auth
  }
  headers['x-api-key'] = selectedKey.key;

  const options = {
    hostname: upstreamUrl.hostname,
    port: 443,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: clientReq.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode;
    const isStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

    // Always extract rate limit headers
    const rl = extractRateLimitHeaders(proxyRes.headers);
    if (rl.tokensRemaining >= 0) {
      stmtUpdateRateLimit.run(
        rl.tokensLimit, rl.tokensRemaining, rl.tokensReset,
        rl.requestsLimit, rl.requestsRemaining, rl.requestsReset,
        selectedKey.name
      );
    }

    if (statusCode === 429 || statusCode === 529) {
      const retryAfter = parseInt(proxyRes.headers['retry-after'] || '60', 10);
      const blockedUntil = Date.now() + retryAfter * 1000;
      stmtSetBlocked.run(blockedUntil, `${statusCode}`, selectedKey.name);

      proxyRes.resume(); // Drain

      if (retryCount < config.keys.filter(k => k.enabled).length) {
        const nextKey = pickKey();
        if (nextKey && nextKey.name !== selectedKey.name) {
          console.log(`[${new Date().toISOString()}] ${selectedKey.name} → ${statusCode}, switching to ${nextKey.name}`);
          return proxyRequest(clientReq, clientRes, nextKey, retryCount + 1);
        }
      }

      clientRes.writeHead(429, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'All API keys rate-limited' },
        retry_after: retryAfter,
      }));

      stmtLogUsage.run(selectedKey.name, Date.now(), null, 0, 0, 0, 0, statusCode, `rate_limit`, Date.now() - startTime);
      return;
    }

    // Add custom header to tell client which key was used
    const responseHeaders = { ...proxyRes.headers, 'x-proxy-key': selectedKey.name };
    clientRes.writeHead(statusCode, responseHeaders);

    if (isStream) {
      let sseBuffer = '';
      proxyRes.on('data', (chunk) => {
        clientRes.write(chunk);
        sseBuffer += chunk.toString();
      });
      proxyRes.on('end', () => {
        clientRes.end();
        const usage = extractStreamUsage(sseBuffer);
        recordUsage(selectedKey.name, usage, statusCode, Date.now() - startTime);
      });
    } else {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
        clientRes.write(chunk);
      });
      proxyRes.on('end', () => {
        clientRes.end();
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const usage = body.usage || {};
          recordUsage(selectedKey.name, usage, statusCode, Date.now() - startTime, body.model);
        } catch {
          recordUsage(selectedKey.name, {}, statusCode, Date.now() - startTime);
        }
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Proxy error [${selectedKey.name}]:`, err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
    }
  });

  if (clientReq._bodyBuffer) {
    proxyReq.end(clientReq._bodyBuffer);
  } else {
    const chunks = [];
    clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
      clientReq._bodyBuffer = Buffer.concat(chunks);
      proxyReq.end(clientReq._bodyBuffer);
    });
  }
}

function extractStreamUsage(sseText) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: null };
  try {
    // message_start has model + input usage
    const startMatch = sseText.match(/event:\s*message_start\ndata:\s*(\{.+\})/);
    if (startMatch) {
      const d = JSON.parse(startMatch[1]);
      usage.model = d.message?.model;
      if (d.message?.usage) {
        usage.input_tokens = d.message.usage.input_tokens || 0;
        usage.cache_creation_input_tokens = d.message.usage.cache_creation_input_tokens || 0;
        usage.cache_read_input_tokens = d.message.usage.cache_read_input_tokens || 0;
      }
    }
    // message_delta has output tokens
    const deltaMatch = sseText.match(/event:\s*message_delta\ndata:\s*(\{.+\})/);
    if (deltaMatch) {
      const d = JSON.parse(deltaMatch[1]);
      usage.output_tokens = d.usage?.output_tokens || 0;
    }
  } catch {}
  return usage;
}

function recordUsage(keyName, usage, statusCode, durationMs, model) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const m = model || usage.model || null;
  const today = todayStr();

  stmtLogUsage.run(keyName, Date.now(), m, input, output, cacheCreation, cacheRead, statusCode, null, durationMs);
  stmtUpdateUsage.run(
    input, output, cacheCreation, cacheRead, Date.now(),
    today, input, input,   // daily_input
    today, output, output, // daily_output
    today,                 // daily_requests check
    today,                 // daily_date set
    keyName
  );
}

// ─── Auth Check ───
function checkProxyAuth(req) {
  if (!PROXY_TOKEN) return true; // No auth configured
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${PROXY_TOKEN}`) return true;
  const token = req.headers['x-proxy-token'];
  if (token === PROXY_TOKEN) return true;
  // Also check x-api-key for convenience (some tools only set this)
  const apiKey = req.headers['x-api-key'];
  if (apiKey === PROXY_TOKEN) return true;
  return false;
}

// ─── Admin API ───
function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Dashboard page — no auth (login happens client-side)
  if (p === '/admin' || p === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
  }

  // API routes require admin token
  const token = url.searchParams.get('token') || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== ADMIN_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  if (p === '/admin/api/status' && req.method === 'GET') {
    const states = stmtGetStates.all();
    const today = todayStr();
    const keys = config.keys.map(k => {
      const st = states.find(s => s.key_name === k.name) || {};
      const isToday = st.daily_date === today;
      return {
        name: k.name,
        enabled: k.enabled,
        maskedKey: k.key.slice(0, 12) + '...' + k.key.slice(-4),
        totalInputTokens: st.total_input_tokens || 0,
        totalOutputTokens: st.total_output_tokens || 0,
        totalCacheCreation: st.total_cache_creation || 0,
        totalCacheRead: st.total_cache_read || 0,
        totalRequests: st.total_requests || 0,
        // Daily
        dailyInputTokens: isToday ? (st.daily_input_tokens || 0) : 0,
        dailyOutputTokens: isToday ? (st.daily_output_tokens || 0) : 0,
        dailyRequests: isToday ? (st.daily_requests || 0) : 0,
        // Rate limit info from Anthropic
        rlTokensLimit: st.rl_tokens_limit || 0,
        rlTokensRemaining: st.rl_tokens_remaining ?? -1,
        rlTokensReset: st.rl_tokens_reset || null,
        rlRequestsLimit: st.rl_requests_limit || 0,
        rlRequestsRemaining: st.rl_requests_remaining ?? -1,
        rlRequestsReset: st.rl_requests_reset || null,
        rateLimitedUntil: st.rate_limited_until || 0,
        lastError: st.last_error || null,
        lastUsed: st.last_used || 0,
        // Daily token limit (0 = unlimited)
        dailyTokenLimit: k.dailyTokenLimit || 0,
        // Cost estimate (Sonnet pricing: $3/$15 per MTok)
        estimatedCost: (
          ((st.total_input_tokens || 0) * 3 +
           (st.total_output_tokens || 0) * 15 +
           (st.total_cache_creation || 0) * 3.75 +
           (st.total_cache_read || 0) * 0.3) / 1_000_000
        ).toFixed(4),
        dailyCost: (
          ((isToday ? st.daily_input_tokens || 0 : 0) * 3 +
           (isToday ? st.daily_output_tokens || 0 : 0) * 15) / 1_000_000
        ).toFixed(4),
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ keys, uptime: process.uptime(), today }));
  }

  if (p === '/admin/api/logs' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const rows = db.prepare(`SELECT * FROM usage_log ORDER BY id DESC LIMIT ?`).all(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  if (p === '/admin/api/keys' && req.method === 'POST') {
    return readBody(req, (body) => {
      try {
        const { name, key, enabled } = JSON.parse(body);
        if (!name || !key) throw new Error('name and key required');
        if (config.keys.find(k => k.name === name)) throw new Error('Key name already exists');
        config.keys.push({ name, key, enabled: enabled !== false });
        stmtEnsureKey.run(name);
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  if (p.startsWith('/admin/api/keys/') && req.method === 'PATCH') {
    const keyName = decodeURIComponent(p.split('/').pop());
    return readBody(req, (body) => {
      try {
        const updates = JSON.parse(body);
        const idx = config.keys.findIndex(k => k.name === keyName);
        if (idx === -1) throw new Error('Key not found');
        if ('enabled' in updates) config.keys[idx].enabled = updates.enabled;
        if ('name' in updates) config.keys[idx].name = updates.name;
        if ('key' in updates) config.keys[idx].key = updates.key;
        if ('dailyTokenLimit' in updates) config.keys[idx].dailyTokenLimit = parseInt(updates.dailyTokenLimit, 10) || 0;
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  if (p.startsWith('/admin/api/keys/') && req.method === 'DELETE') {
    const keyName = decodeURIComponent(p.split('/').pop());
    config.keys = config.keys.filter(k => k.name !== keyName);
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (p === '/admin/api/reset' && req.method === 'POST') {
    return readBody(req, (body) => {
      try {
        const { keyName } = JSON.parse(body);
        if (keyName) {
          db.prepare(`DELETE FROM usage_log WHERE key_name = ?`).run(keyName);
          db.prepare(`DELETE FROM key_state WHERE key_name = ?`).run(keyName);
          stmtEnsureKey.run(keyName);
        } else {
          db.exec(`DELETE FROM usage_log; DELETE FROM key_state;`);
          for (const k of config.keys) stmtEnsureKey.run(k.name);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  if (p === '/admin/api/probe' && req.method === 'POST') {
    return readBody(req, async (body) => {
      try {
        const { keyName } = JSON.parse(body);
        const targets = keyName
          ? config.keys.filter(k => k.name === keyName)
          : config.keys.filter(k => k.enabled);
        if (targets.length === 0) throw new Error('No keys to probe');
        const results = {};
        await Promise.all(targets.map(async (k) => {
          results[k.name] = await probeKey(k);
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString()));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Probe: send minimal request to get rate limit headers ───
function probeKey(keyObj) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const options = {
      hostname: new URL(UPSTREAM).hostname,
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyObj.key,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      const rl = extractRateLimitHeaders(res.headers);
      if (rl.tokensRemaining >= 0) {
        stmtUpdateRateLimit.run(
          rl.tokensLimit, rl.tokensRemaining, rl.tokensReset,
          rl.requestsLimit, rl.requestsRemaining, rl.requestsReset,
          keyObj.name
        );
      }
      // Also record the usage from this probe
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const usage = body.usage || {};
          recordUsage(keyObj.name, usage, res.statusCode, 0, body.model);
        } catch {}
        resolve({ status: res.statusCode, remaining: rl.tokensRemaining, limit: rl.tokensLimit });
      });
    });

    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(postData);
  });
}

// ─── Server ───
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  // Health check (no auth)
  if (url.pathname === '/health') {
    const states = stmtGetStates.all();
    const now = Date.now();
    const summary = config.keys.filter(k => k.enabled).map(k => {
      const st = states.find(s => s.key_name === k.name) || {};
      return {
        name: k.name,
        remaining: st.rl_tokens_remaining ?? -1,
        blocked: (st.rate_limited_until || 0) > now,
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', keys: summary }));
  }

  // Admin routes
  if (url.pathname.startsWith('/admin')) {
    return handleAdmin(req, res);
  }

  // ─── Proxy routes: require proxy auth ───
  if (!checkProxyAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token' } }));
  }

  const selectedKey = pickKey();
  if (!selectedKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'No API keys available' } }));
  }

  console.log(`[${new Date().toISOString()}] → ${selectedKey.name} | ${req.method} ${req.url}`);
  proxyRequest(req, res, selectedKey);
});

// ─── Auto probe: refresh rate limits every 5 minutes ───
const PROBE_INTERVAL = 5 * 60 * 1000;
async function autoProbeAll() {
  const enabled = config.keys.filter(k => k.enabled);
  for (const k of enabled) {
    try {
      await probeKey(k);
      console.log(`[${new Date().toISOString()}] Auto-probe ${k.name}: OK`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Auto-probe ${k.name}: ${e.message}`);
    }
  }
}
// First probe after 10s, then every 5 min
setTimeout(autoProbeAll, 10_000);
setInterval(autoProbeAll, PROBE_INTERVAL);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Key Proxy v1.0`);
  console.log(`Port: ${PORT} | Keys: ${config.keys.filter(k => k.enabled).length}/${config.keys.length}`);
  console.log(`Proxy auth: ${PROXY_TOKEN ? 'ENABLED' : 'DISABLED (set proxyToken in keys.json)'}`);
  console.log(`Dashboard: http://localhost:${PORT}/admin`);
  console.log(`Strategy: prefer key with least remaining daily quota`);
  console.log(`Auto-probe: every 5 minutes`);
});
