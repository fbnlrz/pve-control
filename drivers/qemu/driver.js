'use strict';

const PveDriver = require('../../lib/PveDriver');

class QemuDriver extends PveDriver {

  async onInit() {
    this.pveType = 'qemu';
    await super.onInit();
  }

}

module.exports = QemuDriver;
