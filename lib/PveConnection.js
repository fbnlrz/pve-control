'use strict';

const PveClient = require('./PveClient');

const DEFAULT_INTERVAL = 30;
const MIN_INTERVAL = 5;
const IMMEDIATE_DEBOUNCE = 500;

/**
 * One poller per unique Proxmox endpoint. Calls `/cluster/resources` once per
 * tick and fans the result out to every subscribed device. Also fetches the
 * per-node status and cluster status when node/cluster devices are present
 * (those metrics are not part of `/cluster/resources`). Network counters are
 * cumulative, so throughput rates are derived here and cached across ticks.
 */
class PveConnection {

  constructor(homey, key, config) {
    this.homey = homey;
    this.key = key;
    this.config = config;
    this.client = new PveClient(config);

    this.devices = new Set();
    this._timer = null;
    this._immediateTimer = null;
    this._rates = new Map();
    this._failures = 0;
    this._pollInterval = Math.max(MIN_INTERVAL, Number(config.pollInterval) || DEFAULT_INTERVAL);

    const app = homey.app;
    this._log = app ? app.log.bind(app) : console.log; // eslint-disable-line no-console
    this._error = app ? app.error.bind(app) : console.error; // eslint-disable-line no-console
  }

  /* ----------------------------------------------------------------------- */

  subscribe(device) {
    this.devices.add(device);
    if (!this._timer) {
      this.start();
    } else {
      this._scheduleImmediate();
    }
  }

  unsubscribe(device) {
    this.devices.delete(device);
    this._rates.delete(device.resourceId);
    return this.devices.size;
  }

  setPollInterval(seconds) {
    const next = Math.max(MIN_INTERVAL, Number(seconds) || DEFAULT_INTERVAL);
    if (next === this._pollInterval) return;
    this._pollInterval = next;
    if (this._timer) {
      this.stop();
      this.start();
    }
  }

  start() {
    this.pollOnce().catch((err) => this._error('[PveConnection] initial poll', err.message));
    this._timer = this.homey.setInterval(() => {
      this.pollOnce().catch((err) => this._error('[PveConnection] poll', err.message));
    }, this._pollInterval * 1000);
  }

  stop() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  _scheduleImmediate() {
    if (this._immediateTimer) return;
    this._immediateTimer = this.homey.setTimeout(() => {
      this._immediateTimer = null;
      this.pollOnce().catch((err) => this._error('[PveConnection] immediate poll', err.message));
    }, IMMEDIATE_DEBOUNCE);
  }

  /* ----------------------------------------------------------------------- */

  async pollOnce() {
    let resources;
    try {
      resources = await this.client.getClusterResources();
      this._failures = 0;
    } catch (err) {
      this._failures += 1;
      const reason = this._reasonFor(err);
      for (const device of this.devices) {
        device.setUnavailable(reason).catch(() => {});
      }
      throw err;
    }

    const byId = new Map();
    for (const row of resources) byId.set(row.id, row);

    // Enrich with node/cluster status only when such devices exist.
    const nodeNames = new Set();
    let needCluster = false;
    for (const device of this.devices) {
      if (device.resourceType === 'node' && device.pveNode) nodeNames.add(device.pveNode);
      if (device.resourceType === 'cluster') needCluster = true;
    }

    const nodeStatuses = new Map();
    await Promise.all([...nodeNames].map(async (name) => {
      try {
        nodeStatuses.set(name, await this.client.getNodeStatus(name));
      } catch (err) {
        // Node likely offline; leave unset.
      }
    }));

    let clusterStatus = null;
    if (needCluster) {
      try {
        clusterStatus = await this.client.getClusterStatus();
      } catch (err) {
        // ignore; cluster device handles missing status
      }
    }

    const now = Date.now();
    for (const device of this.devices) {
      try {
        if (device.resourceType === 'cluster') {
          device.setAvailable().catch(() => {});
          device.applyCluster(resources, clusterStatus).catch((err) => this._error(err.message));
          continue;
        }

        const entry = byId.get(device.resourceId);
        if (!entry) {
          device.setUnavailable(this.homey.__('error.not_found')).catch(() => {});
          continue;
        }

        const rates = this._computeRates(device.resourceId, entry, now);
        const nodeStatus = device.resourceType === 'node'
          ? nodeStatuses.get(device.pveNode)
          : null;

        device.setAvailable().catch(() => {});
        device.applyResource(entry, { rates, nodeStatus, resources })
          .catch((err) => this._error(`[${device.getName()}] applyResource`, err.message));
      } catch (err) {
        this._error('[PveConnection] dispatch', err.message);
      }
    }
  }

  _computeRates(id, entry, now) {
    const prev = this._rates.get(id);
    let netin = 0;
    let netout = 0;
    let diskread = 0;
    let diskwrite = 0;
    if (prev && now > prev.ts) {
      const dt = (now - prev.ts) / 1000;
      netin = Math.max(0, ((entry.netin || 0) - prev.netin) / dt);
      netout = Math.max(0, ((entry.netout || 0) - prev.netout) / dt);
      diskread = Math.max(0, ((entry.diskread || 0) - prev.diskread) / dt);
      diskwrite = Math.max(0, ((entry.diskwrite || 0) - prev.diskwrite) / dt);
    }
    this._rates.set(id, {
      netin: entry.netin || 0,
      netout: entry.netout || 0,
      diskread: entry.diskread || 0,
      diskwrite: entry.diskwrite || 0,
      ts: now,
    });
    return {
      netin, netout, diskread, diskwrite,
    };
  }

  _reasonFor(err) {
    if (err && err.isAuthError) return this.homey.__('error.auth');
    if (err && err.isPermissionError) return this.homey.__('error.permission');
    return this.homey.__('error.unreachable');
  }

  destroy() {
    this.stop();
    if (this._immediateTimer) {
      this.homey.clearTimeout(this._immediateTimer);
      this._immediateTimer = null;
    }
    this.devices.clear();
    this._rates.clear();
  }

}

module.exports = PveConnection;
