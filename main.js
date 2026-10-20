// Sloan云盈客服助手 · 主进程
// 一台电脑一个“席位”（AI 席位 / 人工席位），每个店铺账号一个独立登录环境的内嵌网页
const { app, BaseWindow, WebContentsView, ipcMain, dialog, powerMonitor, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JsonStore } = require('./engine/store');
const { QAKnowledge } = require('./engine/qa');
const { ModelRouter, PRESETS } = require('./engine/llm');
const { Learner } = require('./engine/learner');
const { ReplyEngine, DEFAULTS } = require('./engine/router');
const { SyncClient } = require('./engine/sync');
const { ProductLib } = require('./engine/products');
const PLATFORMS = require('./adapters/platforms.json');

// 数据目录固定，不随软件改名而变化（店铺、登录状态、知识库都在这里）
// 老版本（多店客服台）的数据目录还在就继续用，否则用新名字
{ const legacy = path.join(app.getPath('appData'), '多店客服台');
  app.setPath('userData', fs.existsSync(legacy) ? legacy : path.join(app.getPath('appData'), 'Sloan云盈客服助手')); }
// 只允许运行一个：重复打开时把已打开的窗口调到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
// 去掉 UA 里的 Electron 标记，平台看到的是普通 Chrome
app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/\S+/, '').replace(/\s?kefu-hub\/\S+/, '');

let win, ui, store, qa, models, learner, engine, sync, products;
const views = new Map();      // storeId -> { view, frames: Map, bestFrame, health, url }
const pending = new Map();    // cmdId -> { resolve, reject, timer }
const inbox = new Map();      // convKey -> { storeId, platform, convId, buyer, msgs[], last, unread }
let visibleStoreId = null, viewBounds = null, idle = false;

// ---------------- 设置 ----------------
function defaultSettings() {
  return {
    seat: { seatId: crypto.randomUUID(), name: require('os').hostname(), role: 'ai' },
    modeOverride: 'auto',            // auto | ai | human | takeover
    autoTakeover: true,              // 人工离线自动切 AI 接管
    idleMinutes: 5,                  // 人工席位：电脑无操作多少分钟算离开
    away: false,                     // 人工席位：手动“我离开了”
    // 默认不绑定任何一家：填了 Key 并勾选的才会用，按列表顺序互为备用
    models: ['qwen', 'deepseek', 'glm', 'kimi', 'doubao', 'ollama'].map((preset, i) => ({ id: 'm' + (i + 1), preset, apiKey: '', model: PRESETS[preset].model, baseUrl: '', enabled: false })),
    sync: { url: '', token: '', offlineAfterSec: 30 },
    engine: {},
    shopInfo: '',
    stores: [{ id: 'demo', platform: 'mock', name: '模拟店铺(测试)', brand: '', humanTarget: '小美', enabled: true }],
  };
}
const S = () => store.get('settings');
function saveSettings(patch) { const s = { ...S(), ...patch }; store.set('settings', s); applyMode(); return s; }

// 当前生效模式
function computeMode() {
  const s = S();
  if (s.modeOverride && s.modeOverride !== 'auto') return s.modeOverride;
  if (s.seat.role === 'human') return (s.autoTakeover && operatorAway()) ? 'takeover' : 'human';
  // AI 席位：配置了同步、且没有在线的人工席位 → 不再转接，改为离线接管
  if (s.autoTakeover && s.sync?.url && sync && sync.status === 'ok' && !sync.humanOnline()) return 'takeover';
  return 'ai';
}
function operatorAway() { return S().away || idle; }
function applyMode() {
  const s = S(); const m = computeMode();
  if (s.effectiveMode !== m) { store.set('settings', { ...s, effectiveMode: m }); if (engine) engine.onModeChange(s.effectiveMode, m); }
  pushUI('status', statusSnapshot());
}
function statusSnapshot() {
  const s = S();
  return { seat: s.seat, modeOverride: s.modeOverride, effectiveMode: s.effectiveMode || computeMode(), away: s.away, idle,
    sync: sync ? sync.snapshot() : { status: 'off' }, models: models ? models.stats : {}, modelReady: models ? models.providers().length > 0 : false };
}

