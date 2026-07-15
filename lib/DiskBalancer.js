'use strict';

const { parseGuestDisks, storageHasContent, bytesToGb } = require('./util');

const DEFAULTS = {
  enabled: false,
  dryRun: true,
  highPct: 85,
  lowPct: 70,
  intervalMin: 30,
  minGb: 5,
  bwLimit: 0, // KB/s, 0 = unlimited
};

const FIRST_RUN_DELAY_MS = 90 * 1000;

// Network / remote storage types that are excluded as a balancing TARGET by
// default (moving VM disks onto a network share is usually undesirable).
// They remain valid as a source, so a full share can still be relieved.
const NETWORK_STORAGE_TYPES = new Set(['nfs', 'cifs', 'glusterfs', 'cephfs', 'pbs']);

/**
 * Optional, opt-in storage balancer. When a node has an image storage above
 * the high-water mark, it moves the largest movable disk from that storage to
 * the emptiest eligible target (below the low-water mark) on the same node.
 *
 * Guardrails:
 *  - disabled by default; dry-run enabled by default (logs, never moves);
 *  - at most one move per node per run;
 *  - only moves a disk that fits in the target (with a 10% margin);
 *  - skips running LXC containers (their volumes require a stopped container);
 *  - never overlaps runs.
 */
class DiskBalancer {

  constructor(homey, connectionManager) {
    this.homey = homey;
    this.connections = connectionManager;
    this._timer = null;
    this._firstRunTimer = null;
    this._running = false;
    this._onSettingsSet = this._reschedule.bind(this);
  }

