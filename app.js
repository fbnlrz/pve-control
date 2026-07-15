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

    this.log('Proxmox VE app has been initialized');
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