// ---------------- 窗口 ----------------
function createWindow() {
  win = new BaseWindow({ width: 1440, height: 900, minWidth: 1100, minHeight: 700, title: 'Sloan云盈客服助手', backgroundColor: '#f6f5f2' });
  ui = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true } });
  win.contentView.addChildView(ui);
  const fit = () => { const b = win.getContentBounds(); ui.setBounds({ x: 0, y: 0, width: b.width, height: b.height }); layoutViews(); };
  win.on('resize', fit); fit();
  ui.webContents.loadFile(path.join(__dirname, 'ui/index.html'));
  win.on('closed', () => {
    for (const [, r] of views) { try { r.view.webContents.close(); } catch {} }
    views.clear(); try { ui.webContents.close(); } catch {}
    win = null; app.quit();
  });
}
function layoutViews() {
  for (const [id, v] of views) {
    const show = id === visibleStoreId && viewBounds;
    v.view.setVisible(!!show);
    // 隐藏时仍保持页面运行（backgroundThrottling 关闭），只是移出可见区域
    v.view.setBounds(show ? viewBounds : { x: -5000, y: 0, width: 1200, height: 800 });
  }
}
function pushUI(ch, data) { if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('ui:' + ch, data); }

// ---------------- 店铺内嵌网页 ----------------
function storeConf(id) { return S().stores.find(x => x.id === id); }
function platformConf(st) {
  const p = PLATFORMS[st.platform] || {};
  return { ...p, url: st.url || p.url, selectors: { ...(p.selectors || {}), ...(st.selectors || {}) } };
}
function openStore(st) {
  if (views.has(st.id)) return views.get(st.id);
  const partition = 'persist:store-' + st.id;
  const view = new WebContentsView({ webPreferences: { partition, preload: path.join(__dirname, 'preload-platform.js'),
    contextIsolation: true, sandbox: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  const rec = { view, frames: new Map(), bestFrame: null, health: null, partition };
  views.set(st.id, rec);
  win.contentView.addChildView(view);
  view.webContents.setWindowOpenHandler(({ url }) => ({ action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 760, webPreferences: { partition } } }));
  view.webContents.on('did-finish-load', () => pushConfig(st.id));
  view.webContents.on('did-navigate-in-page', () => pushConfig(st.id));
  loadStore(st);
  layoutViews();
  return rec;
}
function loadStore(st, useLogin) {
  const rec = views.get(st.id); const pc = platformConf(st);
  if (pc.url === 'mock://platform') rec.view.webContents.loadFile(path.join(__dirname, 'mock/platform.html'));
  else if (pc.url) rec.view.webContents.loadURL(useLogin && pc.loginUrl ? pc.loginUrl : pc.url);
}
function closeStore(id) {
  const r = views.get(id); if (!r) return;
  views.delete(id);
  try { if (win) win.contentView.removeChildView(r.view); } catch {}
  try { r.view.webContents.close(); } catch {}
}
function storeConfigFor(id) { const st = storeConf(id); return st ? { storeId: id, selectors: platformConf(st).selectors, autoOpen: true } : null; }
function pushConfig(id) {
  const st = storeConf(id); const r = views.get(id); if (!st || !r) return;
  const cfg = storeConfigFor(id);
  for (const f of r.view.webContents.mainFrame.framesInSubtree) { try { f.send('pf:config', cfg); } catch {} }
}
function storeIdOf(wc) { for (const [id, r] of views) if (r.view.webContents === wc) return id; return null; }

// 向店铺网页发命令（发到“最匹配”的那个框架里）
function cmd(storeId, op, args = {}, { allFrames = false, timeout = 15000 } = {}) {
  const r = views.get(storeId);
  if (!r) return Promise.reject(new Error('店铺未打开'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('页面无响应')); }, timeout);
    pending.set(id, { resolve, reject, timer, left: 1 });
    let frames = allFrames ? r.view.webContents.mainFrame.framesInSubtree : [r.bestFrame || r.view.webContents.mainFrame];
    frames = frames.filter(f => f && !f.detached);
    let sent = 0;
    for (const f of frames) { try { f.send('pf:cmd', { id, op, ...args }); sent++; } catch {} }
    pending.get(id).left = sent;
    if (!sent) { clearTimeout(timer); pending.delete(id); reject(new Error('店铺页面还没加载好')); }
  });
}
ipcMain.on('pf:result', (e, { id, ok, result, error }) => {
  const p = pending.get(id); if (!p) return;
  // 点选时在任意框架按了 Esc：立即结束
  if (ok && result && result.cancelled) { clearTimeout(p.timer); pending.delete(id); p.resolve(null); return; }
  if (ok && result != null) { clearTimeout(p.timer); pending.delete(id); p.resolve(result); return; }
  p.left--; p.lastErr = error;
  if (p.left <= 0) { clearTimeout(p.timer); pending.delete(id); ok ? p.resolve(result) : p.reject(new Error(error || '失败')); }
});
ipcMain.on('pf:health', (e, h) => {
  const id = storeIdOf(e.sender); const r = views.get(id); if (!r || !e.senderFrame) return;
  const score = (h.input ? 2 : 0) + (h.msgItem ? 2 : 0) + (h.convList ? 1 : 0);
  r.frames.set(e.senderFrame, { ...h, score, at: Date.now() });
  let best = null, bs = -1;
  for (const [f, x] of r.frames) {
    if (f.detached || Date.now() - x.at > 10000) { r.frames.delete(f); continue; }   // 已关闭或不再上报的框架
    if (x.score > bs) { bs = x.score; best = f; }
  }
  r.bestFrame = best; r.health = r.frames.get(best);
  pushUI('health', { storeId: id, health: r.health });
});
ipcMain.handle('pf:enter', (e) => {
  const wc = e.sender;
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  return true;
});
// 晚加载的框架主动要配置
ipcMain.handle('pf:getConfig', e => storeConfigFor(storeIdOf(e.sender)));
// 页面上报的消息
ipcMain.on('pf:event', (e, ev) => {
  const storeId = storeIdOf(e.sender); const st = storeConf(storeId); if (!st) return;
  const m = { ...ev, storeId, platform: st.platform, brand: st.brand, shopInfo: st.shopInfo };
  if (ev.type === 'buyer') { addToInbox(m, 'buyer'); engine.onBuyerMessage(m); return; }
  if (ev.type !== 'seller') return;
  // 本系统刚发的 → 记为 AI；否则是人工（交给引擎做学习/接管判断）
  if (engine.isOurs(`${storeId}::${ev.convId}`, ev.text)) { addToInbox(m, 'ai'); return; }
  addToInbox(m, 'seller'); engine.onSellerMessage(m);
});

