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
 * Convert bytes into GiB (labelled "GB" in the UI).
 */
function bytesToGb(bytes, decimals = 2) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return null;
  return round(Number(bytes) / (1024 ** 3), decimals);
}

const QEMU_DISK_RE = /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/;
const LXC_VOLUME_RE = /^(rootfs|mp\d+)$/;
const SIZE_MULTIPLIER = {
  K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4,
};

/**
 * Parse a Proxmox size token (e.g. "32G", "528K") into bytes.
 */
function sizeToBytes(num, unit) {
  const n = parseFloat(num);
  if (Number.isNaN(n)) return null;
  return unit ? Math.round(n * (SIZE_MULTIPLIER[unit.toUpperCase()] || 1)) : Math.round(n);
}

/**
 * Parse a single disk/volume config value, e.g.
 * "local-lvm:vm-100-disk-0,size=32G,ssd=1". Returns null for cdrom media,
 * bind mounts or values that are not storage-backed.
 */
function parseDiskValue(value) {
  if (!value || typeof value !== 'string') return null;
  const volid = value.split(',')[0];
  if (!volid.includes(':')) return null;
  if (value.includes('media=cdrom')) return null;
  const storage = volid.split(':')[0];
  if (!storage || storage.startsWith('/')) return null;
  const match = value.match(/(?:^|,)size=([\d.]+)([KMGTkmgt])?/);
  const sizeBytes = match ? sizeToBytes(match[1], match[2]) : null;
  const sizeText = match ? `${match[1]}${(match[2] || '').toUpperCase()}` : null;
  return {
    volid, storage, sizeBytes, sizeText,
  };
}

/**
 * Extract the movable, storage-backed disks/volumes from a guest config.
 * @param {'qemu'|'lxc'} kind
 * @returns {Array<{key, volid, storage, sizeBytes, sizeText}>}
 */
function parseGuestDisks(kind, config) {
  const re = kind === 'qemu' ? QEMU_DISK_RE : LXC_VOLUME_RE;
  const disks = [];
  for (const [key, value] of Object.entries(config || {})) {
    if (!re.test(key)) continue;
    const parsed = parseDiskValue(value);
    if (!parsed) continue;
    disks.push({ key, ...parsed });
  }
  return disks;
}

/**
 * Whether a Proxmox storage's content string includes a given content type.
 */
function storageHasContent(storage, contentType) {
  if (!storage || !storage.content) return false;
  return String(storage.content).split(',').map((c) => c.trim()).includes(contentType);
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
  bytesToGb,
  sizeToBytes,
  parseDiskValue,
  parseGuestDisks,
  storageHasContent,
  formatUptime,
};
