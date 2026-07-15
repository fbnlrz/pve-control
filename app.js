'use strict';

const Homey = require('homey');
const ConnectionManager = require('./lib/ConnectionManager');
const DiskBalancer = require('./lib/DiskBalancer');
const { formatTimestamp } = require('./lib/util');

const NETWORK_STORAGE_TYPES = new Set(['nfs', 'cifs', 'glusterfs', 'cephfs', 'pbs']);

/**
 * Proxmox VE control app.
 *
 * Owns a single {@link ConnectionManager} that de-duplicates Proxmox
 * connections across all drivers and runs exactly one poller per unique
 * endpoint. Devices register/unregister themselves against it.
 */
class PveControlApp extends Homey.App {

  async onInit() {
    this.connections = new ConnectionManager(this.homey);

    this.balancer = new DiskBalancer(this.homey, this.connections);
    this.balancer.start();

    this._registerBalancerAction();
    this._registerGuestActions();
    this._registerWidgets();

    this.log('PVE-Control app has been initialized');
  }

  /* ----------------------------------------------------------------------- */
  /* Widget data providers (read from cached /cluster/resources snapshots)    */
  /* ----------------------------------------------------------------------- */

  getStorages() {
    const rows = [];
    for (const connection of this.connections.connections.values()) {
      for (const r of connection.lastResources || []) {
        if (r.type !== 'storage') continue;
        const used = r.disk || 0;
        const total = r.maxdisk || 0;
        rows.push({
          name: r.storage || r.id,
          node: r.node,
          type: r.plugintype || '',
          usedGb: Math.round((used / (1024 ** 3)) * 10) / 10,
          totalGb: Math.round((total / (1024 ** 3)) * 10) / 10,
          pct: total ? Math.round((used / total) * 100) : 0,
          network: NETWORK_STORAGE_TYPES.has(r.plugintype),
          status: r.status,
        });
      }
    }
    return rows.sort((a, b) => b.pct - a.pct);
  }

  async getNodeSummary(connKey, node) {
    const connection = this.connections.connections.get(connKey);
    if (!connection) return null;
    const r = (connection.lastResources || []).find((x) => x.type === 'node' && x.node === node);
    const summary = {
      node,
      online: r ? r.status === 'online' : false,
      cpu: r && r.maxcpu !== undefined ? Math.round((r.cpu || 0) * 100) : 0,
      mem: r && r.maxmem ? Math.round((r.mem / r.maxmem) * 100) : 0,
      disk: r && r.maxdisk ? Math.round((r.disk / r.maxdisk) * 100) : 0,
      load: null,
      swap: null,
      vms: (connection.lastResources || []).filter((x) => x.type === 'qemu' && x.node === node && x.status === 'running').length,
      cts: (connection.lastResources || []).filter((x) => x.type === 'lxc' && x.node === node && x.status === 'running').length,
    };
    try {
      const status = await connection.client.getNodeStatus(node);
      if (status && Array.isArray(status.loadavg)) summary.load = parseFloat(status.loadavg[0]);
      if (status && status.swap && status.swap.total) summary.swap = Math.round((status.swap.used / status.swap.total) * 100);
    } catch (err) {
      // leave load/swap null
    }
    return summary;
  }

  getGuestSummary(connKey, vmid) {
    const connection = this.connections.connections.get(connKey);
    if (!connection) return null;
    const r = (connection.lastResources || []).find((x) => (x.type === 'qemu' || x.type === 'lxc')
      && String(x.vmid) === String(vmid));
    if (!r) return null;
    return {
      name: r.name || `${r.type} ${vmid}`,
      kind: r.type,
      node: r.node,
      status: r.status,
      running: r.status === 'running',
      cpu: Math.round((r.cpu || 0) * 100),
      mem: r.maxmem ? Math.round((r.mem / r.maxmem) * 100) : 0,
    };
  }

  async widgetGuestAction(connKey, kind, node, vmid, action) {
    const client = this.clientFor(connKey);
    if (!client) throw new Error('Proxmox connection not available');
    await client.guestAction(kind, node, vmid, action);
    return { ok: true };
  }

