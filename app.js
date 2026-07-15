'use strict';

const Homey = require('homey');
const ConnectionManager = require('./lib/ConnectionManager');

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
    this.log('Proxmox VE app has been initialized');
  }

  async onUninit() {
    if (this.connections) {
      this.connections.destroyAll();
      this.connections = null;
    }
  }

}

module.exports = PveControlApp;
