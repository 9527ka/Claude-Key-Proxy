'use strict';

const config = require('./config');

/**
 * Check if a proxy request carries a valid proxy token
 */
function checkProxyAuth(req) {
  const proxyToken = config.getSetting('proxyToken', '');
  if (!proxyToken) return true;

  // Support multiple auth methods for compatibility with different tools
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${proxyToken}`) return true;

  const headerToken = req.headers['x-proxy-token'];
  if (headerToken === proxyToken) return true;

  // Some tools can only set x-api-key
  const apiKey = req.headers['x-api-key'];
  if (apiKey === proxyToken) return true;

  return false;
}

module.exports = { checkProxyAuth };
