'use strict';

module.exports = {
  async getStorages({ homey }) {
    return homey.app.getStorages();
  },
};
