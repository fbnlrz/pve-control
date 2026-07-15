'use strict';

const PveDriver = require('../../lib/PveDriver');

class ClusterDriver extends PveDriver {

  async onInit() {
    this.pveType = 'cluster';
    await super.onInit();
  }

  // A cluster is a single synthetic device, not a per-resource list.
  buildPairDevices(resources, config) {
    const store = {
      host: config.host,
      port: config.port,
      tokenId: config.tokenId,
      tokenSecret: config.tokenSecret,
      verifyTls: config.verifyTls,
      ca: config.ca || null,
      node: null,
      vmid: null,
      storage: null,
      resourceType: 'cluster',
      resourceId: 'cluster',
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
    return [{
      name: `Cluster ${config.clusterKey}`,
      data: { id: `${config.clusterKey}/cluster` },
      store,
      settings,
    }];
  }

}

module.exports = ClusterDriver;
