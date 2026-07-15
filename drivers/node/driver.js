'use strict';

const PveDriver = require('../../lib/PveDriver');

class NodeDriver extends PveDriver {

  async onInit() {
    this.pveType = 'node';
    await super.onInit();
  }

}

module.exports = NodeDriver;
