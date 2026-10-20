// 应答引擎：一条买家消息从进来到回复/转接/兜底的全部决策，带耗时记录
// 模式：ai = AI 托管（处理不了 → 平台转接人工子账号）
//      human = 人工接待（AI 只做影子草稿 + 学习）
//      takeover = 人工离线，AI 接管（不转接，处理不了 → 分类保底话术 + 待办）
const { EventEmitter } = require('events');

const DEFAULTS = {
  mergeWindowMs: 1200,        // 买家连发几条时合并后再答
  qaDirectThreshold: 0.72,    // QA 相似度达到此值直接用答案
  modelMinConfidence: 0.6,    // 模型置信度低于此值视为答不了
  modelTimeoutMs: 9000,
  hardDeadlineMs: 18000,      // 从收到消息算起，超过还没答复就发保底话术（目标 20s，极限 30s）
  holdingAfterMs: 0,          // >0 时，超过该时长还没出结果先发一句安抚（默认关闭）
  holdingMsg: '亲，在的~正在为您查询，请稍等哦',
  ignoreSellerPatterns: [],
  autoProductLink: true,      // 买家问到商品库里的商品时，回复后自动补发链接
  useOrderInfo: true,         // 模型作答前读取该买家的订单作参考   // 平台自动回复/欢迎语里的关键词：出现这些的卖家消息不算人工插话
  handoffMsg: '亲，这个问题我帮您转接专属客服，马上为您处理~',
  humanOnly: [
    { category: '投诉', words: ['投诉', '差评', '12315', '举报', '骗子', '人工', '转人工', '真人'] },
    { category: '售后', words: ['退款', '退货', '换货', '破损', '坏了', '质量问题', '少发', '漏发', '发错', '赔', '补发', '售后'] },
    { category: '订单', words: ['改地址', '修改地址', '换地址', '改订单', '取消订单', '拆单', '合并订单', '改规格', '备注'] },
    { category: '物流', words: ['物流', '快递', '到哪了', '没收到', '没到', '发货了吗', '什么时候发', '单号', '派送', '签收', '仓库'] },
  ],
  fallback: {
    '订单': '亲，订单相关的修改我已经帮您记录下来了，客服上线后会第一时间为您处理，请您放心~',
    '物流': '亲，正在为您核实物流信息，稍后客服会给您准确答复，请稍等哦~',
    '售后': '亲，非常抱歉给您带来不便，您的售后问题已登记，客服上线后第一时间为您处理~',
    '投诉': '亲，非常抱歉让您有不好的体验，您的问题已经加急登记，专属客服会尽快联系您~',
    '默认': '亲，您的问题已经收到，我这边帮您登记了，客服会尽快给您详细答复~',
  },
};

