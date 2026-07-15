'use strict';

module.exports = {
  async getBackups({ homey }) {
    return homey.app.getBackupSummary();
  },
};
