'use strict';

const Homey = require('homey');
const PveClient = require('./PveClient');
const { parseGuestDisks, storageHasContent, bytesToGb } = require('./util');

/**
 * Shared base class for every Proxmox driver. Subclasses set `this.pveType`
 * (`qemu` | `lxc` | `node` | `storage` | `cluster`) in their `onInit` before
 * calling `super.onInit()`.
 *
 * Handles:
 *  - Flow action/condition run-listeners (only the cards a driver actually
 *    declares get bound; the rest are skipped safely).
 *  - The shared token-based pairing flow (connect → list_devices → add).
 */
class PveDriver extends Homey.Driver {

  async onInit() {
    this._registerFlowListeners();
  }

  /* ----------------------------------------------------------------------- */
  /* Flow                                                                    */
  /* ----------------------------------------------------------------------- */

  _action(id, listener) {
    try {
      this.homey.flow.getActionCard(id).registerRunListener(listener);
      return this.homey.flow.getActionCard(id);
    } catch (err) {
      return null; // card not declared for this driver
    }
  }

  _condition(id, listener) {
    try {
      this.homey.flow.getConditionCard(id).registerRunListener(listener);
    } catch (err) {
      // card not declared for this driver
    }
  }

  _registerFlowListeners() {
    // Flow-card ids must be unique across the whole app, so guest cards are
    // prefixed with the driver type (e.g. `qemu_start`, `lxc_start`). Only the
    // cards a driver actually declares get bound; the rest are skipped.
    if (this.pveType === 'qemu' || this.pveType === 'lxc') {
      this._registerGuestFlow(this.pveType);
    }

    if (this.pveType === 'node') {
      this._action('node_reboot', async (args) => {
        await args.device.client.nodeCommand(args.device.pveNode, 'reboot');
        return true;
      });
      this._action('node_shutdown', async (args) => {
        await args.device.client.nodeCommand(args.device.pveNode, 'shutdown');
        return true;
      });
    }

    if (this.pveType === 'cluster') {
      this._condition('is_quorate', async (args) => args.device.getCapabilityValue('alarm_quorum') !== true);
    }
  }

  _registerGuestFlow(prefix) {
    const guestAction = (action) => async (args) => {
      const d = args.device;
      await d.client.guestAction(d.resourceType, d.pveNode, d.vmid, action);
      return true;
    };

    ['start', 'shutdown', 'stop', 'reboot', 'reset', 'suspend', 'resume'].forEach((action) => {
      this._action(`${prefix}_${action}`, guestAction(action));
    });

    this._action(`${prefix}_create_snapshot`, async (args) => {
      const d = args.device;
      const upid = await d.client.createSnapshot(d.resourceType, d.pveNode, d.vmid, {
        snapname: args.name,
        description: args.description || '',
        vmstate: Boolean(args.vmstate),
      });
      if (args.wait && typeof upid === 'string') {
        await d.client.waitForTask(d.pveNode, upid);
      }
      return true;
    });

    const rollbackCard = this._action(`${prefix}_rollback_snapshot`, async (args) => {
      const d = args.device;
      const name = args.snapshot && args.snapshot.name;
      if (!name) throw new Error('No snapshot selected');
      await d.client.rollbackSnapshot(d.resourceType, d.pveNode, d.vmid, name);
      return true;
    });
    if (rollbackCard) {
      rollbackCard.registerArgumentAutocompleteListener('snapshot', async (query, args) => {
        const d = args.device;
        const snaps = await d.client.listSnapshots(d.resourceType, d.pveNode, d.vmid);
        return (snaps || [])
          .filter((s) => s.name && s.name !== 'current')
          .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
          .map((s) => ({ name: s.name, description: s.description || '' }));
      });
    }

    this._condition(`${prefix}_is_running`, async (args) => args.device.getCapabilityValue('pve_status') === 'running');

    this._registerMoveFlow(prefix);
  }

