// 配置⑤分页拉取：全局点位快照分页（5000/页，200 页熔断）→ msg._cm.records（异步出口）
var core = global.get('edgeCore');
var st = core.createStore(global);
core.logger.setSink(function (level, scope, m) { node.warn('[' + scope + '] ' + m); });
var log = core.logger;
log.setDebug(st.get('debug'));
var cm = msg._cm;

var PAGE_SIZE = 5000;
var allRecords = [];

function fail(msgText) {
    log.warn('CM', msgText);
    st.set('configManagerLock', null);
    st.set('configReady', false);
    st.set('lastConfigTs', new Date().toISOString());
    node.status({ fill: 'red', shape: 'ring', text: 'fetch fail' });
}

function fetchTagPage(pageNum) {
    if (pageNum > 200) {
        fail('Tag paging exceeded 200 pages, aborting (backend paging params not honored?)');
        return;
    }
    core.httpClient.requestJson({
        host: st.get('backendHost'), port: st.get('backendPort'),
        path: '/plc/config/snapshot/list?pageSize=' + PAGE_SIZE + '&pageNum=' + pageNum,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cm.jwt }, timeout: 10000
    }).then(function (r) {
        if (r.error) { fail('Tag fetch error: ' + r.error); return; }
        var j = r.json;
        if (!j) { fail('Tag API parse error'); return; }
        if (j.code !== 200) { fail('Tag API returned code ' + (j.code || 'unknown') + ', will retry on refresh'); return; }
        if (j.snapshotVersion !== undefined && j.snapshotVersion !== null) {
            st.set('configVersion', j.snapshotVersion);
        }
        var pageRows = j.rows || [];
        allRecords = allRecords.concat(pageRows);
        if (j.hasNext === true || pageRows.length === PAGE_SIZE) {
            fetchTagPage(pageNum + 1);
            return;
        }
        cm.records = allRecords;
        node.status({ fill: 'blue', shape: 'dot', text: 'tags ×' + allRecords.length });
        node.send(msg);
    });
}

fetchTagPage(1);
return null;
