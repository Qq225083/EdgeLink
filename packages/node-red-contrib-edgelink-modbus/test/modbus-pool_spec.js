/* eslint-env mocha */
'use strict';

var assert = require('assert');
var net = require('net');
var pool = require('../nodes/modbus-pool');

describe('modbus-pool', function () {
  var server;
  var port;
  var _usedKeys;

  function node(id) { return { id: id }; }

  beforeEach(function (done) {
    _usedKeys = [];
    server = net.createServer(function (sock) {
      sock.on('error', function () {});
    });
    server.listen(0, '127.0.0.1', function () {
      port = server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    // 清掉本测试遗留的连接，避免用例间串扰
    for (var i = 0; i < _usedKeys.length; i++) {
      pool.destroyConnection(_usedKeys[i]);
    }
    server.close(function () { done(); });
  });

  function key() {
    var k = pool.poolKey('127.0.0.1', port);
    if (_usedKeys.indexOf(k) < 0) _usedKeys.push(k);
    return k;
  }

  it('connects and reuses the same idle connection', function (done) {
    var n = node('nA');
    pool.getConnection(n, '127.0.0.1', port, 2000, function (err, sock1) {
      assert.ifError(err);
      key();
      pool.releaseConnection(n, '127.0.0.1', port);
      pool.getConnection(n, '127.0.0.1', port, 2000, function (err2, sock2) {
        assert.ifError(err2);
        assert.strictEqual(sock1, sock2, '应复用同一 socket');
        pool.releaseConnection(n, '127.0.0.1', port);
        done();
      });
    });
  });

  it('queues when busy and grant registers users + ownerId', function (done) {
    var nA = node('nA');
    var nB = node('nB');
    pool.getConnection(nA, '127.0.0.1', port, 2000, function (err) {
      assert.ifError(err);
      var k = key();
      pool.getConnection(nB, '127.0.0.1', port, 2000, function (err2, sockB) {
        assert.ifError(err2);
        var entry = pool.peekEntry('127.0.0.1', port);
        assert.ok(entry.users['nB'], '队列发放后应登记 users');
        assert.strictEqual(entry.ownerId, 'nB', '队列发放后应登记 ownerId');
        pool.releaseConnection(nB, '127.0.0.1', port);
        done();
      });
      // nB 此时应处于排队状态
      assert.strictEqual(pool.peekEntry('127.0.0.1', port).queue.length, 1);
      pool.releaseConnection(nA, '127.0.0.1', port);
    });
  });

  it('releaseConnection rejects non-owner', function (done) {
    var nA = node('nA');
    var nX = node('nX');
    pool.getConnection(nA, '127.0.0.1', port, 2000, function (err) {
      assert.ifError(err);
      key();
      pool.releaseConnection(nX, '127.0.0.1', port);  // 非属主，应被拒绝
      assert.strictEqual(pool.peekEntry('127.0.0.1', port).inUse, true, '非属主不得释放连接');
      pool.releaseConnection(nA, '127.0.0.1', port);
      assert.strictEqual(pool.peekEntry('127.0.0.1', port).inUse, false);
      done();
    });
  });

  it('nodeClosed destroys in-use connection owned by closing node (fix #1)', function (done) {
    var nA = node('nA');
    pool.getConnection(nA, '127.0.0.1', port, 2000, function (err) {
      assert.ifError(err);
      key();
      // 模拟节点在持有连接时被关闭（不经过 releaseConnection）
      pool.nodeClosed(nA);
      assert.strictEqual(pool.peekEntry('127.0.0.1', port), undefined, '在途属主关闭应销毁连接');
      done();
    });
  });

  it('nodeClosed keeps connection while other users remain', function (done) {
    var nA = node('nA');
    var nB = node('nB');
    pool.getConnection(nA, '127.0.0.1', port, 2000, function (err) {
      assert.ifError(err);
      key();
      pool.releaseConnection(nA, '127.0.0.1', port);
      pool.getConnection(nB, '127.0.0.1', port, 2000, function (err2) {
        assert.ifError(err2);
        pool.releaseConnection(nB, '127.0.0.1', port);
        // nA 关闭：nB 还在用 → 连接保留
        pool.nodeClosed(nA);
        assert.ok(pool.peekEntry('127.0.0.1', port), '仍有使用者时不应销毁');
        // nB 也关闭：最后一个使用者离开 → 销毁
        pool.nodeClosed(nB);
        assert.strictEqual(pool.peekEntry('127.0.0.1', port), undefined, '最后使用者离开应销毁');
        done();
      });
    });
  });

  it('detachNode releases owned connection and removes users mark', function (done) {
    var nA = node('nA');
    pool.getConnection(nA, '127.0.0.1', port, 2000, function (err) {
      assert.ifError(err);
      key();
      pool.detachNode(nA, '127.0.0.1', port);
      var entry = pool.peekEntry('127.0.0.1', port);
      assert.strictEqual(entry.inUse, false, 'detach 后应释放');
      assert.strictEqual(entry.ownerId, null, 'detach 后属主清空');
      assert.ok(!entry.users['nA'], 'detach 后 users 标记摘除');
      done();
    });
  });

  it('applies backoff after connect failure', function (done) {
    // 找一个确定关闭的端口
    var tmp = net.createServer();
    tmp.listen(0, '127.0.0.1', function () {
      var deadPort = tmp.address().port;
      tmp.close(function () {
        var nA = node('nA');
        pool.getConnection(nA, '127.0.0.1', deadPort, 1000, function (err) {
          assert.ok(err, '首次连接应失败');
          pool.getConnection(nA, '127.0.0.1', deadPort, 1000, function (err2) {
            assert.ok(err2, '退避期内应直接失败');
            assert.ok(err2.message.indexOf('backoff') >= 0, '应为 backoff 错误: ' + err2.message);
            pool.destroyConnection('127.0.0.1', deadPort);
            done();
          });
        });
      });
    });
  });
});
