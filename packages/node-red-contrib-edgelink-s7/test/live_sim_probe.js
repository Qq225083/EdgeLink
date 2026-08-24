// s7-read 实时联调：真 nodes7 传输 + 真模拟器（非 stub）
var helper = require('node-red-node-test-helper');
var s7read = require('../nodes/s7-read.js');
var s7config = require('../nodes/s7-config.js');

helper.init(require.resolve('node-red'));

var flow = [
  { id: 'cfg1', type: 's7-config', name: 'sim', host: '127.0.0.1', port: 1102, rack: 0, slot: 1 },
  { id: 'rd1', type: 's7-read', name: 'S7读取', s7: 'cfg1', tags: '[]', deviceId: '', wires: [['out1']] },
  { id: 'out1', type: 'helper' }
];

helper.load([s7config, s7read], flow, function () {
  var rd = helper.getNode('rd1');
  var out = helper.getNode('out1');
  var done = false;
  out.on('input', function (msg) {
    if (done) return;
    done = true;
    console.log('OUTPUT success=', msg.payload.success, 'error=', msg.payload.error);
    console.log('DATA=', JSON.stringify(msg.payload.data));
    helper.stopServer();
    process.exit(msg.payload.success ? 0 : 1);
  });
  rd.on('call:error', function (call) {
    console.log('NODE-ERROR:', call.firstArg ? String(call.firstArg) : '');
  });
  rd.receive({
    payload: {
      id: 44, deviceName: 'S7_SIM_TEST', comType: 'S7',
      plcIp: '127.0.0.1', plcPort: 1102, driverCode: 'siemens_s7',
      protocolParams: { rack: 0, slot: 1 },
      tags: [
        { id: 75, regAddr: 'DB1.DBW0', regType: 'DB', dataType: 'INT16', name: 's7_dbw0' },
        { id: 76, regAddr: 'DB1.DBD4', regType: 'DB', dataType: 'FLOAT', name: 's7_dbd4' },
        { id: 77, regAddr: 'MW10', regType: 'M', dataType: 'INT16', name: 's7_mw10' },
        { id: 78, regAddr: 'I0.0', regType: 'I', dataType: 'BOOL', name: 's7_i00' }
      ],
      timeout: 3000, maxRetries: 1, retryInterval: 300
    }
  });
  setTimeout(function () { console.log('TIMEOUT-无输出'); process.exit(2); }, 12000);
});
