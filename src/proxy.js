'use strict';

const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { pickKey } = require('./keyManager');
const { recordUsage, updateRateLimits, markRateLimited } = require('./recorder');
const { extractStreamUsage } = require('./utils');
const { stmt } = require('./db');

/**
 * Proxy a client request to Anthropic API with automatic key rotation
 */
function proxyRequest(clientReq, clientRes, selectedKey, retryCount = 0) {
  const startTime = Date.now();
  const upstream = config.getSetting('upstreamUrl', 'https://api.anthropic.com');
  const upstreamUrl = new URL(clientReq.url, upstream);

  // Build upstream headers
  const headers = { ...clientReq.headers };
  delete headers['host'];
  delete headers['x-proxy-token'];
  const proxyToken = config.getSetting('proxyToken', '');
  if (headers['authorization']?.includes(proxyToken)) {
    delete headers['authorization'];
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

    // Always capture rate limit headers
    updateRateLimits(selectedKey.name, proxyRes.headers);

    // ─── Rate limited: retry with another key ───
    if (statusCode === 429 || statusCode === 529) {
      const retryAfter = parseInt(proxyRes.headers['retry-after'] || '60', 10);
      markRateLimited(selectedKey.name, statusCode, retryAfter);
      proxyRes.resume();

      const maxRetries = config.getEnabledKeys().length;
      if (retryCount < maxRetries) {
        const nextKey = pickKey();
        if (nextKey && nextKey.name !== selectedKey.name) {
          console.log(`[${new Date().toISOString()}] ${selectedKey.name} → ${statusCode}, switching to ${nextKey.name}`);
          return proxyRequest(clientReq, clientRes, nextKey, retryCount + 1);
        }
      }

      // All keys exhausted
      clientRes.writeHead(429, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'All API keys rate-limited' },
        retry_after: retryAfter,
      }));

      stmt.logUsage.run(selectedKey.name, Date.now(), null, 0, 0, 0, 0, statusCode, 'rate_limit', Date.now() - startTime);
      return;
    }

    // ─── Forward response ───
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
          recordUsage(selectedKey.name, body.usage || {}, statusCode, Date.now() - startTime, body.model);
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

  // Forward request body (buffered for retries)
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

module.exports = { proxyRequest };