function addToInbox(m, from) {
  const k = `${m.storeId}::${m.convId}`;
  const c = inbox.get(k) || { key: k, storeId: m.storeId, platform: m.platform, convId: m.convId, buyer: m.buyer || m.convId, msgs: [], unread: 0 };
  const last = c.msgs[c.msgs.length - 1];
  if (!(last && last.from === from && last.text === m.text && Date.now() - last.ts < 3000)) c.msgs.push({ from, text: m.text, ts: Date.now() });
  c.msgs = c.msgs.slice(-200); c.last = Date.now(); if (from === 'buyer') c.unread++;
  inbox.set(k, c);
  pushUI('conv', summarize(c));
}
const summarize = c => ({ key: c.key, storeId: c.storeId, platform: c.platform, convId: c.convId, buyer: c.buyer, last: c.last, unread: c.unread, preview: c.msgs.at(-1)?.text, paused: engine.paused.has(c.key) });

// ---------------- 启动 ----------------
app.whenReady().then(() => {
  if (!gotLock) return;
  store = new JsonStore(path.join(app.getPath('userData'), 'data'));
  if (!store.get('settings')) store.set('settings', defaultSettings());
  // 老版本设置升级：已停用的默认型号换成新的；补上缺少的字段
  { const s = store.get('settings'); const RETIRED = { 'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-flash' };
    s.models = (s.models || []).map(m => ({ baseUrl: '', ...m, model: RETIRED[m.model] && !m.baseUrl ? RETIRED[m.model] : m.model }));
    // 旧版默认启用了没填 Key 的 Claude：没 Key 就取消勾选，避免误以为在用
    s.models.forEach(m => { if (m.enabled && !m.apiKey && PRESETS[m.preset]?.needsKey) m.enabled = false; });
    store.set('settings', { ...defaultSettings(), ...s, seat: { ...defaultSettings().seat, ...s.seat } }); }
  qa = new QAKnowledge(store);
  models = new ModelRouter(S);
  learner = new Learner(store, qa);
  products = new ProductLib(store);
  engine = new ReplyEngine({ qa, models, learner, store, products, getSettings: S, actions: {
    // 读取该买家的订单（店铺没校准订单栏时返回 null）
    getOrders: (m) => { const sel = platformConf(storeConf(m.storeId) || {}).selectors || {}; return sel.orderItem ? cmd(m.storeId, 'readCards', { kind: 'orders', convId: m.convId }, { timeout: 4000 }) : Promise.resolve(null); },
    send: (m, text) => cmd(m.storeId, 'send', { convId: m.convId, text }),
    transfer: (m) => cmd(m.storeId, 'transfer', { convId: m.convId, target: storeConf(m.storeId)?.humanTarget || '' }, { timeout: 20000 }),
  } });
  engine.on('trace', t => { pushUI('trace', t); if (t.kind === 'human-takeover') { const c = inbox.get(`${t.storeId}::${t.convId}`); if (c) pushUI('conv', summarize(c)); } });
  engine.on('todo', t => pushUI('todo', t));
  engine.on('error', e => pushUI('toast', '处理消息出错：' + (e && e.message || e)));
  sync = new SyncClient({ store, getSettings: S, seatInfo: () => ({ seatId: S().seat.seatId, name: S().seat.name, role: S().seat.role, mode: S().effectiveMode, operatorPresent: S().seat.role === 'human' ? (S().effectiveMode || computeMode()) === 'human' : true }) });
  sync.on('status', () => applyMode());
  sync.on('docs', name => pushUI('docs', name));
  sync.start();

  createWindow();
  for (const st of S().stores) if (st.enabled) openStore(st);
  // 人工席位：系统空闲检测
  setInterval(() => {
    const was = idle; idle = powerMonitor.getSystemIdleTime() > (S().idleMinutes || 5) * 60;
    if (was !== idle) applyMode();
  }, 5000);
  applyMode();
});
app.on('before-quit', () => store && store.flushAll());
app.on('window-all-closed', () => app.quit());

