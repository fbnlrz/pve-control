'use strict';

const PveConnection = require('./PveConnection');
const { connKey } = require('./util');

/**
 * App-owned singleton (`this.homey.app.connections`). De-duplicates Proxmox
 * connections by endpoint key so that many devices across different drivers
 * share a single {@link PveConnection} (and thus a single poll loop / HTTP
 * client) per Proxmox server.
 */
class ConnectionManager {

  constructor(homey) {
    this.homey = homey;
    this.connections = new Map();
  }

  /**
   * Build the effective connection config for a device. User-editable settings
   * win over the pairing-time store values.
   */
  configFromDevice(device, override) {
    if (override) return override;
    const store = device.getStore() || {};
    const settings = device.getSettings() || {};
    return {
      host: settings.host || store.host,
      port: settings.port || store.port || 8006,
      tokenId: settings.tokenId || store.tokenId,
      tokenSecret: settings.tokenSecret || store.tokenSecret,
      verifyTls: settings.verifyTls !== undefined ? settings.verifyTls : store.verifyTls,
      ca: settings.ca || store.ca || null,
      pollInterval: Number(settings.pollInterval) || 30,
    };
  }

  /**
   * Register a device, creating (or reusing) the poller for its endpoint.
   * Returns the {@link PveConnection} the device is now subscribed to.
   * @param {object} [override] explicit config (used from onSettings, where
   *   getSettings() would still return the old values).
   */
  register(device, override) {
    const config = this.configFromDevice(device, override);
    const key = connKey(config);

    let connection = this.connections.get(key);
    if (!connection) {
      connection = new PveConnection(this.homey, key, config);
      this.connections.set(key, connection);
    } else {
      connection.setPollInterval(config.pollInterval);
    }

    device._connKey = key;
    connection.subscribe(device);
    return connection;
  }

  unregister(device) {
    const key = device._connKey;
    if (!key) return;
    const connection = this.connections.get(key);
    if (!connection) return;

    const remaining = connection.unsubscribe(device);
    if (remaining === 0) {
      connection.destroy();
      this.connections.delete(key);
    }
    device._connKey = null;
  }

  destroyAll() {
    for (const connection of this.connections.values()) {
      connection.destroy();
    }
    this.connections.clear();
  }

}

module.exports = ConnectionManager;