  _settings() {
    const get = (key, fallback) => {
      const value = this.homey.settings.get(key);
      return value === undefined || value === null ? fallback : value;
    };
    return {
      enabled: Boolean(get('autoBalanceEnabled', DEFAULTS.enabled)),
      dryRun: get('balanceDryRun', DEFAULTS.dryRun) !== false,
      highPct: Number(get('balanceHighPct', DEFAULTS.highPct)) || DEFAULTS.highPct,
      lowPct: Number(get('balanceLowPct', DEFAULTS.lowPct)) || DEFAULTS.lowPct,
      intervalMin: Math.max(5, Number(get('balanceIntervalMin', DEFAULTS.intervalMin)) || DEFAULTS.intervalMin),
      minGb: Math.max(0, Number(get('balanceMinGb', DEFAULTS.minGb)) || 0),
      bwLimit: Math.max(0, Number(get('balanceBwLimit', DEFAULTS.bwLimit)) || 0),
      excludeStorages: String(get('balanceExcludeStorages', '') || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      includeNetwork: Boolean(get('balanceIncludeNetwork', false)),
    };
  }

  start() {
    this.homey.settings.on('set', this._onSettingsSet);
    this._schedule();
  }

  stop() {
    this.homey.settings.removeListener('set', this._onSettingsSet);
    this._clearTimers();
  }

  _clearTimers() {
    if (this._timer) { this.homey.clearInterval(this._timer); this._timer = null; }
    if (this._firstRunTimer) { this.homey.clearTimeout(this._firstRunTimer); this._firstRunTimer = null; }
  }

  _reschedule() {
    this._clearTimers();
    this._schedule();
  }

  _schedule() {
    const cfg = this._settings();
    if (!cfg.enabled) {
      this.homey.app.log('[balancer] disabled');
      return;
    }
    this.homey.app.log(`[balancer] enabled (dryRun=${cfg.dryRun}, every ${cfg.intervalMin}min, high=${cfg.highPct}%, low=${cfg.lowPct}%)`);
    this._firstRunTimer = this.homey.setTimeout(() => {
      this.runOnce().catch((err) => this.homey.app.error('[balancer]', err.message));
    }, FIRST_RUN_DELAY_MS);
    this._timer = this.homey.setInterval(() => {
      this.runOnce().catch((err) => this.homey.app.error('[balancer]', err.message));
    }, cfg.intervalMin * 60 * 1000);
  }

  async runOnce() {
    const cfg = this._settings();
    if (!cfg.enabled || this._running) return;
    this._running = true;
    try {
      for (const connection of this.connections.connections.values()) {
        try {
          await this._balanceEndpoint(connection.client, cfg);
        } catch (err) {
          this.homey.app.error('[balancer] endpoint', err.message);
        }
      }
    } finally {
      this._running = false;
    }
  }

  async _balanceEndpoint(client, cfg) {
    const resources = await client.getClusterResources();
    const typeByVmid = new Map();
    for (const r of resources) {
      if (r.type === 'qemu' || r.type === 'lxc') typeByVmid.set(r.vmid, r.type);
    }
    const nodes = (resources || []).filter((r) => r.type === 'node' && r.status === 'online');
    for (const node of nodes) {
      try {
        await this._balanceNode(client, node.node, cfg, typeByVmid);
      } catch (err) {
        this.homey.app.error(`[balancer] node ${node.node}`, err.message);
      }
    }
  }

  async _balanceNode(client, node, cfg, typeByVmid) {
    const storages = (await client.getNodeStorages(node, 'images')) || [];
    const eligible = storages
      .filter((s) => s.enabled !== 0 && s.active !== 0 && Number(s.total) > 0)
      .filter((s) => storageHasContent(s, 'images'))
      .map((s) => ({ ...s, pct: (Number(s.used) / Number(s.total)) * 100 }));

    const source = eligible
      .filter((s) => s.pct >= cfg.highPct && Number(s.used) > 0)
      .sort((a, b) => b.pct - a.pct)[0];
    if (!source) return;

    const targets = eligible
      .filter((s) => s.storage !== source.storage && s.pct < cfg.lowPct)
      .filter((s) => !cfg.excludeStorages.includes(s.storage))
      .filter((s) => cfg.includeNetwork || !NETWORK_STORAGE_TYPES.has(s.type))
      .sort((a, b) => Number(b.avail) - Number(a.avail));
    if (!targets.length) {
      this.homey.app.log(`[balancer] ${node}: ${source.storage} at ${source.pct.toFixed(0)}% but no eligible target below ${cfg.lowPct}% (network shares excluded by default)`);
      return;
    }

    const minBytes = cfg.minGb * (1024 ** 3);
    const volumes = ((await client.getStorageContent(node, source.storage, 'images')) || [])
      .filter((v) => v.vmid && Number(v.size) >= minBytes)
      .sort((a, b) => Number(b.size) - Number(a.size));

    for (const vol of volumes) {
      const kind = typeByVmid.get(vol.vmid);
      if (!kind) continue;

      const target = targets.find((t) => Number(t.avail) > Number(vol.size) * 1.1);
      if (!target) continue;

      // Map the storage volume back to its disk key in the guest config.
      const config = await client.getGuestConfig(kind, node, vol.vmid);
      const disks = parseGuestDisks(kind, config);
      const disk = disks.find((d) => d.volid === vol.volid);
      if (!disk) continue;

      if (kind === 'lxc') {
        const status = await client.getGuestStatus('lxc', node, vol.vmid);
        if (status && status.status === 'running') {
          this.homey.app.log(`[balancer] ${node}: skip CT ${vol.vmid} (running, volume move needs stop)`);
          continue;
        }
      }

      const sizeGb = bytesToGb(vol.size);
      const summary = `${kind} ${vol.vmid} ${disk.key} (${sizeGb} GB) ${source.storage} -> ${target.storage}`;

      if (cfg.dryRun) {
        this.homey.app.log(`[balancer] DRY-RUN would move ${summary}`);
        return; // one candidate per node per run
      }

      this.homey.app.log(`[balancer] moving ${summary}`);
      await client.moveGuestVolume(kind, node, vol.vmid, {
        key: disk.key,
        storage: target.storage,
        delete: true,
        bwlimit: cfg.bwLimit || undefined,
      });
      if (this.homey.app.triggerDiskMoved) {
        this.homey.app.triggerDiskMoved({
          guest: `${kind} ${vol.vmid}`,
          vmid: vol.vmid,
          disk: disk.key,
          from: source.storage,
          to: target.storage,
        });
      }
      return; // one move per node per run
    }

    this.homey.app.log(`[balancer] ${node}: ${source.storage} full but no movable disk fits a target`);
  }

}

module.exports = DiskBalancer;
