/**
 * edgelink-pg-store.js — PG/TimescaleDB 批量写入节点 v1.5.0
 *
 * v1.5.0: 🔧 #82 磁盘 spool — 最终失败的批次落盘(edgelink_pg_spool/)，DB 恢复后自动重放，
 *          确定性错误转死信文件，数据不再因类型错误/表缺失被静默丢弃
 * v1.4.0: retryBufferMax 配置修复 + 数据丢弃告警 + autoCreateTable 默认关闭 +
 *          done() 回调 + 优雅关闭 + Pool 错误状态上报 + 测试覆盖
 * v1.3.0: 冲突策略可配(ignore/update/none) + 自动建表通用化(idColumn+tsColumn) + msg动态覆盖
 * v1.2.0: 并发安全 + pool.connect超时 + retryBuffer按行数 + 仅flush时send + 事件驱动重试
 *
 * 支持三种输入格式（自动识别）：
 *   1. MC 驱动格式: { deviceId, data: { tagId: {rawValue,engValue,quality,ts,regType} } }
 *   2. 批量 rows:   { rows: [{col: val}, ...] }
 *   3. 单行 object: { col1: val1, col2: val2 }
 */
module.exports = function (RED) {
    'use strict';

    // ====================================================================
    // 模块级：全局 Pool 管理
    // ====================================================================
    var POOLS = {};

    function getPoolKey(cfg) {
        return (cfg.user || 'postgres') + '@' +
               (cfg.host || '127.0.0.1') + ':' +
               (cfg.port || 5432) + '/' +
               (cfg.database || 'ruoyi_pg');
    }

    function getPool(cfg) {
        var key = getPoolKey(cfg);
        if (!POOLS[key]) {
            var pg = require('pg');
            var newPool = new pg.Pool({
                host: cfg.host || '127.0.0.1', port: cfg.port || 5432,
                database: cfg.database || 'ruoyi_pg', user: cfg.user || 'postgres',
                password: typeof cfg.password === 'string' ? cfg.password : String(cfg.password || ''),
                max: cfg.maxConnections || 10,
                idleTimeoutMillis: cfg.idleTimeout || 30000,
                connectionTimeoutMillis: cfg.connectTimeout || 5000
            });
            newPool.on('error', function (err) {
                var entry = POOLS[key];
                var msg = '[PG-Store] Pool idle error (' + key + '): ' + err.message;
                console.error(msg);
                if (!entry) return;
                Object.keys(entry.nodes || {}).forEach(function (nid) {
                    var api = entry.nodes[nid];
                    if (api && api.setStatus) api.setStatus('red', 'pool error');
                    if (api && api.send) api.send({ payload: { event: 'pool_error', success: false, error: msg } });
                });
            });
            POOLS[key] = { pool: newPool, refCount: 0, nodes: {} };
        }
        return POOLS[key].pool;
    }

    function registerPool(cfg, nodeId, nodeApi) {
        getPool(cfg);
        var key = getPoolKey(cfg);
        POOLS[key].refCount++;
        if (nodeId && nodeApi) POOLS[key].nodes[nodeId] = nodeApi;
    }

    function releasePool(cfg, nodeId) {
        var key = getPoolKey(cfg);
        if (!POOLS[key]) return;
        POOLS[key].refCount = Math.max(0, POOLS[key].refCount - 1);
        if (nodeId && POOLS[key].nodes) delete POOLS[key].nodes[nodeId];
        if (POOLS[key].refCount === 0) {
            var p = POOLS[key].pool;
            delete POOLS[key];
            p.end(function (err) {
                if (err) console.warn('[PG-Store] Pool end error (' + key + '):', err.message);
            });
        }
    }

    // ====================================================================
    // 工具函数
    // ====================================================================
    function resolveTableName(template, deviceId) {
        var name = template.replace(/\$\{deviceId\}/g, String(deviceId || 'unknown'));
        name = name.replace(/[^a-zA-Z0-9_.]/g, '_');
        var parts = name.split('.');
        if (parts.length > 2) throw new Error('Invalid table name (max 1 dot): ' + name);
        for (var i = 0; i < parts.length; i++) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parts[i])) {
                throw new Error('Invalid table name part: ' + parts[i]);
            }
        }
        return name;
    }

    function sanitizeColumn(col) {
        var s = String(col).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) s = '_' + s;
        return s;
    }

    /** 🔧 v1.3.0: 可配置冲突策略 */
    function buildInsertSQL(tableName, columns, rowCount, conflict, idCol, tsCol) {
        var placeholders = [];
        var idx = 1;
        for (var i = 0; i < rowCount; i++) {
            var row = [];
            for (var j = 0; j < columns.length; j++) {
                row.push('$' + idx++);
            }
            placeholders.push('(' + row.join(', ') + ')');
        }
        var sql = 'INSERT INTO ' + tableName +
                  ' (' + columns.join(', ') + ') VALUES ' +
                  placeholders.join(', ');
        if (conflict === 'ignore') {
            sql += ' ON CONFLICT DO NOTHING';
        } else if (conflict === 'update' && idCol && tsCol) {
            var setCols = columns.filter(function (c) { return c !== idCol && c !== tsCol; });
            if (setCols.length > 0) {
                var setClauses = setCols.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ');
                sql += ' ON CONFLICT (' + tsCol + ', ' + idCol + ') DO UPDATE SET ' + setClauses;
            } else {
                sql += ' ON CONFLICT DO NOTHING';
            }
        }
        return sql;
    }

    function flattenRows(rows) {
        var values = [];
        for (var i = 0; i < rows.length; i++) {
            for (var j = 0; j < rows[i].length; j++) {
                values.push(rows[i][j]);
            }
        }
        return values;
    }

    function classifyError(err) {
        if (!err) return 'retry';
        var code = err.code || '';
        if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code.indexOf('08') === 0) {
            return 'connection';
        }
        if (code === '42P01') return 'table_not_found';
        if (code === '23505') return 'duplicate';
        if (code === '22P02') return 'data_error';
        return 'retry';
    }

    function indexNameFor(tableName) {
        var hash = 0;
        for (var i = 0; i < tableName.length; i++) {
            hash = ((hash << 5) - hash) + tableName.charCodeAt(i);
            hash |= 0;
        }
        return 'idx_' + (Math.abs(hash) % 900000 + 100000) + '_dt';
    }

    // ====================================================================
    // MC 驱动格式
    // ====================================================================
    var MC_COLUMNS = [
        'insert_time', 'device_id', 'tag_id',
        'register_type', 'raw_value', 'eng_value', 'quality'
    ];

    function parseMCFormat(payload) {
        var deviceId = payload.deviceId || 'unknown';
        var data = payload.data;
        var tagIds = Object.keys(data);
        var rows = [];
        for (var i = 0; i < tagIds.length; i++) {
            var tagId = tagIds[i];
            var tag = data[tagId];
            if (!tag || typeof tag !== 'object') continue;
            rows.push([
                tag.ts ? tag.ts : new Date().toISOString(),
                deviceId, tagId, tag.regType || '',
                (tag.rawValue != null) ? tag.rawValue : null,
                (tag.engValue != null) ? tag.engValue : null,
                (tag.quality != null) ? parseInt(tag.quality, 10) || 0 : 0
            ]);
        }
        return rows;
    }

    function detectFormat(payload) {
        if (payload.rows && Array.isArray(payload.rows) && payload.rows.length > 0) {
            return 'batch';
        }
        if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
            var keys = Object.keys(payload.data);
            if (keys.length > 0) {
                var firstVal = payload.data[keys[0]];
                if (firstVal && typeof firstVal === 'object' && !Array.isArray(firstVal)) {
                    if ('rawValue' in firstVal || 'engValue' in firstVal || 'quality' in firstVal) {
                        return 'mc';
                    }
                }
            }
        }
        if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
            return 'single';
        }
        return 'unknown';
    }

    // ====================================================================
    // 节点定义
    // ====================================================================
    function EdgelinkPgStore(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        var pgConfigNode = RED.nodes.getNode(config.pgConfig);
        if (!pgConfigNode) {
            node.error('[PG-Store] edgelink-pg-config not found');
            return;
        }
        var pgConfig = pgConfigNode;

        node.tableName      = config.tableName || 'plc_data';
        node.conflictStrategy = config.conflictStrategy || 'ignore';  // 🆕 冲突策略
        node.idColumn       = sanitizeColumn(config.idColumn || 'device_id');   // 🆕 sanitize 防注入
        node.tsColumn       = sanitizeColumn(config.tsColumn || 'insert_time'); // 🆕 sanitize 防注入
        node.batchSize      = clampInt(config.batchSize, 100, 1, 2000);
        node.bufferMax      = clampInt(config.bufferMax, 5000, 50, 50000);
        node.flushInterval  = clampInt(config.flushInterval, 5000, 0, 300000);
        node.retryBufferMax = clampInt(config.retryBufferMax, 1000, 50, 10000);
        node.retryInterval  = clampInt(config.retryInterval, 5000, 1000, 300000);
        node.autoCreateTable = config.autoCreateTable === true;
        node.useTimescaleDB = config.useTimescaleDB === true;
        node.flushTimeout   = clampInt(config.flushTimeout, 15000, 5000, 60000);
        node.tableCreationFailedTTL = clampInt(config.tableCreationFailedTTL, 300000, 60000, 3600000);

        // --- 运行时状态 ---
        var _buffer        = [];
        var _bufferColumns = null;
        var _bufferTable   = '';
        var _bufferIsMC    = false;
        var _bufferConflict = 'ignore';    // 🆕 buffer 的冲突策略
        var _retryBuffer   = [];
        var _retryTotalRows = 0;
        var _writing       = false;
        var _closing       = false;
        var _tableCreationFailed = {};
        var _flushTimer    = null;
        var _retryTimer    = null;
        var _pendingSchemas = [];
        var _roundStart    = 0;

        // ================================================================
        // 🔧 #82: 磁盘 spool — 最终失败的批次不再丢弃，落盘待恢复后重放
        // ================================================================
        var SPOOL_MAX_BYTES = 100 * 1024 * 1024;   // 单文件上限 100MB（超出后轮转，最多保留 2 份）
        var _spoolDir = null;
        var _replaying = false;

        function spoolPaths() {
            var path = require('path');
            var fs = require('fs');
            if (!_spoolDir) {
                _spoolDir = path.join((RED.settings && RED.settings.userDir) || '.', 'edgelink_pg_spool');
                try { fs.mkdirSync(_spoolDir, { recursive: true }); } catch (e) {}
            }
            return {
                active: path.join(_spoolDir, 'spool-' + node.id + '.jsonl'),
                dead: path.join(_spoolDir, 'spool-dead-' + node.id + '.jsonl')
            };
        }

        /** 追加一条记录到 spool 文件（同步写，避免回调时序问题；超上限后轮转） */
        function spoolAppend(filePath, record) {
            var fs = require('fs');
            try {
                var st = null;
                try { st = fs.statSync(filePath); } catch (e) {}
                if (st && st.size > SPOOL_MAX_BYTES) {
                    // 轮转：当前文件改名 .1（覆盖旧 .1），新数据写新文件，最多保留 2 份
                    try { fs.renameSync(filePath, filePath + '.1'); } catch (e) {}
                }
                fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
                return true;
            } catch (e) {
                node.warn('[PG-Store] Spool write failed: ' + e.message);
                return false;
            }
        }

        /** 最终失败的批次落盘（替代直接丢弃） */
        function spoolBatch(rows, columns, tableName, isMC, conflict, errMsg) {
            var p = spoolPaths();
            var ok = spoolAppend(p.active, {
                ts: new Date().toISOString(),
                error: errMsg || '',
                tableName: tableName, columns: columns,
                rows: rows, isMC: !!isMC, conflict: conflict || 'ignore'
            });
            if (ok) {
                node.warn('[PG-Store] ' + rows.length + ' rows spooled to disk (will replay on recovery)');
            }
            return ok;
        }

        /** 数据库恢复后重放 spool：成功则删除文件；仍不可用则保留剩余；确定性错误转死信 */
        function replaySpool() {
            if (_replaying) return;
            var fs = require('fs');
            var p = spoolPaths();
            var replayFile = p.active + '.replaying';
            var content;
            try {
                // 上次重放若异常中断（进程崩溃），先恢复 stranded 文件
                if (!fs.existsSync(p.active) && fs.existsSync(replayFile)) {
                    try { fs.renameSync(replayFile, p.active); } catch (e) {}
                }
                if (!fs.existsSync(p.active) || fs.statSync(p.active).size === 0) return;
                // 🔧 原子改名后再重放：重放期间新落盘的批次写入新的 active 文件，
                // finish() 用追加而不是覆写，避免竞态丢数据
                fs.renameSync(p.active, replayFile);
                content = fs.readFileSync(replayFile, 'utf8');
            } catch (e) { return; }
            var lines = content.split('\n').filter(function (l) { return l.trim(); });
            if (lines.length === 0) {
                try { fs.unlinkSync(replayFile); } catch (e) {}
                return;
            }

            _replaying = true;
            var idx = 0, replayedRows = 0, deadRows = 0;

            function finish(remaining) {
                try {
                    if (remaining.length > 0) {
                        // 追回到 active 文件（重放期间新落盘的批次已在新 active 文件中，追加不覆盖）
                        fs.appendFileSync(p.active, remaining.join('\n') + '\n');
                    }
                    fs.unlinkSync(replayFile);
                } catch (e) {
                    node.warn('[PG-Store] Spool rewrite failed: ' + e.message);
                }
                if (replayedRows > 0 || deadRows > 0 || remaining.length !== lines.length) {
                    node.warn('[PG-Store] Spool replay: ' + replayedRows + ' rows replayed, ' + deadRows + ' rows dead-lettered, ' + remaining.length + ' batches remain');
                    node.send({ payload: { event: 'spool_replay', success: remaining.length === 0, replayed: replayedRows, deadLettered: deadRows, remainingBatches: remaining.length } });
                }
                _replaying = false;
            }

            function next() {
                if (idx >= lines.length) { finish([]); return; }
                var rec;
                try {
                    rec = JSON.parse(lines[idx]);
                } catch (e) {
                    // 坏行 → 死信，继续
                    deadRows++;
                    spoolAppend(p.dead, { ts: new Date().toISOString(), error: 'corrupt line', raw: lines[idx].substring(0, 500) });
                    idx++; next(); return;
                }
                executeInsert(rec.rows, rec.columns, rec.tableName, rec.isMC, rec.conflict, function (result) {
                    if (result.ok) {
                        replayedRows += rec.rows.length;
                        idx++; next();
                    } else if (result.retry) {
                        // 数据库仍不可用 → 保留当前及后续行，停止重放
                        finish(lines.slice(idx));
                    } else {
                        // 确定性错误（数据类型/主键冲突等）→ 移入死信文件，继续后续批次
                        deadRows += rec.rows.length;
                        spoolAppend(p.dead, { ts: new Date().toISOString(), error: result.error || 'data_error', tableName: rec.tableName, columns: rec.columns, rows: rec.rows, isMC: rec.isMC, conflict: rec.conflict });
                        idx++; next();
                    }
                });
            }
            next();
        }

        registerPool(pgConfig, node.id, { setStatus: setStatus, send: function (m) { node.send(m); } });

        function ensureRetryTimer() {
            if (_retryTimer) return;
            if (_retryBuffer.length === 0) return;
            _retryTimer = setInterval(retryFlush, node.retryInterval);
        }
        function clearRetryTimer() {
            if (_retryTimer) { clearInterval(_retryTimer); _retryTimer = null; }
        }
        function setStatus(fill, text) {
            node.status({ fill: fill, shape: 'dot', text: text });
        }
        setStatus('green', 'ready');

        // 运行时冲突策略: msg > config
        var VALID_CONFLICTS = { 'ignore': true, 'update': true, 'none': true };
        function getConflict(msg) {
            var v = (msg && msg.conflictStrategy) || node.conflictStrategy || 'ignore';
            return VALID_CONFLICTS[v] ? v : 'ignore';
        }

        // ================================================================
        // 核心：执行批量 INSERT
        // ================================================================
        function executeInsert(rows, columns, tableName, isMC, conflict, callback) {
            var pool = getPool(pgConfig);
            var idCol = isMC ? 'device_id' : node.idColumn;
            var tsCol = isMC ? 'insert_time' : node.tsColumn;

            pool.connect(function (err, client) {
                if (err) {
                    callback({ ok: false, retry: true, count: 0, error: '[CONNECT] ' + err.message });
                    return;
                }

                client.query('SET statement_timeout = ' + (node.flushTimeout || 30000), function () {
                    var sql    = buildInsertSQL(tableName, columns, rows.length, conflict, idCol, tsCol);
                    var values = flattenRows(rows);

                    client.query(sql, values, function (err, result) {
                    if (!err) {
                        client.release();
                        if (_tableCreationFailed[tableName]) {
                            delete _tableCreationFailed[tableName];
                        }
                        callback({ ok: true, retry: false, count: result.rowCount, error: null });
                        return;
                    }

                    var errorType = classifyError(err);

                    if (errorType === 'table_not_found' && node.autoCreateTable &&
                        !_tableCreationFailed[tableName]) {
                        if (isMC) {
                            createMCTable(client, tableName, function (createErr) {
                                if (createErr) {
                                    _tableCreationFailed[tableName] = Date.now();
                                    client.release();
                                    node.warn('[PG-Store] Auto-create MC table failed: ' + createErr.message);
                                    callback({ ok: false, retry: false, count: 0, error: '[TABLE] ' + createErr.message });
                                    return;
                                }
                                client.query(sql, values, function (err2, result2) {
                                    client.release();
                                    if (err2) {
                                        var et2 = classifyError(err2);
                                        callback({ ok: false, retry: (et2 !== 'data_error'), count: 0, error: '[INSERT] ' + err2.message });
                                    } else {
                                        delete _tableCreationFailed[tableName];
                                        callback({ ok: true, retry: false, count: result2.rowCount, error: null });
                                    }
                                });
                            });
                            return;
                        }  // end isMC

                        // 🆕 通用格式建表：使用 idColumn + tsColumn
                        createGenericTable(client, tableName, columns, rows[0], idCol, tsCol, function (genErr) {
                            if (genErr) {
                                _tableCreationFailed[tableName] = Date.now();
                                client.release();
                                node.warn('[PG-Store] Auto-create generic table failed: ' + genErr.message);
                                callback({ ok: false, retry: false, count: 0, error: '[TABLE] ' + genErr.message });
                                return;
                            }
                            client.query(sql, values, function (err2, result2) {
                                client.release();
                                if (err2) {
                                    var et2 = classifyError(err2);
                                    callback({ ok: false, retry: (et2 !== 'data_error'), count: 0, error: '[INSERT] ' + err2.message });
                                } else {
                                    delete _tableCreationFailed[tableName];
                                    callback({ ok: true, retry: false, count: result2.rowCount, error: null });
                                }
                            });
                        });
                        return;
                    }

                    client.release();

                    if (errorType === 'data_error' || errorType === 'duplicate') {
                        // 🔧 #82: 不再提示 discarded — 批次将由 spoolBatch 落盘，恢复后重放/转死信
                        if (errorType === 'duplicate') {
                            node.warn('[PG-Store] Duplicate key: ' + err.message);
                        } else {
                            node.warn('[PG-Store] Data error: ' + err.message);
                        }
                        callback({ ok: false, retry: false, count: 0, error: '[' + errorType.toUpperCase() + '] ' + err.message });
                    } else if (errorType === 'table_not_found') {
                        _tableCreationFailed[tableName] = Date.now();
                        node.warn('[PG-Store] Table not found: ' + tableName);
                        callback({ ok: false, retry: false, count: 0, error: '[TABLE] ' + err.message });
                    } else {
                        callback({ ok: false, retry: true, count: 0, error: '[' + errorType.toUpperCase() + '] ' + err.message });
                    }
                });
            }); // SET statement_timeout
        }); // pool.connect
        }

        // ================================================================
        // MC 格式专用建表
        // ================================================================
        function createMCTable(client, tableName, callback) {
            var sql = 'CREATE TABLE IF NOT EXISTS ' + tableName + ' (' +
                'insert_time TIMESTAMPTZ NOT NULL, ' +
                'device_id VARCHAR(64) NOT NULL, ' +
                'tag_id VARCHAR(64) NOT NULL, ' +
                'register_type VARCHAR(8), ' +
                'raw_value NUMERIC, ' +
                'eng_value NUMERIC, ' +
                'quality INTEGER DEFAULT 0, ' +
                'PRIMARY KEY (insert_time, device_id, tag_id)' +
            ')';
            client.query(sql, function (err) {
                if (err) { callback(err); return; }
                var idxName = indexNameFor(tableName);
                var idxSQL = 'CREATE INDEX IF NOT EXISTS ' + idxName + ' ON ' +
                    tableName + ' (device_id, tag_id, insert_time DESC)';
                client.query(idxSQL, function (err2) {
                    if (err2) { callback(err2); return; }
                    if (node.useTimescaleDB) {
                        client.query("SELECT create_hypertable('" + tableName + "', 'insert_time', if_not_exists => TRUE)", function () {
                            callback(null);
                        });
                    } else { callback(null); }
                });
            });
        }

        // 🆕 通用格式建表：idColumn/tsColumn + 自动推断
        function createGenericTable(client, tableName, columns, sampleRow, idCol, tsCol, callback) {
            var colDefs = [];
            for (var ci = 0; ci < columns.length; ci++) {
                var col = columns[ci];
                var sample = sampleRow[ci];
                var pgType = 'TEXT';
                if (typeof sample === 'number') {
                    pgType = (sample % 1 === 0) ? 'NUMERIC' : 'DOUBLE PRECISION';
                } else if (typeof sample === 'string' && sample.length >= 10 &&
                           sample.indexOf('T') > 0 && !isNaN(Date.parse(sample))) {
                    pgType = 'TIMESTAMPTZ';
                }
                if (col === idCol) pgType += ' NOT NULL';
                if (col === tsCol) pgType += ' NOT NULL';
                colDefs.push(col + ' ' + pgType);
            }
            var pk = tsCol + ', ' + idCol;
            if (columns.indexOf(idCol) >= 0 && columns.indexOf(tsCol) >= 0) {
                colDefs.push('PRIMARY KEY (' + pk + ')');
            }
            var genSQL = 'CREATE TABLE IF NOT EXISTS ' + tableName + ' (' + colDefs.join(', ') + ')';
            client.query(genSQL, function (err) {
                if (err) { callback(err); return; }
                var idxName = indexNameFor(tableName);
                var idxSQL = 'CREATE INDEX IF NOT EXISTS ' + idxName + ' ON ' +
                    tableName + ' (' + idCol + ', ' + tsCol + ' DESC)';
                client.query(idxSQL, function (err2) {
                    if (err2) { callback(err2); return; }
                    if (node.useTimescaleDB) {
                        client.query("SELECT create_hypertable('" + tableName + "', '" + tsCol + "', if_not_exists => TRUE)", function () {
                            callback(null);
                        });
                    } else { callback(null); }
                });
            });
        }

        // ================================================================
        // 刷新主缓冲
        // ================================================================
        function flushBuffer(callback) {
            applyPendingSchemas();

            if (_writing) {
                if (typeof callback === 'function') callback();
                return;
            }
            if (_buffer.length === 0) {
                if (typeof callback === 'function') callback();
                return;
            }

            _writing = true;
            _roundStart = Date.now();

            var batch    = _buffer.splice(0, _buffer.length);
            var cols     = _bufferColumns;
            var tbl      = _bufferTable;
            var isMC     = _bufferIsMC;
            var conflict = _bufferConflict;
            var savedSize = batch.length;

            _bufferColumns = null;
            _bufferTable   = '';
            _bufferIsMC    = false;
            _bufferConflict = 'ignore';

            executeInsert(batch, cols, tbl, isMC, conflict, function (result) {
                _writing = false;
                applyPendingSchemas();

                if (result.ok) {
                    setStatus('green', 'inserted: ' + result.count);
                    node.send({ payload: {
                        event: 'flushed', success: true,
                        inserted: result.count, failed: 0,
                        buffered: _buffer.length, retryBuffered: _retryTotalRows,
                        tableName: tbl, roundTimeMs: Date.now() - _roundStart
                    }});
                    replaySpool();   // 🔧 #82: 有成功写入说明 DB 已恢复，尝试重放磁盘 spool
                } else if (result.retry) {
                    addToRetryBuffer(batch, cols, tbl, isMC, conflict);
                    setStatus('red', 'retry: ' + truncate(result.error, 30));
                    node.send({ payload: {
                        event: 'retry', success: false,
                        inserted: 0, failed: savedSize,
                        buffered: _buffer.length, retryBuffered: _retryTotalRows,
                        error: result.error, tableName: tbl
                    }});
                } else {
                    spoolBatch(batch, cols, tbl, isMC, conflict, result.error);   // 🔧 #82: 最终失败落盘 spool，不再直接丢弃
                    setStatus('red', 'spooled: ' + savedSize);
                    node.send({ payload: {
                        event: 'error', success: false, spooled: true,
                        inserted: 0, failed: savedSize,
                        buffered: _buffer.length, retryBuffered: _retryTotalRows,
                        error: result.error, tableName: tbl
                    }});
                }

                if (typeof callback === 'function') callback();
            });
        }

        function applyPendingSchemas() {
            if (_pendingSchemas.length === 0) return;
            var last = _pendingSchemas[_pendingSchemas.length - 1];
            _pendingSchemas = [];
            _bufferColumns = last.cols;
            _bufferTable   = last.tbl;
            _bufferIsMC    = last.isMC;
            _bufferConflict = last.conflict || 'ignore';
        }

        // ================================================================
        // 重试缓冲刷新
        // ================================================================
        function retryFlush() {
            if (_writing) return;
            if (_retryBuffer.length === 0) { clearRetryTimer(); return; }

            _writing = true;
            var entry = _retryBuffer.shift();
            _retryTotalRows -= entry.rows.length;

            executeInsert(entry.rows, entry.columns, entry.tableName, entry.isMC, entry.conflict || 'ignore', function (result) {
                _writing = false;
                if (result.ok) {
                    setStatus('green', 'retry ok: ' + result.count);
                    if (_retryBuffer.length === 0) clearRetryTimer();
                    replaySpool();   // 🔧 #82: 重试成功同样说明 DB 已恢复，尝试重放磁盘 spool
                } else if (result.retry) {
                    addToRetryBuffer(entry.rows, entry.columns, entry.tableName, entry.isMC, entry.conflict);
                    setStatus('red', 'retry fail');
                } else {
                    spoolBatch(entry.rows, entry.columns, entry.tableName, entry.isMC, entry.conflict, result.error);   // 🔧 #82: 重试最终失败同样落盘 spool
                    setStatus('red', 'spooled');
                    if (_retryBuffer.length === 0) clearRetryTimer();
                }
            });
        }

        function addToRetryBuffer(rows, columns, tableName, isMC, conflict) {
            if (rows.length === 0) return;
            if (_closing) {
                node.warn('[PG-Store] Closing: dropped ' + rows.length + ' rows (not retried)');
                return;
            }
            _retryBuffer.push({ rows: rows, columns: columns, tableName: tableName, isMC: isMC, conflict: conflict || 'ignore' });
            _retryTotalRows += rows.length;
            while (_retryTotalRows > node.retryBufferMax && _retryBuffer.length > 0) {
                var d = _retryBuffer.shift();
                _retryTotalRows -= d.rows.length;
                var dropMsg = '[PG-Store] retryBuffer full (max=' + node.retryBufferMax + '), dropped ' + d.rows.length + ' rows';
                node.warn(dropMsg);
                node.send({ payload: { event: 'dropped', success: false, dropped: d.rows.length, reason: 'retry_buffer_overflow', tableName: tableName || '', error: dropMsg } });
            }
            ensureRetryTimer();
        }

        function resetFlushTimer() {
            if (_flushTimer) clearTimeout(_flushTimer);
            if (node.flushInterval > 0) {
                _flushTimer = setTimeout(flushBuffer, node.flushInterval);
            }
        }

        // ================================================================
        // 确保缓冲列一致
        // ================================================================
        function ensureBuffer(cols, tbl, isMC, conflict) {
            var colsKey = cols.join(',');
            var curKey  = _bufferColumns ? _bufferColumns.join(',') : '';
            if (_buffer.length > 0 && (curKey !== colsKey || _bufferTable !== tbl)) {
                if (_writing) {
                    _pendingSchemas.push({ cols: cols, tbl: tbl, isMC: isMC, conflict: conflict });
                    return;
                }
                flushBuffer();
            }
            _bufferColumns = cols;
            _bufferTable   = tbl;
            _bufferIsMC    = isMC;
            _bufferConflict = conflict || 'ignore';
        }

        // ================================================================
        // 清理过期的 _tableCreationFailed 标记
        // ================================================================
        var _tableCleanTimer = setInterval(function () {
            var now = Date.now();
            var TTL = node.tableCreationFailedTTL;
            var keys = Object.keys(_tableCreationFailed);
            for (var i = 0; i < keys.length; i++) {
                if (now - _tableCreationFailed[keys[i]] > TTL) {
                    delete _tableCreationFailed[keys[i]];
                }
            }
        }, 300000);
        if (_tableCleanTimer.unref) _tableCleanTimer.unref();

        // ================================================================
        // 输入处理
        // ================================================================
        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            var _finished = false;
            function finish(err) {
                if (_finished) return;
                _finished = true;
                if (err) node.error('[PG-Store] Input exception: ' + err.message);
                if (done) {
                    try { done(); } catch (_) {}
                }
            }

            try {
                var payload = msg.payload;
                if (!payload || typeof payload !== 'object') {
                    node.warn('[PG-Store] Invalid input: payload must be an object');
                    return finish();
                }

                if (payload.success === false) return finish();

                var totalBuffered = _buffer.length + _retryTotalRows;
                if (totalBuffered > node.bufferMax * 2) {
                    if (!_writing) {
                        flushBuffer();
                    }
                    totalBuffered = _buffer.length + _retryTotalRows;
                    if (totalBuffered > node.bufferMax * 2) {
                        var dropFromMain = Math.min(_buffer.length, 500);
                        if (dropFromMain > 0) {
                            var dropped = _buffer.splice(0, dropFromMain);
                            var warnMsg = '[PG-Store] Memory guard: dropped ' + dropFromMain + ' rows (total=' + totalBuffered + ', max=' + node.bufferMax + ')';
                            node.warn(warnMsg);
                            send({ payload: { event: 'dropped', success: false, dropped: dropFromMain, reason: 'memory_guard', tableName: _bufferTable || '', error: warnMsg } });
                        }
                    }
                }

                var conflict = getConflict(msg);

                var format = detectFormat(payload);
                var rows, columns, tableName, isMC;

                if (format === 'mc') {
                    var deviceId = payload.deviceId || 'unknown';
                    tableName = resolveTableName(msg.tableName || node.tableName, deviceId);
                    rows   = parseMCFormat(payload);
                    columns = MC_COLUMNS;
                    isMC   = true;
                } else if (format === 'batch') {
                    tableName = resolveTableName(String(msg.tableName || msg.topic || node.tableName), '');
                    var rawRows = payload.rows;
                    if (!rawRows || !rawRows.length || !rawRows[0]) {
                        node.warn('[PG-Store] Empty rows array, skip'); return finish();
                    }
                    var originalColumns = Object.keys(rawRows[0]);
                    columns = originalColumns.map(sanitizeColumn);
                    rows = [];
                    for (var i = 0; i < rawRows.length; i++) {
                        var row = [];
                        for (var j = 0; j < originalColumns.length; j++) {
                            var v = rawRows[i][originalColumns[j]];
                            row.push(v != null ? v : null);
                        }
                        rows.push(row);
                    }
                    isMC = false;
                } else if (format === 'single') {
                    tableName = resolveTableName(String(msg.tableName || msg.topic || node.tableName), '');
                    var singleOriginalCols = Object.keys(payload);
                    columns = singleOriginalCols.map(sanitizeColumn);
                    var singleRow = [];
                    for (var sj = 0; sj < singleOriginalCols.length; sj++) {
                        var sv = payload[singleOriginalCols[sj]];
                        singleRow.push(sv != null ? sv : null);
                    }
                    rows = [singleRow];
                    isMC = false;
                } else {
                    node.warn('[PG-Store] Unknown payload format');
                    return finish();
                }

                if (rows.length === 0) {
                    node.warn('[PG-Store] No valid rows extracted');
                    return finish();
                }

                ensureBuffer(columns, tableName, isMC, conflict);

                for (var r = 0; r < rows.length; r++) {
                    _buffer.push(rows[r]);
                }
                if (_buffer.length > node.bufferMax) {
                    if (!_writing) {
                        flushBuffer();
                    }
                    if (_buffer.length > node.bufferMax) {
                        var overflow = _buffer.length - node.bufferMax;
                        var droppedOverflow = _buffer.splice(0, overflow);
                        var overflowMsg = '[PG-Store] buffer overflow, dropped ' + overflow + ' rows (table=' + (_bufferTable || '') + ')';
                        node.warn(overflowMsg);
                        send({ payload: { event: 'dropped', success: false, dropped: overflow, reason: 'buffer_overflow', tableName: _bufferTable || '', error: overflowMsg } });
                    }
                }

                var shouldFlush = _buffer.length >= node.batchSize || msg.flush === true;
                if (shouldFlush) {
                    flushBuffer();
                } else {
                    setStatus('yellow', 'buffer: ' + _buffer.length);
                }

                resetFlushTimer();
                finish();

            } catch (e) {
                finish(e);
            }
        });

        // ================================================================
        // 关闭
        // ================================================================
        node.on('close', function (done) {
            _closing = true;
            if (_flushTimer) clearTimeout(_flushTimer);
            if (_retryTimer) clearInterval(_retryTimer);
            if (_tableCleanTimer) clearInterval(_tableCleanTimer);

            var closed = false;
            function finish(reason) {
                if (closed) return;
                closed = true;
                if (reason) {
                    var unflushed = _buffer.length + _retryTotalRows;
                    if (unflushed > 0) {
                        node.warn('[PG-Store] Close (' + reason + '): ' + unflushed + ' rows unflushed');
                    }
                }
                releasePool(pgConfig, node.id);
                setStatus('grey', 'closed');
                if (typeof done === 'function') done();
            }

            var unflushedRows = _buffer.length + _retryTotalRows;
            var closeTimeoutMs = Math.min(60000, 10000 + Math.ceil(unflushedRows / 100) * 1000);

            var safetyTimer = setTimeout(function () {
                finish('forced after ' + closeTimeoutMs + 'ms timeout');
            }, closeTimeoutMs);

            function flushAll(next) {
                flushBuffer(function () {
                    if (_retryBuffer.length > 0 && !_writing) {
                        retryFlush();
                        setTimeout(function () { flushAll(next); }, 50);
                    } else {
                        next();
                    }
                });
            }

            flushAll(function () {
                clearTimeout(safetyTimer);
                finish();
            });
        });
    }

    function clampInt(value, defaultVal, min, max) {
        var n = parseInt(value, 10);
        if (isNaN(n)) n = defaultVal;
        if (n < min) n = min;
        if (n > max) n = max;
        return n;
    }

    function truncate(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.substring(0, maxLen) : str;
    }

    RED.nodes.registerType('edgelink-pg-store', EdgelinkPgStore);
};
