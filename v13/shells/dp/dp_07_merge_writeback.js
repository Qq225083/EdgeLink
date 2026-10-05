// 数据管道⑦成功支路：lastGoodTags 合并（旧的标 UNCERTAIN，新 GOOD 覆盖）+ 写回
var core = global.get('edgeCore');
var st = core.createStore(global);
var dp = msg._dp;

var lastGoodTags = st.get('lastGoodTags');
var prevGood = lastGoodTags[dp.devId] || [];
var newGood = dp.tagValues.filter(function (v) { return v.quality === 'GOOD'; });

var prevMap = {};
prevGood.forEach(function (pg) {
    prevMap[pg.tag_id] = {
        tag_id: pg.tag_id, tag_address: pg.tag_address, tag_name: pg.tag_name,
        raw_value: pg.raw_value, eng_value: pg.eng_value, unit: pg.unit,
        quality: 'UNCERTAIN', ts: pg.ts
    };
});
newGood.forEach(function (ng) { prevMap[ng.tag_id] = ng; });
var merged = [];
for (var k in prevMap) { if (Object.prototype.hasOwnProperty.call(prevMap, k)) merged.push(prevMap[k]); }

lastGoodTags[dp.devId] = merged;
st.set('lastGoodTags', lastGoodTags);
node.status({ fill: 'blue', shape: 'dot', text: 'lastGood ' + merged.length });
return msg;
