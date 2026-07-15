'use strict';

module.exports = {
  async getOverview({ homey }) {
    return homey.app.getOverview();
  },
};
