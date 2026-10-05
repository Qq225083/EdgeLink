'use strict';

module.exports = function (RED) {
  function ChangeToSqlNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.table = String(config.table || '').trim();
    node.timeColumn = String(config.timeColumn || 'insert_time').trim();
    node.tagColumn = String(config.tagColumn || 'tag_id').trim();
    node.valueColumn = String(config.valueColumn || 'value').trim();
    node.keyField = String(config.keyField || 'equipment_id').trim() || 'equipment_id';
    node.outputFormat = config.outputFormat === 'rows' ? 'rows' : 'sql';

    // 表名/列名直接拼进 SQL，必须限制为合法标识符（库.表 允许一段小数点）
    var identRe = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
    var identOk = identRe.test(node.table) &&
      identRe.test(node.timeColumn) && identRe.test(node.tagColumn) && identRe.test(node.valueColumn);

    var mappingErr = null;
    node.mapping = {};
    try {
      node.mapping = config.fieldMapping ? JSON.parse(config.fieldMapping) : {};
    } catch (e) {
      mappingErr = e;
    }

    if (!node.table || !identOk) {
      node.status({ fill: 'red', shape: 'ring', text: '表名/列名配置非法' });
      node.error('change-to-sql: table/timeColumn/tagColumn/valueColumn 为空或含非法字符');
    } else if (mappingErr) {
      node.status({ fill: 'red', shape: 'ring', text: '映射表 JSON 解析失败' });
      node.error('change-to-sql: fieldMapping JSON 解析失败: ' + mappingErr.message);
    }

    // 先查设备专属映射，再回落 "*" 公共默认；查不到返回 undefined
    function lookupTagId(key, field) {
      var perKey = node.mapping[key];
      if (perKey && Object.prototype.hasOwnProperty.call(perKey, field)) return perKey[field];
      var def = node.mapping['*'];
      if (def && Object.prototype.hasOwnProperty.call(def, field)) return def[field];
      return undefined;
    }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      if (!node.table || !identOk || mappingErr) {
        var cfgErr = new Error('change-to-sql: 节点配置非法，拒绝处理（检查表名/列名/映射表 JSON）');
        if (done) { done(cfgErr); } else { node.error(cfgErr, msg); }
        return;
      }

      try {
        var records = Array.isArray(msg.payload) ? msg.payload : [];
        var ts = new Date().toISOString();
        var outRows = []; // { ts, tagId, value }
        var skipped = {};

        records.forEach(function (rec) {
          if (!rec || typeof rec !== 'object' || !Array.isArray(rec._changed_fields)) return;
          var key = String(rec[node.keyField]);
          rec._changed_fields.forEach(function (f) {
            var tagId = lookupTagId(key, f);
            if (tagId === undefined) {
              skipped[key + '.' + f + '(无映射)'] = true;
              return;
            }
            var v = rec[f];
            if (typeof v !== 'number' || !isFinite(v)) {
              skipped[key + '.' + f + '(非数值)'] = true;
              return;
            }
            outRows.push({ ts: ts, tagId: Number(tagId), value: v });
          });
        });

        var skippedNames = Object.keys(skipped);
        if (skippedNames.length > 0) {
          node.warn('已跳过字段: ' + skippedNames.join(', '));
        }

        if (outRows.length === 0) {
          node.status({ fill: 'grey', shape: 'ring', text: '无可写入行' });
          if (done) done();
          return; // 无变化行则不下发
        }

        if (node.outputFormat === 'rows') {
          // rows 格式：对接 edgelink-pg-store（断库 spool / 幂等重放），值走参数化绑定
          msg.payload = {
            rows: outRows.map(function (r) {
              var row = {};
              row[node.timeColumn] = r.ts;
              row[node.tagColumn] = r.tagId;
              row[node.valueColumn] = r.value;
              return row;
            })
          };
          msg.tableName = node.table;
          delete msg.query;
        } else {
          // sql 格式：对接通用"执行 msg.query"的 pg 节点
          msg.query = 'INSERT INTO ' + node.table +
            '(' + node.timeColumn + ', ' + node.tagColumn + ', ' + node.valueColumn + ') VALUES ' +
            outRows.map(function (r) {
              return "('" + r.ts + "', " + r.tagId + ', ' + r.value + ')';
            }).join(',\n') + ';';
        }
        node.status({ fill: 'green', shape: 'dot', text: outRows.length + ' 行' });
        send(msg);
        if (done) done();
      } catch (e) {
        node.status({ fill: 'red', shape: 'ring', text: '处理异常: ' + e.message });
        if (done) { done(e); } else { node.error(e, msg); }
      }
    });
  }

  RED.nodes.registerType('change-to-sql', ChangeToSqlNode);
};
