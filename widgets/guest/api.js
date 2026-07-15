'use strict';

module.exports = {
  async getGuest({ homey, query }) {
    if (!query || !query.connKey || !query.vmid) return null;
    return homey.app.getGuestSummary(query.connKey, query.vmid);
  },
  async start({ homey, body }) {
    return homey.app.widgetGuestAction(body.connKey, body.kind, body.node, body.vmid, 'start');
  },
  async shutdown({ homey, body }) {
    return homey.app.widgetGuestAction(body.connKey, body.kind, body.node, body.vmid, 'shutdown');
  },
};
