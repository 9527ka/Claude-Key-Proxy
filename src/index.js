#!/usr/bin/env node
'use strict';

const http = require('http');
const { URL } = require('url');
const config = require('./config');
const { stmt } = require('./db');
const { checkProxyAuth } = require('./auth');
const { pickKey } = require('./keyManager');
const { proxyRequest } = require('./proxy');
const { handleAdmin } = require('./admin');
const { probeAllKeys } = require('./probe');

// ─── Load Config & Init DB ───

config.load();
for (const k of config.getKeys()) {
  stmt.ensureKey.run(k.name);
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
    const states = stmt.getAllStates.all();
    const now = Date.now();
    const summary = config.getEnabledKeys().map(k => {
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

  // Proxy routes (require auth)
  if (!checkProxyAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid proxy token' },
    }));
  }

  const selectedKey = pickKey();
  if (!selectedKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'No API keys available' },
    }));
  }

  console.log(`[${new Date().toISOString()}] → ${selectedKey.name} | ${req.method} ${req.url}`);
  proxyRequest(req, res, selectedKey);
});

// ─── Auto Probe ───

const PROBE_INTERVAL = 5 * 60 * 1000; // 5 minutes
setTimeout(probeAllKeys, 10_000);
setInterval(probeAllKeys, PROBE_INTERVAL);

// ─── Start ───

const PORT = config.getSetting('port', 9876);
server.listen(PORT, '0.0.0.0', () => {
  const keys = config.getKeys();
  const enabled = config.getEnabledKeys();
  console.log(`
  ╔══════════════════════════════════════╗
  ║     🐵 Claude Key Proxy v1.0        ║
  ╠══════════════════════════════════════╣
  ║  Port:       ${String(PORT).padEnd(23)}║
  ║  Keys:       ${(enabled.length + '/' + keys.length + ' enabled').padEnd(23)}║
  ║  Auth:       ${(config.getSetting('proxyToken') ? 'ON' : 'OFF').padEnd(23)}║
  ║  Auto-probe: every 5 min            ║
  ║  Dashboard:  /admin                 ║
  ╚══════════════════════════════════════╝
  `);
});
