'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('./config');
const { db, stmt } = require('./db');
const { todayStr, readBody } = require('./utils');
const { probeKey } = require('./probe');

const DASHBOARD_PATH = path.join(__dirname, '..', 'public', 'dashboard.html');

/**
 * Handle all /admin/* routes
 */
async function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Dashboard page (auth happens client-side)
  if (p === '/admin' || p === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  }

  // All API routes require admin token
  const adminToken = config.getSetting('adminToken', '');
  const token = url.searchParams.get('token') || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== adminToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  // ─── Route: GET /admin/api/status ───
  if (p === '/admin/api/status' && req.method === 'GET') {
    return handleStatus(res);
  }

  // ─── Route: GET /admin/api/logs ───
  if (p === '/admin/api/logs' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const rows = stmt.getLogs.all(limit);
    return json(res, rows);
  }

  // ─── Route: POST /admin/api/keys ───
  if (p === '/admin/api/keys' && req.method === 'POST') {
    return handleAddKey(req, res);
  }

  // ─── Route: PATCH /admin/api/keys/:name ───
  if (p.startsWith('/admin/api/keys/') && req.method === 'PATCH') {
    const keyName = decodeURIComponent(p.split('/').pop());
    return handleUpdateKey(req, res, keyName);
  }

  // ─── Route: DELETE /admin/api/keys/:name ───
  if (p.startsWith('/admin/api/keys/') && req.method === 'DELETE') {
    const keyName = decodeURIComponent(p.split('/').pop());
    return handleDeleteKey(res, keyName);
  }

  // ─── Route: POST /admin/api/probe ───
  if (p === '/admin/api/probe' && req.method === 'POST') {
    return handleProbe(req, res);
  }

  // ─── Route: POST /admin/api/reset ───
  if (p === '/admin/api/reset' && req.method === 'POST') {
    return handleReset(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─── Handlers ───

function handleStatus(res) {
  const states = stmt.getAllStates.all();
  const today = todayStr();

  const keys = config.getKeys().map(k => {
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

      dailyInputTokens: isToday ? (st.daily_input_tokens || 0) : 0,
      dailyOutputTokens: isToday ? (st.daily_output_tokens || 0) : 0,
      dailyRequests: isToday ? (st.daily_requests || 0) : 0,
      dailyTokenLimit: k.dailyTokenLimit || 0,

      rlTokensLimit: st.rl_tokens_limit || 0,
      rlTokensRemaining: st.rl_tokens_remaining ?? -1,
      rlTokensReset: st.rl_tokens_reset || null,
      rlRequestsLimit: st.rl_requests_limit || 0,
      rlRequestsRemaining: st.rl_requests_remaining ?? -1,
      rlRequestsReset: st.rl_requests_reset || null,

      rateLimitedUntil: st.rate_limited_until || 0,
      lastError: st.last_error || null,
      lastUsed: st.last_used || 0,

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

  return json(res, { keys, uptime: process.uptime(), today });
}

async function handleAddKey(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !body.key) throw new Error('name and key required');
    if (config.getKeys().find(k => k.name === body.name)) throw new Error('Key name already exists');

    config.get().keys.push({
      name: body.name,
      key: body.key,
      enabled: body.enabled !== false,
    });
    stmt.ensureKey.run(body.name);
    config.save();
    return json(res, { ok: true });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
}

async function handleUpdateKey(req, res, keyName) {
  try {
    const updates = JSON.parse(await readBody(req));
    const keys = config.getKeys();
    const idx = keys.findIndex(k => k.name === keyName);
    if (idx === -1) throw new Error('Key not found');

    if ('enabled' in updates) keys[idx].enabled = updates.enabled;
    if ('name' in updates) keys[idx].name = updates.name;
    if ('key' in updates) keys[idx].key = updates.key;
    if ('dailyTokenLimit' in updates) keys[idx].dailyTokenLimit = parseInt(updates.dailyTokenLimit, 10) || 0;

    config.save();
    return json(res, { ok: true });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
}

function handleDeleteKey(res, keyName) {
  config.get().keys = config.getKeys().filter(k => k.name !== keyName);
  config.save();
  return json(res, { ok: true });
}

async function handleProbe(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const targets = body.keyName
      ? config.getKeys().filter(k => k.name === body.keyName)
      : config.getEnabledKeys();

    if (targets.length === 0) throw new Error('No keys to probe');

    const results = {};
    await Promise.all(targets.map(async (k) => {
      results[k.name] = await probeKey(k);
    }));

    return json(res, { ok: true, results });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
}

async function handleReset(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (body.keyName) {
      stmt.deleteLogsByKey.run(body.keyName);
      stmt.deleteStateByKey.run(body.keyName);
      stmt.ensureKey.run(body.keyName);
    } else {
      db.exec(`DELETE FROM usage_log; DELETE FROM key_state;`);
      for (const k of config.getKeys()) stmt.ensureKey.run(k.name);
    }
    return json(res, { ok: true });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
}

// ─── Helpers ───

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = { handleAdmin };
