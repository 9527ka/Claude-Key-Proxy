'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'keys.json');

let config = null;

function load() {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return config;
}

function get() {
  if (!config) load();
  return config;
}

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getKeys() {
  return get().keys || [];
}

function getEnabledKeys() {
  return getKeys().filter(k => k.enabled);
}

function getSetting(key, fallback) {
  return get().settings?.[key] ?? fallback;
}

module.exports = { load, get, save, getKeys, getEnabledKeys, getSetting, CONFIG_PATH };
