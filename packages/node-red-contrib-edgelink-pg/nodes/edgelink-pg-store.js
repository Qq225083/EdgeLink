/**
 * edgelink-pg-store.js — PG/TimescaleDB 批量写入节点 v1.6.2
 *
 * v1.6.2: 🔧 断库长期故障防丢数据——retryBuffer 溢出批次由「丢弃最旧」改为「落磁盘 spool」
 *          （DB 恢复后 replaySpool 自动重放；仅落盘失败才真正丢弃并告警）
 * v1.6.1: 🔧 spool 轮转归档 .1 重放（P0-8：旧实现 .1 永不消费且被覆盖静默销毁）+
 *          stranded .replaying 双存在合并恢复 + executeInsert 分片（1000行/片，65535 绑定上限）+
 *          重试救回/dropped 行计入心跳事件（EdgeLink Day7/P1-13 联动）+
 *          PG 停机演练通过（锁表注入：600 行零丢失零重复）
 * v1.6.0: 🔧 分段缓冲 — 修复写入在途时多表/多设备数据混入同一 buffer 导致的串表写；
 *          classifyError 白名单制(确定性错误不再无限重试，直接落 spool) +
 *          MC update 冲突目标补 tag_id + flush 定时器不再每条消息 reset +
 *          close 等待在途写入且剩余数据落 spool + spool 流式重放 + done(err) 支持 catch
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
        // 🔧 v1.6.0: 密码哈希进 key —— 同库不同密码的两个配置不再错误共享同一连接池
        var pw = typeof cfg.password === 'string' ? cfg.password : String(cfg.password || '');
        var h = 0;
        for (var i = 0; i < pw.length; i++) { h = ((h << 5) - h + pw.charCodeAt(i)) | 0; }
        return (cfg.user || 'postgres') + ':' + h + '@' +
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

    /** 🔧 v1.3.0: 可配置冲突策略；v1.6.0: 冲突目标列可配（MC 为 时间+设备+点位，须与 PK 完整匹配） */
    function buildInsertSQL(tableName, columns, rowCount, conflict, conflictCols) {
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
        } else if (conflict === 'update' && conflictCols && conflictCols.length > 0) {
            var inTarget = {};
            for (var k = 0; k < conflictCols.length; k++) inTarget[conflictCols[k]] = true;
            var setCols = columns.filter(function (c) { return !inTarget[c]; });
            if (setCols.length > 0) {
                var setClauses = setCols.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ');
                sql += ' ON CONFLICT (' + conflictCols.join(', ') + ') DO UPDATE SET ' + setClauses;
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

    // 🔧 v1.6.0: 白名单制 —— 仅连接类/明确瞬态的错误可重试；
    // 未知错误一律视为确定性错误（落 spool/死信），杜绝 42P10/42804 等错误无限重试
    var RETRYABLE_CODES = {
        'ECONNREFUSED': true, 'ETIMEDOUT': true, 'ECONNRESET': true, 'EPIPE': true,
        'ENOTFOUND': true, 'EHOSTUNREACH': true, 'ENETUNREACH': true, 'EAI_AGAIN': true,
        '57P01': true,   // admin_shutdown
        '57P02': true,   // crash_shutdown
        '57P03': true,   // cannot_connect_now
        '53300': true,   // too_many_connections
        '53400': true,   // configuration_limit_exceeded
        '55P03': true,   // lock_not_available
        '40001': true,   // serialization_failure
        '40P01': true    // deadlock_detected
    };

    function classifyError(err) {
        if (!err) return 'retry';
        var code = err.code || '';
        if (RETRYABLE_CODES[code]) return 'connection';
        if (code.indexOf('08') === 0) return 'connection';   // SQLSTATE 08xxx 连接异常类
        if (code === '42P01') return 'table_not_found';
        if (code === '23505') return 'duplicate';
        // 22P02 非法文本 / 22003 数值越界 / 42804 类型不匹配 / 42703 列不存在 / 42P10 冲突目标无效
        // 及其余未知错误 → 确定性错误，不重试
        return 'data_error';
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
        // 🔧 v1.6.0: 分段缓冲 —— 每段绑定自己的 schema(列/表/格式/冲突策略)，
        // 替代旧的 单buffer+_pendingSchemas（该方案在写入在途时会把不同表的行混进同一 buffer）
        var _segments      = [];    // [{cols, tbl, isMC, conflict, rows: []}]
        var _bufferRows    = 0;     // 所有段的总行数（bufferMax 记账用）
        var _writeWaiters  = [];    // 等待"缓冲排空且在途写入完成"的回调（close 用）
        var _lastFlushOk   = true;  // 最近一次写库是否成功（close 时决定是否还尝试刷重试缓冲）
        var _retryBuffer   = [];
        var _retryTotalRows = 0;
        var _writing       = false;
        var _closing       = false;
        var _tableCreationFailed = {};
        var _updateDegradeWarned = {};
        var _flushTimer    = null;
        var _retryTimer    = null;
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
                    // 🔧 v1.6.1/P0-8: 覆盖非空旧 .1 前必须告警（PG 长停机时 replay 不触发，此处是最后的呼救）
                    try {
                        var old = fs.statSync(filePath + '.1');
                        if (old && old.size > 0) {
                            node.warn('[PG-Store] ⚠ Spool 轮转将覆盖未重放的归档 ' + filePath + '.1（' + Math.round(old.size / 1048576) + 'MB）——数据将丢失！请尽快恢复 PG 或扩容');
                            sendEvent({ payload: { event: 'spool_archive_overwrite', success: false, file: filePath + '.1', bytes: old.size } });
                        }
                    } catch (e0) {}
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

        /** 🔧 v1.6.0: 关闭时把内存中未写完的数据（主缓冲各段 + 重试缓冲）全部落盘，重启后自动重放 */
        function spoolRemaining(reason) {
            var total = 0, i, seg, entry;
            for (i = 0; i < _segments.length; i++) {
                seg = _segments[i];
                if (seg.rows.length > 0) {
                    spoolBatch(seg.rows, seg.cols, seg.tbl, seg.isMC, seg.conflict, reason);
                    total += seg.rows.length;
                }
            }
            _segments = [];
            _bufferRows = 0;
            for (i = 0; i < _retryBuffer.length; i++) {
                entry = _retryBuffer[i];
                if (entry.rows.length > 0) {
                    spoolBatch(entry.rows, entry.columns, entry.tableName, entry.isMC, entry.conflict, reason);
                    total += entry.rows.length;
                }
            }
            _retryBuffer = [];
            _retryTotalRows = 0;
            if (total > 0) {
                node.warn('[PG-Store] Close: ' + total + ' unflushed rows spooled to disk (' + reason + ')');
            }
        }

        /** 🔧 v1.6.0: 流式行读取器 —— 1MB 分块读，避免整个 spool 文件（上限 100MB）
         *  一次性 readFileSync 进内存并 split，冻住 Node-RED 事件循环 */
        function createLineReader(filePath) {
            var fs = require('fs');
            var StringDecoder = require('string_decoder').StringDecoder;
            var fd = fs.openSync(filePath, 'r');
            var buf = Buffer.alloc(1024 * 1024);
            var decoder = new StringDecoder('utf8');
            var leftover = '';
            var eof = false;
            return {
                nextLine: function () {
                    for (;;) {
                        var nl = leftover.indexOf('\n');
                        if (nl >= 0) {
                            var line = leftover.slice(0, nl);
                            leftover = leftover.slice(nl + 1);
                            return line;
                        }
                        if (eof) {
                            if (leftover.length > 0) { var last = leftover; leftover = ''; return last; }
                            return null;
                        }
                        var bytes = fs.readSync(fd, buf, 0, buf.length, null);
                        if (bytes === 0) {
                            eof = true;
                            leftover += decoder.end();
                        } else {
                            leftover += decoder.write(buf.slice(0, bytes));
                        }
                    }
                },
                close: function () { try { fs.closeSync(fd); } catch (e) {} }
            };
        }

        /** 数据库恢复后重放 spool：成功则删除文件；仍不可用则保留剩余；确定性错误转死信 */
        function replaySpool() {
            if (_replaying || _closing) return;
            var fs = require('fs');
            var p = spoolPaths();
            var replayFile = p.active + '.replaying';
            try {
                // 🔧 v1.6.1: stranded .replaying 恢复——active 存在与否都合并回去
                // （旧逻辑只在 active 不存在时恢复；两者皆存 = 上次重放中崩溃且期间有新写入 → 永久搁浅丢数据）
                if (fs.existsSync(replayFile)) {
                    if (!fs.existsSync(p.active)) {
                        try { fs.renameSync(replayFile, p.active); } catch (e) {}
                    } else {
                        try {
                            var stranded = fs.readFileSync(replayFile);
                            if (stranded.length > 0) fs.appendFileSync(p.active, stranded);
                            fs.unlinkSync(replayFile);
                            node.warn('[PG-Store] 合并搁浅的 .replaying 文件回 active spool');
                        } catch (e) { return; }  // 下轮再试
                    }
                }
                // 🔧 v1.6.1/P0-8: 轮转归档 .1 优先重放（最老数据先入库）；
                // 旧实现只读 active：.1 永不被消费，下次轮转 renameSync 覆盖 = 数据静默销毁
                var archive = p.active + '.1';
                var source = p.active;
                if (fs.existsSync(archive) && fs.statSync(archive).size > 0) source = archive;
                if (!fs.existsSync(source) || fs.statSync(source).size === 0) return;
                // 🔧 原子改名后再重放：重放期间新落盘的批次写入新的 active 文件，
                // 中止时剩余行追加回去而不是覆写，避免竞态丢数据
                fs.renameSync(source, replayFile);
            } catch (e) { return; }

            _replaying = true;
            var reader;
            try { reader = createLineReader(replayFile); }
            catch (e) { _replaying = false; return; }
            var replayedRows = 0, deadRows = 0;

            function finish(abortLine) {
                // abortLine != null：DB 仍不可用，中止重放 —— 当前行及剩余行追回到 active 文件
                try {
                    if (abortLine != null) {
                        var rest = [abortLine], l;
                        while ((l = reader.nextLine()) != null) { if (l.trim()) rest.push(l); }
                        if (rest.length > 0) fs.appendFileSync(p.active, rest.join('\n') + '\n');
                    }
                } catch (e) {
                    node.warn('[PG-Store] Spool rewrite failed: ' + e.message);
                }
                reader.close();
                try { fs.unlinkSync(replayFile); } catch (e) {}
                if (replayedRows > 0 || deadRows > 0 || abortLine != null) {
                    node.warn('[PG-Store] Spool replay: ' + replayedRows + ' rows replayed, ' + deadRows + ' rows dead-lettered' + (abortLine != null ? ', replay paused (DB still down)' : ', done'));
                    sendEvent({ payload: { event: 'spool_replay', success: abortLine == null, replayed: replayedRows, deadLettered: deadRows } });
                }
                _replaying = false;
                // 🔧 v1.6.1: 完整重放成功后若还有归档/积压，接力下一轮（直到清空）
                if (abortLine == null) {
                    try {
                        var moreA = fs.existsSync(p.active + '.1') && fs.statSync(p.active + '.1').size > 0;
                        var moreB = fs.existsSync(p.active) && fs.statSync(p.active).size > 0;
                        if (moreA || moreB) setTimeout(replaySpool, 0);
                    } catch (e) {}
                }
            }

            function next() {
                var line = reader.nextLine();
                if (line == null) { finish(null); return; }
                if (!line.trim()) { next(); return; }
                var rec;
                try {
                    rec = JSON.parse(line);
                } catch (e) {
                    // 坏行 → 死信，继续
                    deadRows++;
                    spoolAppend(p.dead, { ts: new Date().toISOString(), error: 'corrupt line', raw: line.substring(0, 500) });
                    next(); return;
                }
                executeInsert(rec.rows, rec.columns, rec.tableName, rec.isMC, rec.conflict, function (result) {
                    if (result.ok) {
                        replayedRows += rec.rows.length;
                        next();
                    } else if (result.retry) {
                        // 数据库仍不可用 → 保留当前及后续行，停止重放
                        // 🔧 v1.6.2: 分片部分成功时只保留未插入的行（防重放重复；有唯一索引时幂等，无则防重）
                        var restLine = line;
                        if (result.count > 0 && rec && Array.isArray(rec.rows) && result.count < rec.rows.length) {
                            try { restLine = JSON.stringify(Object.assign({}, rec, { rows: rec.rows.slice(result.count) })); } catch (e) {}
                        }
                        finish(restLine);
                    } else {
                        // 确定性错误（数据类型/主键冲突等）→ 移入死信文件，继续后续批次
                        deadRows += rec.rows.length;
                        spoolAppend(p.dead, { ts: new Date().toISOString(), error: result.error || 'data_error', tableName: rec.tableName, columns: rec.columns, rows: rec.rows, isMC: rec.isMC, conflict: rec.conflict });
                        next();
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
            // 🔧 v1.6.2: 冲突目标必须匹配目标表唯一键——
            // MC 格式（其自动建表为 3 列 PK）：[insert_time, device_id, tag_id]
            // 通用/batch 格式（实表 edgelink.plc_data 唯一索引 4 列）：[insert_time, node_id, device_id, tag_id]
            // 缺列时由下方 degrade 逻辑降级为 DO NOTHING（不崩 42P10）
            var conflictCols = isMC ? [tsCol, idCol, 'tag_id'] : [tsCol, 'node_id', idCol, 'tag_id'];

            pool.connect(function (err, client) {
                if (err) {
                    // 🔧 v1.6.0: 连接失败也按白名单分类 —— 认证失败等确定性错误直接落 spool，不再无限重试
                    callback({ ok: false, retry: (classifyError(err) === 'connection'), count: 0, error: '[CONNECT] ' + err.message });
                    return;
                }

                client.query('SET statement_timeout = ' + (node.flushTimeout || 30000), function (setErr) {
                    // 🔧 v1.6.0: SET 失败不再无视 —— 在死连接上继续 INSERT 只会多丢一批
                    if (setErr) {
                        var setType = classifyError(setErr);
                        client.release();
                        callback({ ok: false, retry: (setType === 'connection'), count: 0, error: '[' + setType.toUpperCase() + '] ' + setErr.message });
                        return;
                    }
                    // update 策略但数据缺少冲突目标列 → 降级 DO NOTHING（每表只告警一次）
                    if (conflict === 'update') {
                        for (var cc = 0; cc < conflictCols.length; cc++) {
                            if (columns.indexOf(conflictCols[cc]) < 0) {
                                if (!_updateDegradeWarned[tableName]) {
                                    _updateDegradeWarned[tableName] = true;
                                    node.warn('[PG-Store] conflict=update 需要列 ' + conflictCols.join(',') + '，表 ' + tableName + ' 的数据缺少 ' + conflictCols[cc] + '，降级为 DO NOTHING');
                                }
                                conflict = 'ignore';
                                break;
                            }
                        }
                    }
                    // 🔧 v1.6.1/P2-20: 分片插入 —— 单片最多 1000 行（13 列×1000=13000 绑定参数，
                    // 远低于 PG 65535 上限；旧实现整批一条 SQL，bufferMax 调大即溢出报 08P01）
                    var CHUNK_ROWS = 1000;
                    var chunks = [];
                    for (var ci = 0; ci < rows.length; ci += CHUNK_ROWS) chunks.push(rows.slice(ci, ci + CHUNK_ROWS));
                    var totalInserted = 0;

                    function runChunk(idx) {
                        if (idx >= chunks.length) {
                            client.release();
                            if (_tableCreationFailed[tableName]) delete _tableCreationFailed[tableName];
                            callback({ ok: true, retry: false, count: totalInserted, error: null });
                            return;
                        }
                        var chunkRows = chunks[idx];
                        var sql    = buildInsertSQL(tableName, columns, chunkRows.length, conflict, conflictCols);
                        var values = flattenRows(chunkRows);

                        client.query(sql, values, function (err, result) {
                            if (!err) {
                                totalInserted += result.rowCount;
                                runChunk(idx + 1);
                                return;
                            }
                            var errorType = classifyError(err);
                            if (errorType === 'table_not_found' && node.autoCreateTable &&
                                !_tableCreationFailed[tableName]) {
                                var afterCreate = function (createErr) {
                                    if (createErr) {
                                        _tableCreationFailed[tableName] = Date.now();
                                        client.release();
                                        node.warn('[PG-Store] Auto-create table failed: ' + createErr.message);
                                        callback({ ok: false, retry: false, count: totalInserted, error: '[TABLE] ' + createErr.message });
                                        return;
                                    }
                                    client.query(sql, values, function (err2, result2) {
                                        if (err2) {
                                            client.release();
                                            var et2 = classifyError(err2);
                                            callback({ ok: false, retry: (et2 === 'connection'), count: totalInserted, error: '[INSERT] ' + err2.message });
                                        } else {
                                            delete _tableCreationFailed[tableName];
                                            totalInserted += result2.rowCount;
                                            runChunk(idx + 1);
                                        }
                                    });
                                };
                                if (isMC) { createMCTable(client, tableName, afterCreate); }
                                else { createGenericTable(client, tableName, columns, chunkRows[0], idCol, tsCol, afterCreate); }
                                return;
                            }
                            client.release();
                            if (errorType === 'data_error' || errorType === 'duplicate') {
                                if (errorType === 'duplicate') {
                                    node.warn('[PG-Store] Duplicate key: ' + err.message);
                                } else {
                                    node.warn('[PG-Store] Data error: ' + err.message);
                                }
                                callback({ ok: false, retry: false, count: totalInserted, error: '[' + errorType.toUpperCase() + '] ' + err.message });
                            } else if (errorType === 'table_not_found') {
                                _tableCreationFailed[tableName] = Date.now();
                                node.warn('[PG-Store] Table not found: ' + tableName);
                                callback({ ok: false, retry: false, count: totalInserted, error: '[TABLE] ' + err.message });
                            } else {
                                callback({ ok: false, retry: true, count: totalInserted, error: '[' + errorType.toUpperCase() + '] ' + err.message });
                            }
                        });
                    }
                    runChunk(0);
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
                        client.query("SELECT create_hypertable('" + tableName + "', 'insert_time', if_not_exists => TRUE)", function (hErr) {
                            // 🔧 v1.6.0: 不再静默吞错 —— 扩展缺失/失败时告警，表仍按普通表使用
                            if (hErr) node.warn('[PG-Store] create_hypertable(' + tableName + ') failed, 按普通表继续使用: ' + hErr.message);
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
                if (typeof sample === 'boolean') {
                    pgType = 'BOOLEAN';   // 🔧 v1.6.0: 旧逻辑推断成 TEXT，插入 boolean 必报 42804
                } else if (typeof sample === 'number') {
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
                        client.query("SELECT create_hypertable('" + tableName + "', '" + tsCol + "', if_not_exists => TRUE)", function (hErr) {
                            // 🔧 v1.6.0: 不再静默吞错 —— 扩展缺失/失败时告警，表仍按普通表使用
                            if (hErr) node.warn('[PG-Store] create_hypertable(' + tableName + ') failed, 按普通表继续使用: ' + hErr.message);
                            callback(null);
                        });
                    } else { callback(null); }
                });
            });
        }

        // ================================================================
        // 🔧 v1.6.0: 分段缓冲 —— 每段绑定自己的 schema(列/表/格式/冲突策略)。
        // 旧方案(单 buffer + _pendingSchemas)在写入在途时收到不同表/schema 的数据，
        // 会把行混进同一 buffer，flush 时按最后一个 schema 整批插入 ——
        // 设备 A 的数据被写进设备 B 的表（串表，且 MC 列相同所以插入"成功"，无报错）
        // ================================================================
        function appendRows(cols, tbl, isMC, conflict, rows) {
            var tail = _segments[_segments.length - 1];
            if (!tail || tail.cols.join(',') !== cols.join(',') || tail.tbl !== tbl) {
                tail = { cols: cols, tbl: tbl, isMC: isMC, conflict: conflict || 'ignore', rows: [] };
                _segments.push(tail);
            }
            for (var i = 0; i < rows.length; i++) tail.rows.push(rows[i]);
            _bufferRows += rows.length;
        }

        /** 从最老的段开始丢弃 n 行（内存保护用），返回实际丢弃行数 */
        function dropFromHead(n) {
            var dropped = 0;
            while (n > 0 && _segments.length > 0) {
                var head = _segments[0];
                var take = Math.min(n, head.rows.length);
                head.rows.splice(0, take);
                _bufferRows -= take;
                dropped += take;
                n -= take;
                if (head.rows.length === 0) _segments.shift();
            }
            return dropped;
        }

        function headTable() {
            return _segments.length > 0 ? _segments[0].tbl : '';
        }

        function drainWriteWaiters() {
            var w = _writeWaiters;
            _writeWaiters = [];
            for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
        }

        /** 关闭中不再 node.send（节点正在下线），其余路径正常发事件 */
        function sendEvent(m) {
            if (_closing) return;
            node.send(m);
        }

        // ================================================================
        // 刷新主缓冲：逐段写入，写完一段自动续下一段；
        // 连接类失败(DB 大概率仍不可用)即停下，避免剩余段逐段空耗连接超时，
        // 后续由重试成功 / flush 定时器 / 新输入接力
        // ================================================================
        function flushBuffer(callback) {
            if (typeof callback === 'function') _writeWaiters.push(callback);
            if (_writing) return;
            if (_segments.length === 0) { drainWriteWaiters(); return; }

            _writing = true;
            _roundStart = Date.now();

            var seg = _segments.shift();
            _bufferRows -= seg.rows.length;

            executeInsert(seg.rows, seg.cols, seg.tbl, seg.isMC, seg.conflict, function (result) {
                _writing = false;

                if (result.ok) {
                    _lastFlushOk = true;
                    setStatus('green', 'inserted: ' + result.count);
                    sendEvent({ payload: {
                        event: 'flushed', success: true,
                        inserted: result.count, failed: 0,
                        buffered: _bufferRows, retryBuffered: _retryTotalRows,
                        tableName: seg.tbl, roundTimeMs: Date.now() - _roundStart
                    }});
                    replaySpool();   // 🔧 #82: 有成功写入说明 DB 已恢复，尝试重放磁盘 spool
                } else if (result.retry) {
                    _lastFlushOk = false;
                    addToRetryBuffer(seg.rows.slice(result.count || 0), seg.cols, seg.tbl, seg.isMC, seg.conflict);  // 🔧 v1.6.2/评审#9：分片后仅回灌未成功部分（防非唯一约束表重复行）
                    setStatus('red', 'retry: ' + truncate(result.error, 30));
                    sendEvent({ payload: {
                        event: 'retry', success: false,
                        inserted: 0, failed: seg.rows.length,
                        buffered: _bufferRows, retryBuffered: _retryTotalRows,
                        error: result.error, tableName: seg.tbl
                    }});
                } else {
                    spoolBatch(seg.rows.slice(result.count || 0), seg.cols, seg.tbl, seg.isMC, seg.conflict, result.error);   // 🔧 #82+v1.6.2: 最终失败仅落未成功分片
                    setStatus('red', 'spooled: ' + seg.rows.length);
                    sendEvent({ payload: {
                        event: 'error', success: false, spooled: true,
                        inserted: 0, failed: seg.rows.length,
                        buffered: _bufferRows, retryBuffered: _retryTotalRows,
                        error: result.error, tableName: seg.tbl
                    }});
                }

                if (_segments.length > 0 && (result.ok || !result.retry)) {
                    flushBuffer();
                } else {
                    drainWriteWaiters();
                }
            });
        }

        // ================================================================
        // 重试缓冲刷新
        // ================================================================
        function retryFlush(callback) {
            if (_writing) { if (typeof callback === 'function') callback(); return; }
            if (_retryBuffer.length === 0) { clearRetryTimer(); if (typeof callback === 'function') callback(); return; }

            _writing = true;
            var entry = _retryBuffer.shift();
            _retryTotalRows -= entry.rows.length;

            executeInsert(entry.rows, entry.columns, entry.tableName, entry.isMC, entry.conflict || 'ignore', function (result) {
                _writing = false;
                if (result.ok) {
                    _lastFlushOk = true;
                    setStatus('green', 'retry ok: ' + result.count);
                    // 🔧 Day7/P1-13: 重试救回的行也要计入成功数（此前心跳 success 长期低估）
                    sendEvent({ payload: { event: 'inserted', success: true, inserted: result.count, failed: 0, retried: true } });
                    if (_retryBuffer.length === 0) clearRetryTimer();
                    replaySpool();   // 🔧 #82: 重试成功同样说明 DB 已恢复，尝试重放磁盘 spool
                    if (!_closing && _segments.length > 0) flushBuffer();   // DB 已恢复，接力刷主缓冲
                } else if (result.retry) {
                    _lastFlushOk = false;
                    addToRetryBuffer(entry.rows.slice(result.count || 0), entry.columns, entry.tableName, entry.isMC, entry.conflict);  // 🔧 v1.6.2
                    setStatus('red', 'retry fail');
                } else {
                    spoolBatch(entry.rows.slice(result.count || 0), entry.columns, entry.tableName, entry.isMC, entry.conflict, result.error);   // 🔧 #82+v1.6.2
                    setStatus('red', 'spooled');
                    if (_retryBuffer.length === 0) clearRetryTimer();
                }
                if (typeof callback === 'function') callback();
            });
        }

        function addToRetryBuffer(rows, columns, tableName, isMC, conflict) {
            if (rows.length === 0) return;
            if (_closing) {
                // 🔧 v1.6.0: 关闭中不再丢弃，落 spool 待重启后重放
                node.warn('[PG-Store] Closing: spooled ' + rows.length + ' rows (not retried)');
                spoolBatch(rows, columns, tableName, isMC, conflict, 'node closing');
                return;
            }
            _retryBuffer.push({ rows: rows, columns: columns, tableName: tableName, isMC: isMC, conflict: conflict || 'ignore' });
            _retryTotalRows += rows.length;
            while (_retryTotalRows > node.retryBufferMax && _retryBuffer.length > 0) {
                var d = _retryBuffer.shift();
                _retryTotalRows -= d.rows.length;
                // 🔧 v1.6.2: 断库长期故障不再丢数据——溢出批次落磁盘 spool（DB 恢复后 replaySpool 自动重放）；
                //    仅当落盘也失败时才真正丢弃（兜底告警，心跳可见）
                if (spoolBatch(d.rows, d.columns, d.tableName, d.isMC, d.conflict, 'retry_buffer_overflow')) {
                    var spillMsg = '[PG-Store] retryBuffer full (max=' + node.retryBufferMax + '), spilled ' + d.rows.length + ' rows to disk spool（断库过久，DB 恢复后自动重放）';
                    node.warn(spillMsg);
                    sendEvent({ payload: { event: 'spilled', success: false, rows: d.rows.length, failed: 0, reason: 'retry_buffer_overflow', tableName: d.tableName || '', error: '' } });
                } else {
                    var dropMsg = '[PG-Store] retryBuffer full (max=' + node.retryBufferMax + '), spool write FAILED, dropped ' + d.rows.length + ' rows';
                    node.warn(dropMsg);
                    sendEvent({ payload: { event: 'dropped', success: false, dropped: d.rows.length, failed: d.rows.length, reason: 'retry_buffer_overflow', tableName: d.tableName || '', error: dropMsg } });  // 🔧 Day7: 丢行计入 fail（心跳可见）
                }
            }
            ensureRetryTimer();
        }

        // ================================================================
        // flush 定时器
        // 🔧 v1.6.0: 不再每条消息 reset —— 旧逻辑下持续低速数据不断重置定时器，
        // 定时 flush 永远触发不了，延迟退化为"攒满 batchSize 为止"。
        // 现在只在有数据且定时器未运行时启动一次，触发后仍有数据再续。
        // ================================================================
        function startFlushTimer() {
            if (node.flushInterval <= 0 || _flushTimer) return;
            _flushTimer = setTimeout(function () {
                _flushTimer = null;
                flushBuffer();
                if (_bufferRows > 0) startFlushTimer();
            }, node.flushInterval);
        }
        function stopFlushTimer() {
            if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
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
                if (err) node.error('[PG-Store] Input exception: ' + err.message, msg);
                if (done) {
                    // 🔧 v1.6.0: 异常时 done(err)，下游 catch 节点可以捕获
                    try { err ? done(err) : done(); } catch (_) {}
                }
            }

            try {
                var payload = msg.payload;
                if (!payload || typeof payload !== 'object') {
                    node.warn('[PG-Store] Invalid input: payload must be an object');
                    return finish();
                }

                if (payload.success === false) return finish();

                // 内存保护：总量超 2×bufferMax 时先尝试 flush，仍超则丢最老的行
                var totalBuffered = _bufferRows + _retryTotalRows;
                if (totalBuffered > node.bufferMax * 2) {
                    if (!_writing) {
                        flushBuffer();
                    }
                    totalBuffered = _bufferRows + _retryTotalRows;
                    if (totalBuffered > node.bufferMax * 2) {
                        var guardTbl = headTable();
                        var guardDropped = dropFromHead(500);
                        if (guardDropped > 0) {
                            var warnMsg = '[PG-Store] Memory guard: dropped ' + guardDropped + ' rows (total=' + totalBuffered + ', max=' + node.bufferMax + ')';
                            node.warn(warnMsg);
                            sendEvent({ payload: { event: 'dropped', success: false, dropped: guardDropped, failed: guardDropped, reason: 'memory_guard', tableName: guardTbl, error: warnMsg } });  // 🔧 Day7
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

                appendRows(columns, tableName, isMC, conflict, rows);

                if (_bufferRows > node.bufferMax) {
                    if (!_writing) {
                        flushBuffer();
                    }
                    if (_bufferRows > node.bufferMax) {
                        var overflowTbl = headTable();
                        var overflowDropped = dropFromHead(_bufferRows - node.bufferMax);
                        var overflowMsg = '[PG-Store] buffer overflow, dropped ' + overflowDropped + ' rows (table=' + overflowTbl + ')';
                        node.warn(overflowMsg);
                        sendEvent({ payload: { event: 'dropped', success: false, dropped: overflowDropped, failed: overflowDropped, reason: 'buffer_overflow', tableName: overflowTbl, error: overflowMsg } });  // 🔧 Day7
                    }
                }

                var shouldFlush = _bufferRows >= node.batchSize || msg.flush === true;
                if (shouldFlush) {
                    flushBuffer();
                } else {
                    setStatus('yellow', 'buffer: ' + _bufferRows);
                }

                startFlushTimer();
                finish();

            } catch (e) {
                finish(e);
            }
        });

        // ================================================================
        // 关闭
        // 🔧 v1.6.0: 等待在途写入完成后再释放连接池（旧逻辑 _writing 时立即放行，
        // pool 提前 end）；未能写完的数据(主缓冲各段 + 重试缓冲)全部落 spool，
        // 重部署/重启不再丢数据，DB 恢复后自动重放
        // ================================================================
        node.on('close', function (done) {
            _closing = true;
            stopFlushTimer();
            if (_retryTimer) clearInterval(_retryTimer);
            if (_tableCleanTimer) clearInterval(_tableCleanTimer);

            var closed = false;
            function finish(reason) {
                if (closed) return;
                closed = true;
                spoolRemaining(reason || 'close');
                releasePool(pgConfig, node.id);
                setStatus('grey', 'closed');
                if (typeof done === 'function') done();
            }

            var unflushedRows = _bufferRows + _retryTotalRows;
            var closeTimeoutMs = Math.min(60000, 10000 + Math.ceil(unflushedRows / 100) * 1000);

            var safetyTimer = setTimeout(function () {
                finish('forced after ' + closeTimeoutMs + 'ms timeout');
            }, closeTimeoutMs);

            // DB 可达时把重试缓冲也尽量写完；不可达则直接交给 spoolRemaining 落盘
            function drainRetryThen(next) {
                if (_retryBuffer.length === 0 || !_lastFlushOk) return next();
                retryFlush(function () { drainRetryThen(next); });
            }

            // flushBuffer 的 waiter 触发时：_writing=false 且分段链已停（排空或 DB 不可用）
            flushBuffer(function () {
                drainRetryThen(function () {
                    clearTimeout(safetyTimer);
                    finish();
                });
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
