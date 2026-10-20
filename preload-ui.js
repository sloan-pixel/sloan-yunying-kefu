// 界面层可调用的接口
const { contextBridge, ipcRenderer } = require('electron');
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);
const api = {};
for (const ch of ['getState', 'saveSettings', 'setViewport', 'storeAdd', 'storeUpdate', 'storeRemove', 'storeReload', 'storeClearLogin', 'storeHealth',
  'calibrate', 'getConv', 'readConv', 'manualSend', 'takeOver', 'release', 'correct', 'qaList', 'qaUpsert', 'qaRemove', 'qaImport', 'qaExport', 'qaTest',
  'learnState', 'candApprove', 'candReject', 'todos', 'todoDone', 'latency', 'modelTest', 'setAway', 'storeBack', 'cancelPick', 'modelList', 'openExternal']) api[ch] = call(ch);
api.on = (ch, fn) => ipcRenderer.on('ui:' + ch, (_, d) => fn(d));
contextBridge.exposeInMainWorld('kefu', api);
