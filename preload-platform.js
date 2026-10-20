// 注入到每个店铺网页（含子框架）的桥：把页面里的消息报给主程序，执行发送/转接/校准命令
const { ipcRenderer } = require('electron');
const core = require('./adapters/dom-core.js');

let cfg = null, cfgKey = '', watcher = null, pick = null;
// 已处理过的消息记录放在这里，跨“重新加载配置/重建监听”保留，避免重复回复旧消息
const memory = { known: new Map() };

function start(force) {
  if (!document.body) { window.addEventListener('DOMContentLoaded', () => start(true), { once: true }); return; }
  if (watcher && !force) return;
  if (watcher) watcher.stop();
  watcher = null;
  if (!cfg || !cfg.selectors || !cfg.selectors.msgItem) return;   // 还没校准
  watcher = core.createWatcher(document, cfg.selectors, ev => ipcRenderer.send('pf:event', ev), {
    autoOpen: cfg.autoOpen !== false,
    known: memory.known,
    onNeedEnter: () => ipcRenderer.invoke('pf:enter'),
  });
  watcher.start();
}

function applyConfig(c) {
  const key = JSON.stringify(c && c.selectors) + '|' + (c && c.autoOpen);
  const changed = key !== cfgKey;
  cfg = c; cfgKey = key;
  start(changed);
}

ipcRenderer.on('pf:config', (_, c) => applyConfig(c));
// 框架晚加载（很多平台的聊天区是后插入的 iframe）：自己主动要一次配置
ipcRenderer.invoke('pf:getConfig').then(c => { if (c) applyConfig(c); }).catch(() => {});

function endPick(result) {
  if (!pick) return;
  const p = pick; pick = null;
  try { p.cleanup(); } catch {}
  ipcRenderer.send('pf:result', { id: p.id, ok: true, result });
}
ipcRenderer.on('pf:cancelPick', () => endPick(null));

ipcRenderer.on('pf:cmd', async (_, c) => {
  const reply = (ok, result, error) => ipcRenderer.send('pf:result', { id: c.id, ok, result, error });
  try {
    if (c.op === 'pick') {
      if (!document.body) return reply(true, null);
      if (pick) endPick(null);
      const p = { id: c.id };
      pick = p;
      p.cleanup = core.startPicker(document, {
        list: c.list, label: c.label,
        onPick: r => { if (pick === p) { pick = null; reply(true, r); } },
        // 任何一个框架里按 Esc：通知主程序立即结束这次点选
        onCancel: () => { if (pick === p) { pick = null; reply(true, { cancelled: true }); } },
      });
      return;
    }
    // 校准检查：不依赖监听是否启动；这个框架里一个都没找到就返回空，让真正的聊天框架来回答
    if (c.op === 'check') { if (!document.body) return reply(true, null); const r = core.countSelectors(document, c.selectors); return reply(true, r.total ? { counts: r.counts, samples: r.samples } : null); }
    if (!watcher) return reply(false, null, '本页面未就绪：请先登录并完成校准');
    if (c.op === 'send') return reply(true, await watcher.send(c.convId, c.text));
    if (c.op === 'transfer') return reply(true, await watcher.transfer(c.convId, c.target));
    if (c.op === 'health') return reply(true, watcher.health());
    if (c.op === 'readCards') return reply(true, await watcher.readCards(c.kind, c.convId));
    if (c.op === 'clickCard') return reply(true, await watcher.clickCard(c.kind, c.convId, c.idx, c.matchText));
    reply(false, null, '未知命令');
  } catch (e) { reply(false, null, e.message); }
});

// 每 3 秒上报一次健康状态，主程序据此选出“真正的客服框架”
setInterval(() => {
  if (!document.body) return;
  const h = watcher ? watcher.health() : { input: false, convList: 0, msgItem: 0, currentConv: null, notReady: true };
  ipcRenderer.send('pf:health', { ...h, url: location.href.slice(0, 120) });
}, 3000);
