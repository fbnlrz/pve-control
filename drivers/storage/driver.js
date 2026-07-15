'use strict';

const PveDriver = require('../../lib/PveDriver');

class StorageDriver extends PveDriver {

  async onInit() {
    this.pveType = 'storage';
    await super.onInit();
  }

}

module.exports = StorageDriver;