  _registerMoveFlow(prefix) {
    const isQemu = prefix === 'qemu';
    const moveCardId = isQemu ? 'qemu_move_disk' : 'lxc_move_volume';
    const selArg = isQemu ? 'disk' : 'volume';
    const contentType = isQemu ? 'images' : 'rootdir';

    const moveCard = this._action(moveCardId, async (args) => {
      const d = args.device;
      const selection = args[selArg];
      const key = selection && selection.key;
      const storage = args.storage && args.storage.storage;
      if (!key || !storage) throw new Error('Select a disk/volume and a target storage');
      const del = args.delete_source !== false;
      await d.client.moveGuestVolume(d.resourceType, d.pveNode, d.vmid, { key, storage, delete: del });
      if (this.homey.app.triggerDiskMoved) {
        this.homey.app.triggerDiskMoved({
          guest: d.getName(),
          vmid: d.vmid || 0,
          disk: key,
          from: (selection && selection.currentStorage) || '',
          to: storage,
        });
      }
      return true;
    });

    if (!moveCard) return;

    moveCard.registerArgumentAutocompleteListener(selArg, async (query, args) => {
      const d = args.device;
      const config = await d.client.getGuestConfig(d.resourceType, d.pveNode, d.vmid);
      const disks = parseGuestDisks(d.resourceType, config);
      const q = (query || '').toLowerCase();
      return disks
        .filter((x) => !q || x.key.toLowerCase().includes(q) || x.storage.toLowerCase().includes(q))
        .map((x) => ({
          name: `${x.key} · ${x.sizeText || '?'} · ${x.storage}`,
          description: x.volid,
          key: x.key,
          currentStorage: x.storage,
        }));
    });

    moveCard.registerArgumentAutocompleteListener('storage', async (query, args) => {
      const d = args.device;
      const current = args[selArg] && args[selArg].currentStorage;
      const storages = await d.client.getNodeStorages(d.pveNode, contentType);
      const q = (query || '').toLowerCase();
      return (storages || [])
        .filter((s) => s.enabled !== 0 && s.active !== 0)
        .filter((s) => storageHasContent(s, contentType))
        .filter((s) => s.storage !== current)
        .filter((s) => !q || s.storage.toLowerCase().includes(q))
        .map((s) => ({
          name: `${s.storage} · ${bytesToGb(s.avail) ?? '?'} GB free`,
          description: s.type,
          storage: s.storage,
        }));
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Pairing                                                                 */
  /* ----------------------------------------------------------------------- */

  async onPair(session) {
    let pairConfig = null;

    session.setHandler('getDefaults', async () => ({
      host: this.homey.settings.get('defaultHost') || '',
      port: this.homey.settings.get('defaultPort') || 8006,
      tokenId: this.homey.settings.get('defaultTokenId') || '',
      tokenSecret: this.homey.settings.get('defaultTokenSecret') || '',
      verifyTls: this.homey.settings.get('defaultVerifyTls') || false,
    }));

    session.setHandler('validate', async (creds) => {
      const config = this._normalizeCreds(creds);
      const client = new PveClient(config);
      const version = await client.getVersion(); // throws PveError on failure
      const clusterKey = await this._deriveClusterKey(client);
      pairConfig = { ...config, clusterKey };
      return { version: version && version.version ? version.version : 'unknown' };
    });

    session.setHandler('list_devices', async () => {
      if (!pairConfig) throw new Error(this.homey.__('pair.not_connected'));
      const client = new PveClient(pairConfig);
      const resources = await client.getClusterResources();
      return this.buildPairDevices(resources, pairConfig);
    });
  }

  _normalizeCreds(creds = {}) {
    return {
      host: (creds.host || '').trim(),
      port: Number(creds.port) || 8006,
      tokenId: (creds.tokenId || '').trim(),
      tokenSecret: (creds.tokenSecret || '').trim(),
      verifyTls: Boolean(creds.verifyTls),
      ca: creds.ca || null,
    };
  }

  async _deriveClusterKey(client) {
    try {
      const status = await client.getClusterStatus();
      const cluster = (status || []).find((s) => s.type === 'cluster');
      if (cluster && cluster.name) return cluster.name;
    } catch (err) {
      // not clustered / no permission — fall through
    }
    try {
      const nodes = await client.getNodes();
      if (nodes && nodes[0] && nodes[0].node) return `standalone-${nodes[0].node}`;
    } catch (err) {
      // ignore
    }
    return `pve-${client.host}`;
  }

  /**
   * Default: filter `/cluster/resources` by this driver's type and map each
   * row to a Homey pairing device. Overridden by the cluster driver.
   */
  buildPairDevices(resources, config) {
    return (resources || [])
      .filter((r) => r.type === this.pveType)
      .filter((r) => !r.template)
      .map((r) => this.resourceToPairDevice(r, config));
  }

  resourceToPairDevice(r, config) {
    let idPart;
    let name;
    if (r.type === 'node') {
      idPart = r.node;
      name = r.node;
    } else if (r.type === 'storage') {
      idPart = `${r.node}-${r.storage}`;
      name = `${r.storage} (${r.node})`;
    } else {
      idPart = r.vmid;
      name = r.name || `${r.type} ${r.vmid}`;
    }

    const store = {
      host: config.host,
      port: config.port,
      tokenId: config.tokenId,
      tokenSecret: config.tokenSecret,
      verifyTls: config.verifyTls,
      ca: config.ca || null,
      node: r.node || null,
      vmid: r.vmid || null,
      storage: r.storage || null,
      resourceType: r.type,
      resourceId: r.id,
      clusterKey: config.clusterKey,
    };

    const settings = {
      host: config.host,
      port: String(config.port),
      tokenId: config.tokenId,
      tokenSecret: config.tokenSecret,
      verifyTls: Boolean(config.verifyTls),
      ca: config.ca || '',
      pollInterval: 30,
    };

    return {
      name,
      data: { id: `${config.clusterKey}/${r.type}/${idPart}` },
      store,
      settings,
    };
  }

}

module.exports = PveDriver;
