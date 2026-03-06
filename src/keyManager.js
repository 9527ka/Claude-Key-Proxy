'use strict';

const config = require('./config');
const { stmt } = require('./db');
const { todayStr } = require('./utils');

/**
 * Key selection strategy:
 *
 * 1. Filter out disabled, rate-limited, token-exhausted, and over-limit keys
 * 2. Among keys with known remaining quota, pick the LEAST remaining (use it up before daily reset)
 * 3. If no quota data, pick the least used today
 * 4. If all keys are blocked, pick the one that unblocks soonest
 */
function pickKey() {
  const now = Date.now();
  const today = todayStr();
  const states = stmt.getAllStates.all();
  const stateMap = Object.fromEntries(states.map(s => [s.key_name, s]));

  const candidates = config.getKeys().filter(k => {
    if (!k.enabled) return false;

    const st = stateMap[k.name];
    if (!st) return true;

    // Blocked by Anthropic rate limit
    if (st.rate_limited_until > now) return false;

    // API tokens fully exhausted
    if (st.rl_tokens_remaining === 0) return false;

    // Custom daily token limit reached
    if (k.dailyTokenLimit > 0) {
      const todayTokens = st.daily_date === today
        ? (st.daily_input_tokens || 0) + (st.daily_output_tokens || 0)
        : 0;
      if (todayTokens >= k.dailyTokenLimit) return false;
    }

    return true;
  });

  // All keys blocked — pick the one that unblocks soonest
  if (candidates.length === 0) {
    const enabled = config.getEnabledKeys();
    if (enabled.length === 0) return null;

    enabled.sort((a, b) => {
      const sa = stateMap[a.name] || {};
      const sb = stateMap[b.name] || {};
      return (sa.rate_limited_until || 0) - (sb.rate_limited_until || 0);
    });
    return enabled[0];
  }

  // Prefer keys with known remaining quota (pick least remaining)
  const withQuota = candidates.filter(k => {
    const st = stateMap[k.name];
    return st && st.rl_tokens_remaining > 0;
  });

  if (withQuota.length > 0) {
    withQuota.sort((a, b) => {
      return stateMap[a.name].rl_tokens_remaining - stateMap[b.name].rl_tokens_remaining;
    });
    return withQuota[0];
  }

  // No quota data — pick least used today
  candidates.sort((a, b) => {
    const sa = stateMap[a.name] || {};
    const sb = stateMap[b.name] || {};
    const da = sa.daily_date === today ? (sa.daily_input_tokens || 0) : 0;
    const db = sb.daily_date === today ? (sb.daily_input_tokens || 0) : 0;
    return da - db;
  });
  return candidates[0];
}

module.exports = { pickKey };
