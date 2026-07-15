'use strict';

const Homey = require('homey');
const {
  fromFraction, pct, round, bytesToMbit, bytesToMbyte, bytesToGb, formatUptime, extractGuestIp,
} = require('./util');

const IP_REFRESH_MS = 5 * 60 * 1000;

const CONNECTION_SETTING_KEYS = ['host', 'port', 'tokenId', 'tokenSecret', 'verifyTls', 'ca', 'pollInterval'];

/**
 * Shared base class for every Proxmox device (qemu, lxc, node, storage).
 * The cluster device extends this too but overrides {@link applyCluster}.
 *
 * Devices are passive: the per-connection poller pushes fresh data in through
 * {@link applyResource}. Homey→Proxmox control (start/stop) goes through the
 * registered `onoff` capability listener and the driver's flow actions.
 */
class PveDevice extends Homey.Device {

  async onInit() {
    const store = this.getStore() || {};
    this.resourceType = store.resourceType || this.driver.pveType;
    this.pveNode = store.node || null;
    this.vmid = store.vmid || null;
    this.resourceId = store.resourceId || this._deriveResourceId(store);
    this._lastStatus = undefined;

    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', (value) => this._onOnoff(value));
    }

    this.connection = this.homey.app.connections.register(this);
    this.log(`Initialized ${this.resourceType} "${this.getName()}" (${this.resourceId})`);
  }

  _deriveResourceId(store) {
    if (this.resourceType === 'node') return `node/${store.node}`;
    if (this.resourceType === 'cluster') return 'cluster';
    if (this.resourceType === 'storage' && store.storage) return `storage/${store.node}/${store.storage}`;
    return `${this.resourceType}/${store.vmid}`;
  }

  get client() {
    return this.connection ? this.connection.client : null;
  }

  /* ----------------------------------------------------------------------- */
  /* Homey -> Proxmox                                                        */
  /* ----------------------------------------------------------------------- */

  async _onOnoff(value) {
    const action = value ? 'start' : 'shutdown';
    await this.client.guestAction(this.resourceType, this.pveNode, this.vmid, action);
    // Optimistic: the next poll reconciles the real state.
  }

  /* ----------------------------------------------------------------------- */
  /* Proxmox -> Homey                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Map a `/cluster/resources` row (plus optional node status) onto
   * capabilities. Shared logic for qemu/lxc/node/storage.
   */
  async applyResource(entry, { rates, nodeStatus, resources } = {}) {
    const status = entry.status;
    await this.setCap('pve_status', status);

    if (this.hasCapability('onoff')) {
      await this.setCap('onoff', status === 'running');
    }

    if (entry.cpu !== undefined && this.hasCapability('measure_cpu')) {
      await this.setCap('measure_cpu', fromFraction(entry.cpu));
    }
    if (entry.maxmem && this.hasCapability('measure_memory')) {
      await this.setCap('measure_memory', pct(entry.mem, entry.maxmem));
    }
    if (entry.mem !== undefined && this.hasCapability('measure_ram_used')) {
      await this.setCap('measure_ram_used', bytesToGb(entry.mem));
    }

    if (this.resourceType === 'storage') {
      if (this.hasCapability('measure_disk_used')) {
        await this.setCap('measure_disk_used', bytesToGb(entry.disk));
      }
      if (this.hasCapability('measure_disk_free') && entry.maxdisk) {
        await this.setCap('measure_disk_free', bytesToGb(entry.maxdisk - entry.disk));
      }
    }

    if (this.hasCapability('measure_disk')) {
      if (this.resourceType === 'node' || this.resourceType === 'storage') {
        await this.setCap('measure_disk', pct(entry.disk, entry.maxdisk));
      } else if (entry.maxdisk && entry.disk > 0) {
        // Guests only report real disk usage when the guest agent is running.
        await this.setCap('measure_disk', pct(entry.disk, entry.maxdisk));
      } else {
        await this.setCap('measure_disk', null);
      }
    }

    if ('uptime' in entry && this.hasCapability('uptime_text')) {
      await this.setCap('uptime_text', formatUptime(entry.uptime));
    }

    if (rates) {
      await this.setCap('measure_netin', bytesToMbit(rates.netin));
      await this.setCap('measure_netout', bytesToMbit(rates.netout));
      await this.setCap('measure_diskread', bytesToMbyte(rates.diskread));
      await this.setCap('measure_diskwrite', bytesToMbyte(rates.diskwrite));
    }

    if (this.resourceType === 'node') {
      if (nodeStatus) {
        if (Array.isArray(nodeStatus.loadavg) && this.hasCapability('measure_load')) {
          await this.setCap('measure_load', round(parseFloat(nodeStatus.loadavg[0]), 2));
        }
        if (nodeStatus.swap && nodeStatus.swap.total && this.hasCapability('measure_swap')) {
          await this.setCap('measure_swap', pct(nodeStatus.swap.used, nodeStatus.swap.total));
        }
      }
      if (resources && this.hasCapability('running_vms')) {
        const running = resources.filter((r) => r.type === 'qemu'
          && r.node === this.pveNode && r.status === 'running').length;
        await this.setCap('running_vms', running);
      }
    }

    if ((this.resourceType === 'qemu' || this.resourceType === 'lxc') && this.hasCapability('ip_address')) {
      this._maybeRefreshIp(status).catch(() => {});
    }

    await this._handleStatusChange(status);
  }

  /**
   * Fetch the guest IP at most every few minutes (or right after it starts).
   * VMs need the qemu-guest-agent; containers must be running.
   */
  async _maybeRefreshIp(status) {
    if (status !== 'running') {
      this._lastIpFetch = 0;
      await this.setCap('ip_address', '—');
      return;
    }
    const now = Date.now();
    if (this._lastIpFetch && (now - this._lastIpFetch) < IP_REFRESH_MS) return;
    this._lastIpFetch = now;

    try {
      const data = this.resourceType === 'qemu'
        ? await this.client.getQemuAgentInterfaces(this.pveNode, this.vmid)
        : await this.client.getLxcInterfaces(this.pveNode, this.vmid);
      const ip = extractGuestIp(this.resourceType, data);
      if (ip) await this.setCap('ip_address', ip);
    } catch (err) {
      // No guest agent / not supported — leave the previous value.
    }
  }

  /** Overridden by the cluster device. */
  async applyCluster() {}

  /* ----------------------------------------------------------------------- */
  /* Flow triggers                                                           */
  /* ----------------------------------------------------------------------- */

  async _handleStatusChange(status) {
    const prev = this._lastStatus;
    this._lastStatus = status;
    if (prev === undefined || prev === status) return;

    if (this.resourceType === 'qemu' || this.resourceType === 'lxc') {
      const p = this.resourceType;
      if (status === 'running') this._trigger(`${p}_started`);
      if (status === 'stopped') this._trigger(`${p}_stopped`);
      this._trigger(`${p}_status_changed`, { status });
    } else if (this.resourceType === 'node') {
      if (status === 'online') this._trigger('node_online');
      if (status === 'offline') this._trigger('node_offline');
    }
  }

  _trigger(cardId, tokens = {}) {
    let card;
    try {
      card = this.homey.flow.getDeviceTriggerCard(cardId);
    } catch (err) {
      return; // card not defined for this driver
    }
    card.trigger(this, tokens, {}).catch((err) => this.error(`trigger ${cardId}:`, err.message));
  }

  /* ----------------------------------------------------------------------- */
  /* Helpers & lifecycle                                                     */
  /* ----------------------------------------------------------------------- */

  async setCap(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.error(`setCapabilityValue(${capability})`, err.message);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!changedKeys.some((key) => CONNECTION_SETTING_KEYS.includes(key))) return;

    const store = this.getStore() || {};
    const override = {
      host: newSettings.host || store.host,
      port: newSettings.port || store.port || 8006,
      tokenId: newSettings.tokenId || store.tokenId,
      tokenSecret: newSettings.tokenSecret || store.tokenSecret,
      verifyTls: newSettings.verifyTls !== undefined ? newSettings.verifyTls : store.verifyTls,
      ca: newSettings.ca || store.ca || null,
      pollInterval: Number(newSettings.pollInterval) || 30,
    };

    this.homey.app.connections.unregister(this);
    this.connection = this.homey.app.connections.register(this, override);
  }

  async onUninit() {
    if (this.homey.app.connections) this.homey.app.connections.unregister(this);
  }

  async onDeleted() {
    if (this.homey.app.connections) this.homey.app.connections.unregister(this);
  }

}

module.exports = PveDevice;