  getBackupSummary() {
    let total = 0;
    let withBackup = 0;
    let oldest = null;
    const stale = [];
    for (const connection of this.connections.connections.values()) {
      const names = new Map();
      for (const r of connection.lastResources || []) {
        if ((r.type === 'qemu' || r.type === 'lxc') && !r.template) names.set(r.vmid, r.name || `${r.type} ${r.vmid}`);
      }
      for (const [vmid, name] of names) {
        total += 1;
        const backup = connection._backups && connection._backups.get(vmid);
        if (backup && backup.ctime) {
          withBackup += 1;
          if (oldest === null || backup.ctime < oldest) oldest = backup.ctime;
          stale.push({ name, ctime: backup.ctime });
        } else {
          stale.push({ name, ctime: 0 });
        }
      }
    }
    stale.sort((a, b) => a.ctime - b.ctime);
    return {
      total,
      withBackup,
      without: total - withBackup,
      oldest: oldest ? formatTimestamp(oldest) : '—',
      stale: stale.slice(0, 8).map((s) => ({ name: s.name, when: s.ctime ? formatTimestamp(s.ctime) : '—' })),
    };
  }

  _registerWidgets() {
    const register = (widgetId, argName, listFn) => {
      try {
        this.homey.dashboards.getWidget(widgetId).registerSettingAutocompleteListener(argName, async (query) => {
          const list = await listFn();
          const q = (query || '').toLowerCase();
          return list
            .filter((x) => !q || x.name.toLowerCase().includes(q))
            .map((x) => ({ ...x, id: x.vmid != null ? `${x.connKey}:${x.vmid}` : `${x.connKey}:${x.node}` }));
        });
      } catch (err) {
        this.error(`widget ${widgetId} autocomplete`, err.message);
      }
    };
    register('node', 'node', () => this._listNodes());
    register('guest', 'guest', () => this._listGuests());
  }