// ---------------- 给界面的接口 ----------------
const H = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => fn(...a));
H('getState', () => ({ settings: S(), platforms: PLATFORMS, presets: PRESETS, version: app.getVersion(), status: statusSnapshot(), convs: [...inbox.values()].map(summarize),
  health: Object.fromEntries([...views].map(([id, r]) => [id, r.health || null])), defaults: DEFAULTS }));
H('saveSettings', patch => { const s = saveSettings(patch); if ('sync' in patch) sync.start(); return s; });
H('setViewport', ({ storeId, bounds }) => { visibleStoreId = storeId; viewBounds = bounds; layoutViews(); });
H('storeAdd', st => { const s = S(); const n = { id: 'st' + Date.now(), enabled: true, brand: '', humanTarget: '', ...st }; saveSettings({ stores: [...s.stores, n] }); openStore(n); return n; });
H('storeUpdate', st => { const s = S(); saveSettings({ stores: s.stores.map(x => x.id === st.id ? { ...x, ...st } : x) }); pushConfig(st.id); return storeConf(st.id); });
H('storeRemove', async id => {
  closeStore(id); engine.purgeStore(id);
  for (const k of [...inbox.keys()]) if (k.startsWith(id + '::')) inbox.delete(k);
  saveSettings({ stores: S().stores.filter(x => x.id !== id) });
  pushUI('convsReset', [...inbox.values()].map(summarize));
});
H('storeReload', ({ id, login }) => { const st = storeConf(id); if (!views.has(id)) openStore(st); else loadStore(st, login); });
H('storeBack', id => { const wc = views.get(id)?.view.webContents; if (wc && wc.navigationHistory?.canGoBack()) wc.navigationHistory.goBack(); else if (wc?.canGoBack?.()) wc.goBack(); });
H('cancelPick', id => { const r = views.get(id); if (r) for (const f of r.view.webContents.mainFrame.framesInSubtree) { try { f.send('pf:cancelPick'); } catch {} } });
H('storeClearLogin', async id => { const r = views.get(id); if (r) { await session.fromPartition(r.partition).clearStorageData(); loadStore(storeConf(id), true); } });
H('storeHealth', id => views.get(id)?.health || { error: '页面还没上报（未打开、未登录或未校准）' });
H('calibrate', async ({ storeId, field, list, label }) => {
  const r = await cmd(storeId, 'pick', { list, label }, { allFrames: true, timeout: 120000 }).finally(() => {
    const r = views.get(storeId); if (r) for (const f of r.view.webContents.mainFrame.framesInSubtree) { try { f.send('pf:cancelPick'); } catch {} }
  });
  if (!r) return null;
  const st = storeConf(storeId); const selectors = { ...(st.selectors || {}), [field]: r.selector };
  saveSettings({ stores: S().stores.map(x => x.id === storeId ? { ...x, selectors } : x) }); pushConfig(storeId);
  return r;
});
// 只点选、不保存（转接步骤用）
H('pick', ({ storeId, list, label }) => cmd(storeId, 'pick', { list, label }, { allFrames: true, timeout: 120000 }).finally(() => {
  const r = views.get(storeId); if (r) for (const f of r.view.webContents.mainFrame.framesInSubtree) { try { f.send('pf:cancelPick'); } catch {} }
}));
// 校准检查：当前页面上每一项找到几个
H('calibCheck', async storeId => { const st = storeConf(storeId); if (!st) return null; return cmd(storeId, 'check', { selectors: platformConf(st).selectors }, { allFrames: true, timeout: 3000 }).catch(() => null); });
H('getConv', key => inbox.get(key) || null);
H('readConv', key => { const c = inbox.get(key); if (c) { c.unread = 0; pushUI('conv', summarize(c)); } });
H('manualSend', async ({ key, text }) => {
  const c = inbox.get(key); if (!c) throw new Error('会话不存在');
  engine.takeOver(c.storeId, c.convId);
  await cmd(c.storeId, 'send', { convId: c.convId, text });
  pushUI('conv', summarize(c)); return true;
});
H('takeOver', key => { const c = inbox.get(key); engine.takeOver(c.storeId, c.convId); pushUI('conv', summarize(c)); });
H('release', key => { const c = inbox.get(key); engine.release(c.storeId, c.convId); pushUI('conv', summarize(c)); });
H('correct', ({ question, answer, storeId, sendKey }) => {
  const st = storeConf(storeId) || {};
  const c = learner.correction(question, answer, { brand: st.brand || '', category: '' });
  if (sendKey) { const conv = inbox.get(sendKey); if (conv) engine.send({ storeId: conv.storeId, convId: conv.convId }, answer).catch(e => pushUI('toast', '发送失败：' + e.message)); }
  return { added: !!c };
});
// 知识库
H('qaList', () => qa.items);
H('qaUpsert', item => qa.upsert(item));
H('qaRemove', id => qa.remove(id));
H('qaImport', async ({ replace, brand }) => {
  const r = await dialog.showOpenDialog(win, { title: '导入 QA 知识库', filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return qa.importFile(r.filePaths[0], { replace, brand });
});
H('qaExport', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'QA知识库导出.csv' }); if (r.canceled) return null;
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['问题', '答案', '相似问法', '关键词', '分类', '品牌', '命中次数'], ...qa.items.map(x => [x.q, x.a, (x.alts || []).join('|'), (x.kw || []).join('|'), x.category, x.brand, x.hits || 0])];
  fs.writeFileSync(r.filePath, '﻿' + rows.map(r => r.map(esc).join(',')).join('\n')); shell.showItemInFolder(r.filePath); return r.filePath;
});
H('qaTest', ({ text, brand }) => { const m = qa.match(text, brand); return { score: m.score, via: m.via, item: m.item, top: qa.topK(text, brand, 3) }; });
// 学习
// 订单栏 / 商品栏（来自店铺页面）
H('ordersGet', async key => { const c = inbox.get(key); if (!c) throw new Error('会话不存在'); return cmd(c.storeId, 'readCards', { kind: 'orders', convId: c.convId }, { timeout: 8000 }); });
H('goodsGet', async storeId => cmd(storeId, 'readCards', { kind: 'goods' }, { timeout: 8000 }));
H('cardSend', async ({ key, kind, idx, matchText }) => {
  const c = inbox.get(key); if (!c) throw new Error('会话不存在');
  engine.expectOurs(key);   // 平台按钮发出的卡片算本系统发的，不算人工插话
  await cmd(c.storeId, 'clickCard', { kind, convId: c.convId, idx, matchText }, { timeout: 10000 });
  return true;
});
// 商品库
H('productList', q => products.search(q));
H('productUpsert', p => products.upsert(p));
H('productRemove', id => products.remove(id));
H('productImport', async () => {
  const r = await dialog.showOpenDialog(win, { title: '导入商品库', filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return products.importFile(r.filePaths[0]);
});
H('productSend', async ({ key, id }) => {
  const c = inbox.get(key); if (!c) throw new Error('会话不存在');
  const p = products.items.find(x => x.id === id); if (!p) throw new Error('商品不存在');
  await engine.send({ storeId: c.storeId, convId: c.convId }, ProductLib.linkText(p));
  return true;
});
H('learnState', () => ({ candidates: learner.candidates.filter(c => c.status === 'pending'), readiness: learner.readiness(), style: learner.styleSamples.slice(-10) }));
H('candApprove', ({ id, edits }) => learner.approve(id, edits));
H('candReject', id => learner.reject(id));
// 待办 / 监控
H('todos', () => store.get('todos', []));
H('todoDone', id => { const t = store.get('todos', []); const x = t.find(y => y.id === id); if (x) { x.done = true; x.updatedAt = Date.now(); store.set('todos', t); } });
H('latency', () => store.get('latency', []));
// 模型
H('modelTest', m => models.test(m));
H('modelList', m => models.listModels(m));
H('openExternal', url => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
H('setAway', away => { saveSettings({ away }); sync.heartbeat(); return statusSnapshot(); });
