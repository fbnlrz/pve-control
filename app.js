'use strict';

const Homey = require('homey');
const ConnectionManager = require('./lib/ConnectionManager');
const DiskBalancer = require('./lib/DiskBalancer');

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

    this.log('PVE-Control app has been initialized');
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
  triggerDiskMoved(tokens) {
    try {
      this.homey.flow.getTriggerCard('disk_moved')
        .trigger(tokens)
        .catch((err) => this.error('disk_moved trigger', err.message));
    } catch (err) {
      this.error('disk_moved trigger', err.message);
    }
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