  /**
   * Aggregate overview across all connections, computed from the cached
   * `/cluster/resources` snapshots (no live API call). Used by the widget.
   */
  getOverview() {
    let nodesOnline = 0;
    let nodesTotal = 0;
    let vmsRunning = 0;
    let vmsTotal = 0;
    let ctsRunning = 0;
    let ctsTotal = 0;
    let cpuUsedCores = 0;
    let cpuTotalCores = 0;
    let memUsed = 0;
    let memTotal = 0;

    for (const connection of this.connections.connections.values()) {
      for (const r of connection.lastResources || []) {
        if (r.type === 'node') {
          nodesTotal += 1;
          if (r.status === 'online') {
            nodesOnline += 1;
            const cores = r.maxcpu || 1;
            cpuUsedCores += (r.cpu || 0) * cores;
            cpuTotalCores += cores;
            memUsed += r.mem || 0;
            memTotal += r.maxmem || 0;
          }
        } else if (r.type === 'qemu' && !r.template) {
          vmsTotal += 1;
          if (r.status === 'running') vmsRunning += 1;
        } else if (r.type === 'lxc' && !r.template) {
          ctsTotal += 1;
          if (r.status === 'running') ctsRunning += 1;
        }
      }
    }

    return {
      nodesOnline,
      nodesTotal,
      vmsRunning,
      vmsTotal,
      ctsRunning,
      ctsTotal,
      cpu: cpuTotalCores ? Math.round((cpuUsedCores / cpuTotalCores) * 100) : 0,
      mem: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* App-level guest / bulk actions (no device needed)                       */
  /* ----------------------------------------------------------------------- */

  clientFor(connKey) {
    const connection = this.connections && this.connections.connections.get(connKey);
    return connection ? connection.client : null;
  }

  async _listGuests() {
    const guests = [];
    for (const [connKey, connection] of this.connections.connections) {
      try {
        const resources = await connection.client.getClusterResources();
        for (const r of resources) {
          if ((r.type === 'qemu' || r.type === 'lxc') && !r.template) {
            guests.push({
              connKey,
              vmid: r.vmid,
              node: r.node,
              kind: r.type,
              name: `${r.name || `${r.type} ${r.vmid}`} (${r.vmid})`,
              description: `${r.type} · ${r.node} · ${r.status}`,
            });
          }
        }
      } catch (err) {
        this.error('[actions] list guests', err.message);
      }
    }
    return guests;
  }

  async _listNodes() {
    const nodes = [];
    for (const [connKey, connection] of this.connections.connections) {
      try {
        const resources = await connection.client.getClusterResources();
        for (const r of resources) {
          if (r.type === 'node') {
            nodes.push({
              connKey, node: r.node, name: r.node, description: r.status,
            });
          }
        }
      } catch (err) {
        this.error('[actions] list nodes', err.message);
      }
    }
    return nodes;
  }

  _registerGuestActions() {
    const filterList = (list, query) => {
      const q = (query || '').toLowerCase();
      return list.filter((x) => !q || x.name.toLowerCase().includes(q));
    };

    const bindGuest = (cardId, action) => {
      try {
        const card = this.homey.flow.getActionCard(cardId);
        card.registerRunListener(async (args) => {
          const g = args.guest;
          const client = this.clientFor(g.connKey);
          if (!client) throw new Error('Proxmox connection not available');
          await client.guestAction(g.kind, g.node, g.vmid, action);
          return true;
        });
        card.registerArgumentAutocompleteListener('guest', async (query) => filterList(await this._listGuests(), query));
      } catch (err) {
        this.error(`${cardId} registration`, err.message);
      }
    };

    bindGuest('start_guest', 'start');
    bindGuest('shutdown_guest', 'shutdown');
    bindGuest('stop_guest', 'stop');

    const bindBulk = (cardId, action, wantStatus) => {
      try {
        const card = this.homey.flow.getActionCard(cardId);
        card.registerRunListener(async (args) => {
          const n = args.node;
          const client = this.clientFor(n.connKey);
          if (!client) throw new Error('Proxmox connection not available');
          const resources = await client.getClusterResources();
          const guests = resources.filter((r) => (r.type === 'qemu' || r.type === 'lxc')
            && r.node === n.node && !r.template && r.status === wantStatus);
          for (const g of guests) {
            // eslint-disable-next-line no-await-in-loop
            await client.guestAction(g.type, g.node, g.vmid, action).catch((err) => this.error(`bulk ${action} ${g.vmid}`, err.message));
          }
          this.log(`[actions] ${cardId} on ${n.node}: ${action} ${guests.length} guest(s)`);
          return true;
        });
        card.registerArgumentAutocompleteListener('node', async (query) => filterList(await this._listNodes(), query));
      } catch (err) {
        this.error(`${cardId} registration`, err.message);
      }
    };

    bindBulk('node_start_all', 'start', 'stopped');
    bindBulk('node_shutdown_all', 'shutdown', 'running');
  }

  _registerBalancerAction() {
    try {
      this.homey.flow.getActionCard('run_balancer').registerRunListener(async () => {
        await this.balancer.runOnce(true);
        return true;
      });
    } catch (err) {
      this.error('run_balancer registration', err.message);
    }
  }

  /**
   * Fire the app-level "a disk was moved" Flow trigger.
   * @param {object} tokens { guest, vmid, disk, from, to }
   */
  _fireTrigger(cardId, tokens) {
    try {
      this.homey.flow.getTriggerCard(cardId)
        .trigger(tokens)
        .catch((err) => this.error(`${cardId} trigger`, err.message));
    } catch (err) {
      this.error(`${cardId} trigger`, err.message);
    }
  }

  triggerDiskMoved(tokens) {
    this._fireTrigger('disk_moved', tokens);
  }

  triggerBackupCompleted(tokens) {
    this._fireTrigger('backup_completed', tokens);
  }

  triggerBackupFailed(tokens) {
    this._fireTrigger('backup_failed', tokens);
  }

  async onUninit() {
    if (this.balancer) {
      this.balancer.stop();
      this.balancer = null;
    }
    if (this.connections) {
      this.connections.destroyAll();
      this.connections = null;
    }
  }

}

module.exports = PveControlApp;
