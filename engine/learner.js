// 影子学习：人工模式下，AI 对每条买家消息拟一个回复但不发送；
// 等人工实际回复后做对比，提炼候选 QA（必须人工确认才入库），并按分类统计吻合率
const { similarity, normalize } = require('./qa');

const ONE_OFF = /(订单号?|单号|\d{6,}|补偿?|赔|退.{0,3}\d+.?元|返现|已为您|已经帮您|给您备注|改好了|已改|这单)/;
const PII = [
  [/1[3-9]\d{9}/g, '[手机号]'],
  [/\d{15,19}/g, '[号码]'],
  [/(省|市|区|县|镇|街道|路|号楼|单元|室)[^，。,\s]{0,12}\d+[^，。,\s]{0,8}/g, '[地址]'],
];
function scrub(t) { let s = String(t); for (const [re, rep] of PII) s = s.replace(re, rep); return s; }

class Learner {
  constructor(store, qa) { this.store = store; this.qa = qa; this.pending = new Map(); }
  get candidates() { return this.store.get('candidates', []); }
  get stats() { return this.store.get('shadowStats', {}); }
  get styleSamples() { return this.store.get('styleSamples', []); }

  // 记录 AI 的影子草稿，等待人工回复
  draft(convKey, buyerText, draft) {
    this.pending.set(convKey, { buyerText, draft, ts: Date.now() });
  }
  // 观察到人工（非本系统发出）的回复
  observeHumanReply(convKey, humanText, { brand = '' } = {}) {
    const p = this.pending.get(convKey);
    if (!p || Date.now() - p.ts > 10 * 60 * 1000 || !humanText) return null;
    this.pending.delete(convKey);
    const draft = p.draft || {};
    const sim = draft.reply ? similarity(draft.reply, humanText) : 0;
    // 草稿与人工都没给出实质答案时不计入
    const agree = draft.action === 'handoff' ? false : sim >= 0.45 || (draft.source === 'qa' && sim >= 0.3);
    const cat = draft.category || '其他';
    const stats = this.stats; const st = stats[cat] || (stats[cat] = { total: 0, agree: 0 });
    st.total++; if (agree) st.agree++;
    this.store.set('shadowStats', stats);

    // 语气样本（最近 30 条），给模型模仿说话习惯
    const samples = this.styleSamples.slice(-29); samples.push(scrub(humanText).slice(0, 80));
    this.store.set('styleSamples', samples);

    const cand = this.addCandidate(p.buyerText, humanText, { brand, category: cat });
    return { agree, sim: Number(sim.toFixed(2)), category: cat, candidateId: cand?.id };
  }
  addCandidate(question, answer, { brand = '', category = '' } = {}) {
    const q = scrub(question).trim(), a = scrub(answer).trim();
    if (normalize(q).length < 2 || normalize(a).length < 2) return null;
    // 知识库里已有几乎相同的问答就不重复提
    const hit = this.qa.match(q, brand);
    if (hit.item && hit.score > 0.85 && similarity(hit.item.a, a) > 0.6) return null;
    const list = this.candidates.slice();
    const same = list.find(c => c.status === 'pending' && c.brand === brand && similarity(c.q, q) >= 0.7);
    if (same) {
      same.count++; same.answers = [...new Set([...same.answers, a])].slice(-5);
      if (!same.alts.includes(q) && q !== same.q) same.alts.push(q);
      same.oneOff = same.oneOff && ONE_OFF.test(a); same.updatedAt = Date.now();
      this.store.set('candidates', list); return same;
    }
    const c = { id: `cand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, q, alts: [], answers: [a], a,
      category, brand, count: 1, oneOff: ONE_OFF.test(a), status: 'pending', ts: Date.now(), updatedAt: Date.now() };
    list.push(c); this.store.set('candidates', list); return c;
  }
  approve(id, edits = {}) {
    const list = this.candidates.slice(); const c = list.find(x => x.id === id); if (!c) return null;
    Object.assign(c, edits, { status: 'approved', updatedAt: Date.now() });
    this.store.set('candidates', list);
    return this.qa.upsert({ id: `learn-${c.id}`, q: c.q, a: edits.a || c.a, alts: c.alts, category: c.category, brand: c.brand, source: '影子学习' });
  }
  reject(id) {
    const list = this.candidates.slice(); const c = list.find(x => x.id === id); if (c) { c.status = 'rejected'; c.updatedAt = Date.now(); }
    this.store.set('candidates', list);
  }
  // 人工在 AI 模式下改写了 AI 的回复 → 直接作为候选（优先级更高）
  correction(question, betterAnswer, opts) { const c = this.addCandidate(question, betterAnswer, opts); if (c) { c.fromCorrection = true; this.store.set('candidates', this.candidates); } return c; }

  // 各分类吻合率，达到阈值的分类建议开放 AI 托管
  readiness(threshold = 0.9, minSamples = 20) {
    return Object.entries(this.stats).map(([category, s]) => ({ category, ...s, rate: s.total ? s.agree / s.total : 0,
      ready: s.total >= minSamples && s.agree / s.total >= threshold }));
  }
}

module.exports = { Learner, scrub };
