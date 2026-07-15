'use strict';

module.exports = {
  async getNode({ homey, query }) {
    if (!query || !query.connKey || !query.node) return null;
    return homey.app.getNodeSummary(query.connKey, query.node);
  },
};
