'use strict';

const { stmt } = require('./db');
const { todayStr, extractRateLimitHeaders } = require('./utils');

/**
 * Record token usage for a key
 */
function recordUsage(keyName, usage, statusCode, durationMs, model) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const m = model || usage.model || null;
  const today = todayStr();

  stmt.logUsage.run(
    keyName, Date.now(), m,
    input, output, cacheCreation, cacheRead,
    statusCode, null, durationMs
  );

  stmt.updateUsage.run(
    input, output, cacheCreation, cacheRead, Date.now(),
    today, input, input,
    today, output, output,
    today,
    today,
    keyName
  );
}

/**
 * Update rate limit info from Anthropic response headers
 */
function updateRateLimits(keyName, headers) {
  const rl = extractRateLimitHeaders(headers);
  if (rl.tokensRemaining >= 0) {
    stmt.updateRateLimit.run(
      rl.tokensLimit, rl.tokensRemaining, rl.tokensReset,
      rl.requestsLimit, rl.requestsRemaining, rl.requestsReset,
      keyName
    );
  }
  return rl;
}

/**
 * Mark a key as rate-limited
 */
function markRateLimited(keyName, statusCode, retryAfterSec) {
  const blockedUntil = Date.now() + retryAfterSec * 1000;
  stmt.setBlocked.run(blockedUntil, `${statusCode}`, keyName);
}

module.exports = { recordUsage, updateRateLimits, markRateLimited };