class ReplyEngine extends EventEmitter {
  // deps: { qa, models, learner, getSettings, actions: { send, transfer }, store }
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.buffers = new Map();   // convKey -> { texts, timer, first }
    this.chains = new Map();    // convKey -> 正在处理的 Promise（同会话串行）
    this.takeoverPaused = new Set();  // 离线接管期间被人工接手的会话：模式切换后恢复
    this.removed = new Set();   // 已删除的店铺
    this.expected = new Map();  // convKey -> { until, n }：刚点了平台的「发送订单/商品」按钮，接下来出现的卖家消息是本系统发的
    this.sentProducts = new Map(); // convKey -> 已自动发过链接的商品 id
    this.paused = new Set();    // 人工手动接管的会话
    this.history = new Map();   // convKey -> 最近消息
    this.ourTexts = new Map();  // convKey -> 本系统刚发出的文本（用来区分人工回复）
  }
  cfg() { const s = this.getSettings(); return { ...DEFAULTS, ...(s.engine || {}), humanOnly: s.engine?.humanOnly || DEFAULTS.humanOnly, fallback: { ...DEFAULTS.fallback, ...(s.engine?.fallback || {}) } }; }
  mode() { return this.getSettings().effectiveMode || this.getSettings().mode || 'human'; }
  key(m) { return `${m.storeId}::${m.convId}`; }

  pushHistory(k, from, text) {
    const h = this.history.get(k) || []; h.push({ from, text, ts: Date.now() });
    this.history.set(k, h.slice(-20));
  }

  // 平台适配器上报：买家新消息
  onBuyerMessage(m) {
    const k = this.key(m);
    this.pushHistory(k, 'buyer', m.text);
    const cfg = this.cfg();
    let b = this.buffers.get(k);
    if (!b) { b = { texts: [], first: m.receivedAt || Date.now(), meta: m }; this.buffers.set(k, b); }
    b.texts.push(m.text); b.meta = { ...b.meta, ...m };
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      this.buffers.delete(k);
      const msg = { ...b.meta, text: b.texts.join('，'), parts: b.texts.length, receivedAt: b.first };
      // 同一个会话串行处理：上一条还在等模型时，新消息排在它后面，避免重复回复或乱序
      const prev = this.chains.get(k) || Promise.resolve();
      const next = prev.catch(() => {}).then(() => this.handle(msg)).catch(e => { if (this.listenerCount('error')) this.emit('error', e); });
      this.chains.set(k, next);
      next.finally(() => { if (this.chains.get(k) === next) this.chains.delete(k); });
    }, cfg.mergeWindowMs);
  }

  // 判断页面上出现的卖家消息是不是本系统刚发的（平台会改空格、换行、截断）
  // 点平台按钮发卡片时，卡片文字我们事先不知道：登记一个短时间窗口
  expectOurs(k, ms = 8000, n = 1) { const e = this.expected.get(k); this.expected.set(k, { until: Date.now() + ms, n: (e && e.until > Date.now() ? e.n : 0) + n }); }
  isOurs(k, text) {
    const e = this.expected.get(k);
    if (e && e.until > Date.now() && e.n > 0) { e.n--; if (!e.n) this.expected.delete(k); return true; }
    const flat = t => String(t || '').replace(/\s+/g, '');
    const x = flat(text); const ours = this.ourTexts.get(k) || [];
    // 允许平台截断/改格式，但短的一方至少要有长的一方的 80%，避免人工的简短回复被误认成 AI 的
    const idx = ours.findIndex(o => { const y = flat(o); return y === x || (Math.min(x.length, y.length) >= 6 && Math.min(x.length, y.length) >= 0.8 * Math.max(x.length, y.length) && (y.startsWith(x) || x.startsWith(y))); });
    if (idx >= 0) { ours.splice(idx, 1); return true; }
    return false;
  }

  // 平台适配器上报：卖家侧发出的消息（可能是我们发的，也可能是人工）
  onSellerMessage(m) {
    const k = this.key(m);
    if (this.isOurs(k, m.text)) return;
    // 平台自动回复 / 欢迎语等（设置里可配关键词）不算人工
    const ignore = this.cfg().ignoreSellerPatterns || [];
    if (ignore.some(w => w && m.text.includes(w))) return;
    this.pushHistory(k, 'seller', m.text);
    // 人工回复：影子学习 / 纠错学习
    const r = this.learner.observeHumanReply(k, m.text, { brand: m.brand });
    if (r) this.emit('trace', { ...m, kind: 'shadow-compare', ...r });
    if (this.mode() !== 'human' && !this.paused.has(k)) {
      // 托管中有人插话 → 视为人工接管该会话
      this.paused.add(k);
      if (this.mode() === 'takeover') this.takeoverPaused.add(k);
      this.emit('trace', { ...m, kind: 'human-takeover' });
    }
  }

  async handle(m) {
    const k = this.key(m), cfg = this.cfg(), mode = this.mode();
    const t = { received: m.receivedAt || Date.now() };
    const trace = { id: `${k}-${t.received}`, storeId: m.storeId, platform: m.platform, convId: m.convId, buyer: m.buyer, text: m.text, received: t.received, mode, steps: [] };
    const step = (s, extra = {}) => { trace.steps.push({ s, at: Date.now() - t.received, ...extra }); };
    const finish = (outcome) => { trace.outcome = outcome; trace.totalMs = Date.now() - t.received; this.emit('trace', { kind: 'decision', ...trace }); this.recordLatency(trace); return trace; };
    const humanTookOver = () => this.paused.has(k) || (mode !== 'human' && this.mode() === 'human');

    if (mode !== 'human' && this.paused.has(k)) { step('会话已由人工接管，AI 不回复'); return finish('skipped'); }

    // 时限从收到消息就开始算，覆盖模型作答的时间：到点还没答复就发保底话术
    let done = false;
    let deadlineP = null;
    const deadline = mode === 'human' ? null : setTimeout(() => {
      if (done || humanTookOver()) return; done = true;
      step('超过时限，发送保底话术');
      deadlineP = this.sendFallback(m, '默认', mode, '超时', step).then(() => finish('fallback'), e => { step('保底话术发送失败', { err: e.message }); return finish('error'); });
    }, Math.max(0, cfg.hardDeadlineMs - (Date.now() - t.received)));

    // 1) 决策（人工模式下也跑一遍，作为影子草稿）
    let decision;
    try { decision = await this.decide(m, cfg, step, t, mode); }
    catch (e) { decision = { action: 'handoff', category: '默认', reason: '出错' }; step('出错', { err: e.message }); }

    if (mode === 'human') {
      this.learner.draft(k, m.text, decision);
      step('影子草稿（未发送）', { draft: decision.reply, action: decision.action });
      return finish('shadow');
    }
    if (done) { step('模型迟到的结果已丢弃'); return deadlineP; }
    done = true; clearTimeout(deadline);
    if (this.removed.has(m.storeId)) return finish('skipped');
    // 等模型期间人工接手了 → 不再插话
    if (humanTookOver()) { step('等待期间人工已接手，AI 不发送'); return finish('skipped'); }

    // 2) 执行
    try {
      if (decision.action === 'reply' && decision.reply) {
        await this.send(m, decision.reply);
        step('已回复', { source: decision.source });
        await this.maybeSendProduct(m, step);
        return finish('replied');
      }
      if (mode === 'ai') {
        await this.send(m, cfg.handoffMsg);
        step('已发转接提示');
        const ok = await this.actions.transfer(m).catch(e => { step('转接失败', { err: e.message }); return false; });
        if (ok) { step('已转接人工子账号'); this.paused.add(k); return finish('transferred'); }
        this.addTodo(m, decision.category, '转接失败');
        step('转接失败，已记待办');
        return finish('todo');
      }
      await this.sendFallback(m, decision.category, mode, decision.reason, step);
      return finish('fallback');
    } catch (e) {
      step('发送出错', { err: e.message });
      this.addTodo(m, decision.category || '默认', '发送失败：' + e.message);
      return finish('error');
    }
  }

  async decide(m, cfg, step, t, mode) {
    // 人工专属类（订单/物流/售后/投诉）直接交人工
    for (const g of cfg.humanOnly) {
      const w = g.words.find(w => m.text.includes(w));
      if (w) { step('命中人工专属类', { category: g.category, word: w }); return { action: 'handoff', category: g.category, reason: `人工专属:${w}` }; }
    }
    const hit = this.qa.match(m.text, m.brand);
    step('QA 检索', { score: Number(hit.score.toFixed(2)), q: hit.item?.q, via: hit.via });
    if (hit.item && hit.score >= cfg.qaDirectThreshold) {
      if (mode !== 'human') this.qa.recordHit(hit.item.id);
      return { action: 'reply', reply: hit.item.a, source: 'qa', category: hit.item.category || '售前', confidence: hit.score };
    }
    let holding;
    if (cfg.holdingAfterMs > 0 && mode !== 'human') {
      holding = setTimeout(() => { this.send(m, cfg.holdingMsg).then(() => step('已发安抚语')).catch(() => {}); }, Math.max(0, cfg.holdingAfterMs - (Date.now() - t.received)));
    }
    try {
      const remain = cfg.hardDeadlineMs - (Date.now() - t.received) - 1500;
      // 历史里去掉本次合并进来的几条买家消息，避免在提示词里重复
      const hist = this.history.get(this.key(m)) || [];
      // 托管/接管模式下读一下该买家的订单给模型参考（人工模式不动页面，免得切走人工正在看的会话）
      let orderInfo = '';
      if (mode !== 'human' && this.actions.getOrders && cfg.useOrderInfo !== false) {
        const os = await Promise.race([this.actions.getOrders(m).catch(() => null), new Promise(r => setTimeout(() => r(null), 2500))]);
        if (os && os.length) { orderInfo = os.slice(0, 3).map(o => o.lines.join(' ')).join('\n'); step('读取订单', { count: os.length }); }
      }
      const prod = this.products ? this.products.match(m.text, m.brand) : null;
      const r = await this.models.ask({ question: m.text, orderInfo, product: prod?.item, history: hist.slice(0, Math.max(0, hist.length - (m.parts || 1))),
        references: this.qa.topK(m.text, m.brand, 5), style: this.learner.styleSamples.slice(-8),
        shopInfo: m.shopInfo, timeoutMs: Math.max(2000, Math.min(cfg.modelTimeoutMs, remain)) });
      step('模型作答', { provider: r.provider, ms: r.ms, confidence: r.confidence, action: r.action });
      if (r.action === 'reply' && r.reply && r.confidence >= cfg.modelMinConfidence) return { ...r, source: 'model' };
      return { ...r, action: 'handoff', reason: r.action === 'handoff' ? '模型判断需人工' : '置信度不足' };
    } catch (e) {
      step(e.noModel ? '未配置模型' : '模型失败', { err: e.message });
      return { action: 'handoff', category: '默认', reason: e.noModel ? '未配置模型' : '模型失败' };
    } finally { clearTimeout(holding); }
  }

  // 买家问到某个商品：回复之后自动补发这个商品的链接（每个会话每个商品只发一次）
  async maybeSendProduct(m, step) {
    if (!this.products || this.cfg().autoProductLink === false) return;
    const hit = this.products.match(m.text, m.brand);
    if (!hit || !hit.item.url) return;
    const k = this.key(m); const sent = this.sentProducts.get(k) || new Set();
    if (sent.has(hit.item.id)) return;
    sent.add(hit.item.id); this.sentProducts.set(k, sent);
    try { await this.send(m, [hit.item.name, hit.item.price, hit.item.url].filter(Boolean).join(' ')); step('已附商品链接', { product: hit.item.name }); }
    catch (e) { step('商品链接发送失败', { err: e.message }); }
  }
  async sendFallback(m, category, mode, reason, step) {
    const cfg = this.cfg();
    await this.send(m, cfg.fallback[category] || cfg.fallback['默认']);
    this.addTodo(m, category || '默认', reason);
    step('已发保底话术并记待办', { category });
  }
  async send(m, text) {
    const k = this.key(m);
    const ours = this.ourTexts.get(k) || []; ours.push(String(text).trim()); this.ourTexts.set(k, ours.slice(-10));
    this.pushHistory(k, 'seller', text);
    await this.actions.send(m, text);
  }
  addTodo(m, category, reason) {
    if (this.removed.has(m.storeId)) return;
    const todos = this.store.get('todos', []);
    todos.unshift({ id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, storeId: m.storeId, platform: m.platform, convId: m.convId, buyer: m.buyer, text: m.text, category, reason, ts: Date.now(), done: false });
    this.store.set('todos', todos.slice(0, 2000));
    this.emit('todo', todos[0]);
  }
  recordLatency(tr) {
    if (!['replied', 'transferred', 'fallback', 'todo'].includes(tr.outcome)) return;
    const l = this.store.get('latency', []); l.push({ ts: Date.now(), ms: tr.totalMs, outcome: tr.outcome, platform: tr.platform });
    this.store.set('latency', l.slice(-5000));
  }
  // 删除店铺时清理它的所有会话状态
  purgeStore(storeId) {
    this.removed.add(storeId);
    const pre = storeId + '::';
    for (const [k, b] of this.buffers) if (k.startsWith(pre)) { clearTimeout(b.timer); this.buffers.delete(k); }
    for (const map of [this.history, this.ourTexts, this.chains]) for (const k of [...map.keys()]) if (k.startsWith(pre)) map.delete(k);
    for (const k of [...this.paused]) if (k.startsWith(pre)) this.paused.delete(k);
  }
  // 模式切换：离线接管期间临时“被人工接手”的会话恢复正常
  onModeChange() { for (const k of this.takeoverPaused) this.paused.delete(k); this.takeoverPaused.clear(); }
  takeOver(storeId, convId) { this.paused.add(`${storeId}::${convId}`); }
  release(storeId, convId) { this.paused.delete(`${storeId}::${convId}`); }
}

module.exports = { ReplyEngine, DEFAULTS };
