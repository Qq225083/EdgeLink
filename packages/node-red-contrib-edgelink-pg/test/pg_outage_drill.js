/* Day8 PG 停机演练：锁表注入故障 → spool 落盘 → 解锁恢复 → 重放对账 */
// 🔧 凭据不入库：从环境变量读，缺失则跳过演练
var PG_PASS = process.env.PGPASSWORD;
if (!PG_PASS) { console.log('SKIP: 请设置 PGPASSWORD 环境变量后运行'); process.exit(0); }
process.env.PGPASSWORD = PG_PASS;
var helper = require('node-red-node-test-helper');
var assert = require('assert');
var { execSync, spawn } = require('child_process');
var pgStoreNode = require('../nodes/edgelink-pg-store.js');
var pgConfigNode = require('../nodes/edgelink-pg-config.js');

var PSQL = 'D:/PostgreSQL/bin/psql';
function q(sql) {
  return execSync('"' + PSQL + '" -h 127.0.0.1 -U postgres -d postgres -tAc "' + sql.replace(/"/g, '\\"') + '"',
    { env: Object.assign({}, process.env, { PGPASSWORD: PG_PASS }), encoding: 'utf8' }).trim();
}
function mkRows(n, tagBase) {
  var rows = [];
  var now = Date.now();
  for (var i = 0; i < n; i++) {
    rows.push({
      insert_time: new Date(now + i).toISOString(),
      node_id: 66, device_id: 30, device_name: 'drill', tag_id: (90000 + i),
      tag_address: 'D' + i, tag_name: 'drill', register_type: 'D',
      raw_value: i, eng_value: i * 1.0, unit: '', quality: 0, host_pc_ip: 'drill'
    });
  }
  return rows;
}

describe('Day8 PG outage drill', function () {
  this.timeout(120000);
  afterEach(function (done) { helper.unload().then(function () { done(); }).catch(done); });

  it('lock-table outage → spool → unlock → replay, zero dup', function (done) {
    q("DELETE FROM edgelink.plc_data WHERE device_name='drill'");
    var flow = [
      { id: 'pgc', type: 'edgelink-pg-config', name: 'pg', host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: PG_PASS, maxConnections: 5 },
      { id: 'pgs', type: 'edgelink-pg-store', name: 'store', pgConfig: 'pgc', tableName: 'edgelink.plc_data', batchSize: 50, flushInterval: 500, retryInterval: 1000, autoCreateTable: false, wires: [] }
    ];
    helper.load([pgConfigNode, pgStoreNode], flow, function () {
      var store = helper.getNode('pgs');
      var phaseA = mkRows(300, 'a');
      store.receive({ payload: { rows: mkRows(300, 'a') }, tableName: 'edgelink.plc_data' });

      setTimeout(function () {
        var cntA = parseInt(q("SELECT count(*) FROM edgelink.plc_data WHERE device_name='drill'"), 10);
        console.log('  [A] PG 正常: inserted =', cntA);
        assert.strictEqual(cntA, 300, 'phase A 应全部入库');

        // Phase B: 锁表 25s 模拟 PG 写不可用
        console.log('  [B] 锁表 25s 注入故障...');
        var locker = spawn('"' + PSQL + '"', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c',
          'BEGIN; LOCK TABLE edgelink.plc_data IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(25); COMMIT;'],
          { env: Object.assign({}, process.env, { PGPASSWORD: PG_PASS }), shell: true });
        setTimeout(function () {
          store.receive({ payload: { rows: mkRows(200, 'b') }, tableName: 'edgelink.plc_data' });
          console.log('  [B] 故障期驱动 200 行');
        }, 2000);

        // 故障结束后：再等数据链恢复 + replay
        setTimeout(function () {
          store.receive({ payload: { rows: mkRows(100, 'c') }, tableName: 'edgelink.plc_data' });
        }, 29000);

        setTimeout(function () {
          var cntAll = parseInt(q("SELECT count(*) FROM edgelink.plc_data WHERE device_name='drill'"), 10);
          var dup = parseInt(q("SELECT count(*) FROM (SELECT insert_time,node_id,device_id,tag_id,COUNT(*) c FROM edgelink.plc_data WHERE device_name='drill' GROUP BY 1,2,3,4 HAVING COUNT(*)>1) t"), 10);
          console.log('  [C] 恢复后总行数 =', cntAll, '(期望 600) | 重复键 =', dup, '(期望 0)');
          var spoolLeft = '';
          try { spoolLeft = execSync('dir /s /b %TEMP%\\..\\..\\Local\\Temp\\*edgelink_pg_spool* 2>nul', { shell: 'cmd.exe', encoding: 'utf8' }); } catch (e) {}
          assert.strictEqual(cntAll, 600, '600 行全部入库（300 直写 + 200 spool 重放 + 100 恢复后直写）');
          assert.strictEqual(dup, 0, '唯一索引兜底，零重复');
          q("DELETE FROM edgelink.plc_data WHERE device_name='drill'");
          done();
        }, 45000);
      }, 4000);
    });
  });
});
