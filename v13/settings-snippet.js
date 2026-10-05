/**
 * settings-snippet.js — 接入方式（并入 D:\nodered\data\settings.js 的 functionGlobalContext）
 *
 * 部署时二选一：
 *   A. 开发期直接指向本工作区（改完重启 Node-RED 即可生效）
 *   B. 稳定后并入 node-red-contrib-edgelink-core 包，指向包内 lib
 */

// settings.js → functionGlobalContext 里增加一行（其余已有注入保持不变）：
// functionGlobalContext: {
//     ...已有的 http / fs / path / os / crypto / process / userDir / edge_* 注入保持不变...
//     edgeCore: require('C:/Users/admin/Desktop/RuoYi-Vue-FastAPI/v13/lib'),
//     // 稳定后改为：edgeCore: require('D:/nodered/node_modules/node-red-contrib-edgelink-core/lib'),
// },

// 壳层 function 开头统一约定：
//   var core = global.get('edgeCore');
//   var st = core.createStore(global);
//   core.logger.setSink(function (level, scope, msg) { node.warn('[' + scope + '] ' + msg); });
//   core.logger.setDebug(st.get('debug'));
