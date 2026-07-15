'use strict';

const crypto = require('crypto');

/**
 * Stable key that identifies a Proxmox endpoint independently of the
 * (rotatable) token secret, so all devices pointing at the same
 * host/port/token principal share one poller.
 * @param {object} config
 * @returns {string}
 */
function connKey({ host, port = 8006, tokenId = '' } = {}) {
  const raw = `${String(host || '').trim().toLowerCase()}:${port}:${tokenId}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * Round a number to a fixed number of decimals, passing through null-ish values.
 */
function round(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * Percentage of used/total, guarding against missing/zero totals.
 */
function pct(used, total, decimals = 1) {
  if (!total || Number(total) <= 0 || used === null || used === undefined) return null;
  return round((Number(used) / Number(total)) * 100, decimals);
}

/**
 * Convert a Proxmox cpu fraction (0..1) into a percentage.
 */
function fromFraction(fraction, decimals = 1) {
  if (fraction === null || fraction === undefined || Number.isNaN(Number(fraction))) return null;
  return round(Number(fraction) * 100, decimals);
}

/**
 * Convert a byte-rate into Mbit/s.
 */
function bytesToMbit(bytesPerSecond, decimals = 2) {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return null;
  return round((Number(bytesPerSecond) * 8) / 1e6, decimals);
}

/**
 * Human readable uptime, e.g. "3d 4h" / "5h 12m" / "8m".
 */
function formatUptime(seconds) {
  const s = Number(seconds);
  if (!s || s <= 0) return '—';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

module.exports = {
  connKey,
  round,
  pct,
  fromFraction,
  bytesToMbit,
  formatUptime,
};
