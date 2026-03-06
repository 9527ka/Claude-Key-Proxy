'use strict';

const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { recordUsage, updateRateLimits } = require('./recorder');

/**
 * Send a minimal request to Anthropic to fetch rate limit headers for a key
 */
function probeKey(keyObj) {
  const upstream = config.getSetting('upstreamUrl', 'https://api.anthropic.com');

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const options = {
      hostname: new URL(upstream).hostname,
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
      updateRateLimits(keyObj.name, res.headers);

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          recordUsage(keyObj.name, body.usage || {}, res.statusCode, 0, body.model);
        } catch {}
        resolve({ status: res.statusCode });
      });
    });

    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end(postData);
  });
}

/**
 * Probe all enabled keys
 */
async function probeAllKeys() {
  const enabled = config.getEnabledKeys();
  const results = {};

  await Promise.all(enabled.map(async (k) => {
    try {
      results[k.name] = await probeKey(k);
      console.log(`[${new Date().toISOString()}] Probe ${k.name}: OK`);
    } catch (e) {
      results[k.name] = { status: 0, error: e.message };
      console.error(`[${new Date().toISOString()}] Probe ${k.name}: ${e.message}`);
    }
  }));

  return results;
}

module.exports = { probeKey, probeAllKeys };
