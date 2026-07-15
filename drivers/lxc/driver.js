'use strict';

const PveDriver = require('../../lib/PveDriver');

class LxcDriver extends PveDriver {

  async onInit() {
    this.pveType = 'lxc';
    await super.onInit();
  }

}

module.exports = LxcDriver;
