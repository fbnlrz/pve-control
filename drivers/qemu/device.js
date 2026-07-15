'use strict';

const PveDevice = require('../../lib/PveDevice');

// All behaviour (polling, capability mapping, flow triggers, power control)
// lives in the shared PveDevice base class.
class QemuDevice extends PveDevice {}

module.exports = QemuDevice;
