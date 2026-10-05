/**
 * MC 探针（M2 前置取数 V-1~V-8 中可本机验证的部分）
 * 用边缘实际安装的 node-red-contrib-mcprotocol@1.2.1 + 本地模拟器（127.0.0.1:5007）。
 *
 * 运行：node 9-28/tools/mc_probe.js
 */
const path = 'D:/nodered/data/node_modules/node-red-contrib-mcprotocol/connection_pool.js';
const pool = require(path);

function read(conn, addr) {
  return new Promise((resolve) => {
    try {
      conn.read(addr, (problem, msg) => resolve({ problem, msg }));
    } catch (e) {
      resolve({ thrown: e.message });
    }
  });
}

function showKeys(tag, res) {
  if (res.thrown) {
    console.log(`${tag}: 抛错 ${res.thrown}`);
    return;
  }
  // 库返回结构：msg.value 是值（数组或标量），msg.quality/isGood 在库响应上
  const v = res.msg && res.msg.value;
  const detail = (v && typeof v === 'object')
    ? (Array.isArray(v) ? `数组${JSON.stringify(v)}` : `对象keys=${JSON.stringify(Object.keys(v))} 值=${JSON.stringify(v)}`)
    : JSON.stringify(v);
  console.log(`${tag}:`, res.problem ? `problem=${res.problem}` : 'ok',
    '| value:', detail,
    '| quality:', res.msg && res.msg.quality, '| isGood:', res.msg && res.msg.isGood);
}

async function main() {
  const SIM = { host: '127.0.0.1', port: 5007 };

  console.log('===== V-2 块读与多字类型返回形态 =====');
  let conn = pool.get(SIM.port, SIM.host, { frame: '3E', plcType: 'Q', timeout: 2000 });
  await new Promise(r => setTimeout(r, 800)); // 等连接建立

  await showKeys('D100,1（单字）', await read(conn, 'D100,1'));
  await showKeys('D100,4（块读4字）', await read(conn, 'D100,4'));
  await showKeys('DFLOAT100（类型串形 float）', await read(conn, 'DFLOAT100'));
  await showKeys('D100,2,FLOAT（类型后置）', await read(conn, 'D100,2,FLOAT'));
  await showKeys('K4D100（K 前缀）', await read(conn, 'K4D100'));

  console.log('\n===== A4 回归：BIT 地址串 =====');
  await showKeys('M200.3（正确形式）', await read(conn, 'M200.3'));
  await showKeys('M200.3,4（连读4位）', await read(conn, 'M200.3,4'));
  await showKeys('M200,3,BIT（旧错误形式，应抛错）', await read(conn, 'M200,3,BIT'));

  console.log('\n===== V-3/V-5：FX + X/Y + octalInputOutput =====');
  let connFx = pool.get(SIM.port + '', SIM.host, { frame: '3E', plcType: 'FX', timeout: 2000, octalInputOutput: false });
  await new Promise(r => setTimeout(r, 500));
  await showKeys('FX octal=false: X0,8', await read(connFx, 'X0,8'));
  let connFx2 = pool.get(SIM.port + '', SIM.host, { frame: '3E', plcType: 'FX', timeout: 2000, octalInputOutput: true });
  await showKeys('FX octal=true: X0,8', await read(connFx2, 'X0,8'));

  console.log('\n===== V-7：隔离性（好连接不受坏连接影响）=====');
  let dead = pool.get(5999, '127.0.0.1', { frame: '3E', plcType: 'Q', timeout: 800 });
  for (let i = 0; i < 3; i++) {
    const [good, bad] = await Promise.all([read(conn, 'D100,1'), read(dead, 'D0,1')]);
    const goodVal = good.msg && good.msg.value;
    console.log(`轮${i + 1}: 好连接=${goodVal !== undefined ? '有数据(' + JSON.stringify(goodVal) + ')' : '无数据'} 坏连接=${bad.thrown || bad.problem || '?'}`);
  }

  console.log('\n===== C1 验证：同 host:port 不同参数是否共享连接 =====');
  console.log('conn === connFx（同 key 应同一对象）:', conn === connFx);
  console.log('connFx === connFx2（参数不同 key 相同应共享）:', connFx === connFx2);

  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
