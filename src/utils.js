'use strict';

/**
 * Get today's date string in UTC+8
 */
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract rate limit info from Anthropic response headers
 */
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

/**
 * Extract usage from SSE stream text
 */
function extractStreamUsage(sseText) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    model: null,
  };

  try {
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

    const deltaMatch = sseText.match(/event:\s*message_delta\ndata:\s*(\{.+\})/);
    if (deltaMatch) {
      const d = JSON.parse(deltaMatch[1]);
      usage.output_tokens = d.usage?.output_tokens || 0;
    }
  } catch {}

  return usage;
}

/**
 * Read full request body as string
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

module.exports = { todayStr, extractRateLimitHeaders, extractStreamUsage, readBody };
