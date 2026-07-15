'use strict';

const PveDevice = require('../../lib/PveDevice');
const { round, pct } = require('../../lib/util');

/**
 * Datacenter/cluster overview device. Aggregates `/cluster/resources` and
 * reads quorum state from `/cluster/status`. On a standalone host there is no
 * cluster entry, so quorum is treated as healthy.
 */
class ClusterDevice extends PveDevice {

  async applyCluster(resources, clusterStatus) {
    const list = resources || [];
    const runningVms = list.filter((r) => r.type === 'qemu' && r.status === 'running').length;
    const runningCts = list.filter((r) => r.type === 'lxc' && r.status === 'running').length;
    await this.setCap('running_vms', runningVms);
    await this.setCap('running_cts', runningCts);

    // Aggregate CPU (core-weighted) and memory across all nodes.
    let cpuUsedCores = 0;
    let cpuTotalCores = 0;
    let memUsed = 0;
    let memTotal = 0;
    for (const node of list.filter((r) => r.type === 'node')) {
      const cores = node.maxcpu || 1;
      cpuUsedCores += (node.cpu || 0) * cores;
      cpuTotalCores += cores;
      memUsed += node.mem || 0;
      memTotal += node.maxmem || 0;
    }
    await this.setCap('measure_cpu', cpuTotalCores ? round((cpuUsedCores / cpuTotalCores) * 100) : null);
    await this.setCap('measure_memory', pct(memUsed, memTotal));

    // Quorum.
    let quorate = true;
    if (Array.isArray(clusterStatus)) {
      const cluster = clusterStatus.find((s) => s.type === 'cluster');
      if (cluster && cluster.quorate !== undefined) quorate = Boolean(cluster.quorate);
    }

    const prevAlarm = this.getCapabilityValue('alarm_quorum');
    await this.setCap('alarm_quorum', !quorate);
    await this.setCap('pve_status', quorate ? 'quorate' : 'no-quorum');

    if (prevAlarm !== undefined && prevAlarm !== !quorate) {
      this._trigger(quorate ? 'quorum_restored' : 'quorum_lost');
    }
  }

}

module.exports = ClusterDevice;
