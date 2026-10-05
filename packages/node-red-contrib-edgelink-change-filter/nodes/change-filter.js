'use strict';

module.exports = function (RED) {
  function ChangeFilterNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.keyField = String(config.keyField || 'id').trim() || 'id';
    node.excludeFields = String(config.excludeFields == null ? 'timestamp,insert_time' : config.excludeFields)
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    node.outputMode = config.outputMode === 'all_with_flag' ? 'all_with_flag' : 'changed_only';
    node.firstPass = config.firstPass === 'drop' ? 'drop' : 'pass_through';
    var th = Number(config.threshold);
    node.threshold = isFinite(th) && th > 0 ? th : 0; // |Δ| >= threshold 才算变化；0 = 关闭死区
    var to = Number(config.timeoutSec);
    node.timeoutMs = isFinite(to) && to > 0 ? to * 1000 : 0; // 0 = 不清理

    // 上一次采集基准：key -> { data: 深拷贝, lastSeen: ms }
    // 闭包变量，不碰 flow/global context；节点重启/重部署自动清理
    var previousData = {};
    var initialized = false;

    function deepClone(value) {
      if (value === null || typeof value !== 'object') return value;
      if (value instanceof Date) return new Date(value.getTime());
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (e) {
        return value;
      }
    }

    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function isExcluded(field) {
      return field === node.keyField || node.excludeFields.indexOf(field) !== -1;
    }

    // 数值死区仅作用于数值字段；类型变化一律视为变化；对象/数组用 JSON.stringify 深比较
    function fieldChanged(oldVal, newVal) {
      if (typeof oldVal !== typeof newVal) return true;
      if (typeof oldVal === 'number' && node.threshold > 0) {
        return Math.abs(newVal - oldVal) >= node.threshold;
      }
      if (oldVal !== null && typeof oldVal === 'object') {
        return JSON.stringify(oldVal) !== JSON.stringify(newVal);
      }
      return oldVal !== newVal;
    }

    function comparedFields(rec) {
      return Object.keys(rec).filter(function (f) { return !isExcluded(f); });
    }

    function purgeStale(now) {
      if (!node.timeoutMs) return;
      var removed = [];
      Object.keys(previousData).forEach(function (key) {
        if (now - previousData[key].lastSeen > node.timeoutMs) {
          removed.push(key);
          delete previousData[key];
        }
      });
      if (removed.length > 0) {
        node.warn('超时清理：移除 ' + removed.length + ' 个过期基准 [' + removed.join(', ') + ']');
      }
    }

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };

      if (!Array.isArray(msg.payload)) {
        node.status({ fill: 'red', shape: 'ring', text: '输入非数组' });
        var err = new Error('change-filter: msg.payload 必须是对象数组，实际收到 ' +
          (msg.payload === null ? 'null' : typeof msg.payload));
        if (done) { done(err); } else { node.error(err, msg); }
        return;
      }

      try {
        var now = Date.now();
        purgeStale(now);

        var isFirst = !initialized;
        var out = [];
        var changedCount = 0;
        var newCount = 0;
        var skipped = 0;

        for (var i = 0; i < msg.payload.length; i++) {
          var rec = msg.payload[i];
          if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
            skipped++;
            node.warn('第 ' + i + ' 条记录不是对象，已跳过');
            continue;
          }
          var rawKey = rec[node.keyField];
          if (rawKey === undefined || rawKey === null || rawKey === '') {
            skipped++;
            node.warn('第 ' + i + ' 条记录缺少唯一键字段 "' + node.keyField + '"，已跳过');
            continue;
          }
          var key = String(rawKey);

          var prev = previousData[key];
          var isNew = !prev;
          var changedFields = [];
          var oldValues = {};
          var changes = {}; // {字段: 变化后的新值}；字段被删除时值为 null

          if (isNew) {
            // 新记录视为全字段变化，下游可据此全量写入
            comparedFields(rec).forEach(function (f) {
              changedFields.push(f);
              changes[f] = deepClone(rec[f]);
            });
          } else {
            var oldData = prev.data;
            comparedFields(rec).forEach(function (f) {
              if (!hasOwn(oldData, f)) {
                changedFields.push(f); // 新增字段
                changes[f] = deepClone(rec[f]);
                return;
              }
              if (fieldChanged(oldData[f], rec[f])) {
                changedFields.push(f);
                oldValues[f] = deepClone(oldData[f]);
                changes[f] = deepClone(rec[f]);
              }
            });
            Object.keys(oldData).forEach(function (f) {
              if (isExcluded(f) || hasOwn(rec, f)) return;
              changedFields.push(f); // 字段被删除
              oldValues[f] = deepClone(oldData[f]);
              changes[f] = null;
            });
          }

          previousData[key] = { data: deepClone(rec), lastSeen: now };

          var changed = isNew || changedFields.length > 0;
          if (isNew) newCount++;
          if (changed) changedCount++;

          if (isFirst && node.firstPass === 'drop') continue; // 首帧只建基准
          if (node.outputMode === 'changed_only' && !changed) continue;

          var outRec = deepClone(rec);
          if (node.outputMode === 'all_with_flag') outRec._changed = changed;
          outRec._changed_fields = changedFields;
          outRec._old_values = oldValues;
          outRec._changes = changes;
          outRec._is_new = isNew;
          out.push(outRec);
        }

        initialized = true;

        if (isFirst && node.firstPass === 'drop') {
          node.status({ fill: 'blue', shape: 'dot', text: '已建立基准 ' + Object.keys(previousData).length + ' 条，等待变化' });
          if (done) done();
          return; // 首帧不输出
        }

        if (changedCount > 0) {
          node.status({
            fill: 'green', shape: 'dot',
            text: '变化 ' + changedCount + (newCount > 0 ? ' / 新增 ' + newCount : '')
          });
        } else {
          node.status({ fill: 'grey', shape: 'ring', text: '无变化' + (skipped > 0 ? ' / 跳过 ' + skipped : '') });
        }

        msg.payload = out;
        send(msg);
        if (done) done();
      } catch (e) {
        node.status({ fill: 'red', shape: 'ring', text: '处理异常: ' + e.message });
        if (done) { done(e); } else { node.error(e, msg); }
      }
    });

    node.on('close', function () {
      previousData = {};
    });
  }

  RED.nodes.registerType('change-filter', ChangeFilterNode);
};
