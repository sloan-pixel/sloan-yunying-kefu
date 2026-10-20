// 仅在浏览器里直接打开界面时生效（Electron 里 window.kefu 已存在，本文件不起作用）
// 用演示数据填充界面，方便预览样式
(function () {
  if (window.kefu) return;
  const now = Date.now();
  const handlers = {};
  const settings = {
    seat: { seatId: 'demo', name: '前台-AI机', role: 'ai' }, modeOverride: 'auto', autoTakeover: true, idleMinutes: 5, away: false,
    models: [{ id: 'm1', preset: 'qwen', apiKey: 'sk-demo', model: 'qwen-plus', enabled: true }, { id: 'm2', preset: 'deepseek', apiKey: '', model: 'deepseek-flash', enabled: false }, { id: 'm3', preset: 'ollama', apiKey: '', model: 'qwen3:8b', enabled: false }],
    sync: { url: 'http://192.168.1.20:8787', token: '', offlineAfterSec: 30 }, engine: {}, shopInfo: '',
    stores: [
      { id: 'a', platform: 'pinduoduo', name: '拼多多旗舰店-AI', humanTarget: '小美', brand: '' },
      { id: 'b', platform: 'tmall', name: '天猫官方店-AI', humanTarget: '阿强', brand: '' },
      { id: 'c', platform: 'douyin', name: '抖店-AI', humanTarget: '小美', brand: '' },
      { id: 'd', platform: 'mock', name: '模拟店铺(测试)', humanTarget: '小美', brand: '' },
    ],
  };
  const convs = [
    { key: 'a::买家小林', storeId: 'a', platform: 'pinduoduo', convId: '买家小林', buyer: '买家小林', last: now - 20000, unread: 0, preview: '亲，目前有黑色、白色、燕麦色三个颜色哦~',
      msgs: [{ from: 'buyer', text: '这个有几个颜色', ts: now - 24000 }, { from: 'ai', text: '亲，目前有黑色、白色、燕麦色三个颜色哦~', ts: now - 22800 }, { from: 'buyer', text: '快递到哪了', ts: now - 9000 }, { from: 'ai', text: '亲，这个问题我帮您转接专属客服，马上为您处理~', ts: now - 8100 }] },
    { key: 'c::抖音用户8823', storeId: 'c', platform: 'douyin', convId: '抖音用户8823', buyer: '抖音用户8823', last: now - 60000, unread: 2, preview: '170 穿什么码', paused: false, msgs: [{ from: 'buyer', text: '170 穿什么码', ts: now - 60000 }] },
    { key: 'b::tb_阿珍', storeId: 'b', platform: 'tmall', convId: 'tb_阿珍', buyer: 'tb_阿珍', last: now - 300000, unread: 0, preview: '好的，谢谢', paused: true, msgs: [{ from: 'buyer', text: '能开发票吗', ts: now - 320000 }, { from: 'seller', text: '可以的亲，订单页申请电子发票就行', ts: now - 310000 }, { from: 'buyer', text: '好的，谢谢', ts: now - 300000 }] },
  ];
  const traces = [
    { kind: 'decision', id: 't1', storeId: 'a', convId: '买家小林', buyer: '买家小林', text: '这个有几个颜色', outcome: 'replied', totalMs: 1240, steps: [{ s: 'QA 检索', score: 0.94 }, { s: '已回复' }] },
    { kind: 'decision', id: 't2', storeId: 'a', convId: '买家小林', buyer: '买家小林', text: '快递到哪了', outcome: 'transferred', totalMs: 3360, steps: [{ s: '命中人工专属类', category: '物流' }, { s: '已发转接提示' }, { s: '已转接人工子账号' }] },
  ];
  const qa = [
    { id: 'q1', q: '有几个颜色', a: '亲，目前有黑色、白色、燕麦色三个颜色哦~', alts: ['有什么颜色', '颜色有哪些'], category: '售前', brand: '', hits: 128 },
    { id: 'q2', q: '多久发货', a: '亲，付款后48小时内发货，节假日顺延哦~', alts: ['什么时候发货'], category: '售前', brand: '', hits: 97 },
  ];
  const lat = Array.from({ length: 140 }, (_, i) => ({ ts: now - i * 400000, ms: 800 + Math.round(Math.random() * 6000) + (i % 37 === 0 ? 16000 : 0), outcome: ['replied', 'replied', 'replied', 'transferred', 'fallback'][i % 5] }));
  const status = { seat: settings.seat, modeOverride: 'auto', effectiveMode: 'ai', away: false, idle: false, sync: { status: 'ok', humanOnline: true, peers: [{ seatId: 'h', name: '客服组-人工机', role: 'human', ageSec: 3 }] }, modelReady: true };
  const defaults = { qaDirectThreshold: 0.72, modelMinConfidence: 0.6, hardDeadlineMs: 18000, handoffMsg: '亲，这个问题我帮您转接专属客服，马上为您处理~', holdingAfterMs: 0,
    humanOnly: [{ category: '投诉', words: ['投诉', '差评', '人工'] }, { category: '售后', words: ['退款', '退货', '破损'] }, { category: '订单', words: ['改地址', '取消订单'] }, { category: '物流', words: ['物流', '快递', '到哪了'] }],
    fallback: { '订单': '亲，订单相关的修改我已经帮您记录下来了…', '物流': '亲，正在为您核实物流信息…', '售后': '亲，非常抱歉给您带来不便…', '投诉': '亲，非常抱歉让您有不好的体验…', '默认': '亲，您的问题已经收到…' } };
  const P = v => Promise.resolve(v);
  window.kefu = {
    getState: () => P({ presets: { qwen: { label: '通义千问(阿里云百炼)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true, keyUrl: 'x' }, deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', needsKey: true, keyUrl: 'x' }, ollama: { label: '本地模型(Ollama)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', needsKey: false, keyUrl: 'x' }, claude: { label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', needsKey: true } }, settings, platforms: { pinduoduo: { name: '拼多多', url: 'https://mms.pinduoduo.com/chat-merchant/index.html' }, tmall: { name: '天猫/淘宝' }, douyin: { name: '抖店(飞鸽)' }, jd: { name: '京东' }, youzan: { name: '有赞' }, wechat: { name: '微信/企业微信', kind: 'api' }, mock: { name: '模拟平台(测试)' } },
      status, convs: convs.map(({ msgs, ...c }) => c), health: { a: { input: true, msgItem: 12, convList: 8, currentConv: '买家小林' }, b: { notReady: true }, d: { input: true, msgItem: 3 } }, defaults }),
    saveSettings: p => { Object.assign(settings, p); return P(settings); }, setViewport: v => { (window.__vp = window.__vp || []).push(v); return P(); }, storeAdd: s => P({ id: 'n', ...s }), storeUpdate: s => P(s), storeRemove: () => P(), storeReload: () => P(), storeClearLogin: () => P(), storeHealth: () => P({}),
    calibrate: () => P(null), getConv: k => P(convs.find(c => c.key === k)), readConv: () => P(), manualSend: () => P(true), takeOver: () => P(), release: () => P(), correct: () => P({}),
    qaList: () => P(qa), qaUpsert: x => P(x), qaRemove: () => P(), qaImport: () => P({ imported: 5, total: 7 }), qaExport: () => P(null), qaTest: () => P({ score: 0.81, item: qa[0] }),
    learnState: () => P({ readiness: [{ category: '售前', total: 64, agree: 59, rate: 59 / 64, ready: true }, { category: '物流', total: 12, agree: 5, rate: 5 / 12, ready: false }],
      candidates: [{ id: 'c1', q: '能开发票吗', alts: ['可以开发票不'], a: '可以的亲，下单后在订单页申请电子发票即可~', answers: ['可以的亲，下单后在订单页申请电子发票即可~', '可以开的，订单页申请就行'], count: 2, oneOff: false },
        { id: 'c2', q: '东西坏了怎么办', alts: [], a: '亲，已为您备注补发，单号 778812345 稍后同步', answers: ['亲，已为您备注补发，单号 778812345 稍后同步'], count: 1, oneOff: true, fromCorrection: true }], style: [] }),
    candApprove: () => P(), candReject: () => P(), todos: () => P([{ id: 't', storeId: 'a', buyer: '买家Tom', text: '退款怎么还没到', category: '售后', reason: '人工专属:退款', ts: now - 3600000, done: false }]), todoDone: () => P(),
    storeBack: () => P(), cancelPick: () => P(), latency: () => P(lat), modelTest: () => P({ ms: 812, reply: '亲，有黑白两色哦~', formatOk: true }), modelList: () => P(['qwen-flash','qwen-plus','qwen-max']), openExternal: () => P(), setAway: a => P({ ...status, away: a }),
    on: (ch, fn) => { (handlers[ch] = handlers[ch] || []).push(fn); },
  };
  window.addEventListener('load', () => setTimeout(() => traces.forEach(t => (handlers.trace || []).forEach(f => f(t))), 50));
})();
