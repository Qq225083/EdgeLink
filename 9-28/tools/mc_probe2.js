const pool = require('D:/nodered/data/node_modules/node-red-contrib-mcprotocol/connection_pool.js');
function read(conn, addr) {
  return new Promise(r => { try { conn.read(addr, (p, m) => r({ p, v: m && m.value, q: m && m.quality })); } catch (e) { r({ thrown: e.message }); } });
}
(async () => {
  const conn = pool.get(5007, '127.0.0.1', { frame: '3E', plcType: 'Q', timeout: 2000 });
  await new Promise(r => setTimeout(r, 800));
  console.log('DFLOAT100,2（2个float块读）:', JSON.stringify(await read(conn, 'DFLOAT100,2')));
  console.log('DDINT100,2（2个INT32块读）:', JSON.stringify(await read(conn, 'DDINT100,2')));
  console.log('DUINT100,2（2个UINT16）:', JSON.stringify(await read(conn, 'DUINT100,2')));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
