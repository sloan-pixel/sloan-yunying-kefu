// 模型路由：任意模型驱动，不绑定某一家
// 内置常用国内外模型 + 本地模型（Ollama，免费、无需 Key）+ 任意 OpenAI 兼容接口
// 按列表顺序尝试，超时或失败自动切下一个；一个都没配置时，软件只用知识库回答，其余转人工 / 保底
const PRESETS = {
  qwen:     { kind: 'openai',    label: '通义千问(阿里云百炼)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true, keyUrl: 'https://bailian.console.aliyun.com/' },
  deepseek: { kind: 'openai',    label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  glm:      { kind: 'openai',    label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', needsKey: true, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  kimi:     { kind: 'openai',    label: 'Kimi(月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6', needsKey: true, keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  doubao:   { kind: 'openai',    label: '豆包(火山方舟)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-8-251228', needsKey: true, keyUrl: 'https://console.volcengine.com/ark' },
  openai:   { kind: 'openai',    label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
  claude:   { kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', needsKey: true, keyUrl: 'https://console.anthropic.com/' },
  ollama:   { kind: 'openai',    label: '本地模型(Ollama)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', needsKey: false, keyUrl: 'https://ollama.com/download' },
  custom:   { kind: 'openai',    label: '自定义(OpenAI 兼容)', baseUrl: '', model: '', needsKey: false, keyUrl: '' },
};

const SYSTEM = `你是电商店铺的在线客服，只根据【参考资料】和【店铺信息】回答买家，语气亲切简洁（中文，1~3句，不超过80字）。
规则：
1. 参考资料里没有、或需要查订单/物流/库存/价格改动/退款赔偿承诺的，不要编造，action 设为 "handoff"。
2. 买家情绪激动、投诉、威胁差评、要求人工，action 设为 "handoff"。
3. 只输出 JSON，不要任何别的文字：{"reply":"给买家的话","action":"reply|handoff","confidence":0到1的小数,"category":"售前|物流|售后|订单|投诉|闲聊|其他"}`;

async function withTimeout(promiseFn, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await promiseFn(ctl.signal); } finally { clearTimeout(t); }
}
const base = u => String(u || '').trim().replace(/\/+$/, '');

async function readError(res, label) {
  let body = ''; try { body = (await res.text()).slice(0, 200); } catch {}
  const hint = res.status === 401 || res.status === 403 ? '（API Key 不对或没有权限）' : res.status === 404 ? '（接口地址或型号名不对，可点「获取型号」看看）' : res.status === 429 ? '（额度用完或请求太频繁）' : '';
  return new Error(`${label} ${res.status}${hint}: ${body}`);
}

async function callAnthropic(p, messages, signal) {
  const res = await fetch(base(p.baseUrl) + '/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: p.model, max_tokens: 1024, system: messages.system, messages: messages.turns, temperature: 0.3 }),
  });
  if (!res.ok) throw await readError(res, p.label);
  const j = await res.json();
  return (j.content || []).map(c => c.text || '').join('');
}
async function callOpenAI(p, messages, signal) {
  const headers = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  const res = await fetch(base(p.baseUrl) + '/chat/completions', {
    method: 'POST', signal, headers,
    body: JSON.stringify({ model: p.model, max_tokens: 1024, temperature: 0.3, stream: false,
      // 本地 qwen3 等思考型模型：要求直接作答，不先长篇思考（其它模型会忽略这行）
      messages: [{ role: 'system', content: messages.system + (p.preset === 'ollama' ? '\n/no_think' : '') }, ...messages.turns] }),
  });
  if (!res.ok) throw await readError(res, p.label || p.model);
  const j = await res.json();
  const msg = j.choices?.[0]?.message || {};
  return typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
}

// 兼容“思考型”模型：去掉 <think>…</think>，取最后一个 JSON 对象
function parseJson(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/```(?:json)?/gi, '').trim();
  const cands = clean.match(/\{[^{}]*\}/g) || [];
  for (let i = cands.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(cands[i]);
      if (!('reply' in j) && !('action' in j)) continue;
      const reply = String(j.reply || '').trim();
      return { reply, action: j.action === 'handoff' || !reply ? 'handoff' : 'reply',
        confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), category: j.category || '其他' };
    } catch {}
  }
  // 模型没按格式输出：不直接发给买家，按“答不了”处理
  return { reply: '', action: 'handoff', confidence: 0, category: '其他', badFormat: true };
}

function resolve(m) {
  const pre = PRESETS[m.preset] || PRESETS.custom;
  const p = { ...pre };
  for (const [k, v] of Object.entries(m)) if (v !== '' && v != null) p[k] = v;
  return p;
}
function usable(p) { return !!(p.enabled && base(p.baseUrl) && p.model && (p.apiKey || !p.needsKey)); }

class ModelRouter {
  // settings.models: [{ id, preset, apiKey, model, baseUrl, enabled }]
  constructor(getSettings) { this.getSettings = getSettings; this.stats = {}; }
  providers() { return (this.getSettings().models || []).map(resolve).filter(usable); }
  async ask({ question, history = [], references = [], style = [], shopInfo = '', orderInfo = '', product = null, timeoutMs }) {
    const s = this.getSettings();
    const refs = references.map((r, i) => `${i + 1}. 问：${r.item.q}\n   答：${r.item.a}`).join('\n') || '（无）';
    const styleText = style.length ? `\n【本店人工客服的说话习惯，模仿语气即可，不要照抄内容】\n${style.map(x => '- ' + x).join('\n')}` : '';
    const orderText = orderInfo ? `\n【该买家的订单（来自平台页面，可据此回答订单状态、物流；不要编造页面上没有的信息）】\n${orderInfo}` : '';
    const prodText = product ? `\n【买家问到的商品】${product.name}${product.price ? '，价格 ' + product.price : ''}${product.desc ? '，' + product.desc : ''}（链接会另外自动发送，回复里不用写链接）` : '';
    const system = `${SYSTEM}\n\n【店铺信息】${shopInfo || s.shopInfo || '（未填写）'}\n【参考资料】\n${refs}${orderText}${prodText}${styleText}`;
    const turns = [...history.slice(-6).map(h => ({ role: h.from === 'buyer' ? 'user' : 'assistant', content: h.text })),
      { role: 'user', content: question }];
    // 合并相邻同角色（部分模型要求一问一答交替）
    const merged = [];
    for (const t of turns) { const last = merged[merged.length - 1]; if (last && last.role === t.role) last.content += '\n' + t.content; else merged.push({ ...t }); }
    while (merged[0]?.role === 'assistant') merged.shift();

    const list = this.providers();
    if (!list.length) { const e = new Error('未配置可用模型（设置 → 模型）'); e.noModel = true; throw e; }
    const deadline = Date.now() + (timeoutMs || 9000);
    const errors = [];
    for (const p of list) {
      const left = deadline - Date.now();
      if (left < 800) { errors.push(`${p.label}: 时间不够，跳过`); break; }
      const t0 = Date.now();
      try {
        const text = await withTimeout(sig => (p.kind === 'anthropic' ? callAnthropic : callOpenAI)(p, { system, turns: merged }, sig), left);
        this.note(p, Date.now() - t0, true);
        return { ...parseJson(text), provider: p.label, ms: Date.now() - t0 };
      } catch (e) {
        this.note(p, Date.now() - t0, false);
        errors.push(`${p.label}: ${e.name === 'AbortError' ? '超时' : e.message}`);
      }
    }
    throw new Error(errors.join('；'));
  }
  note(p, ms, ok) {
    const k = p.label; const st = this.stats[k] || (this.stats[k] = { ok: 0, fail: 0, avgMs: 0 });
    if (ok) { st.avgMs = Math.round((st.avgMs * st.ok + ms) / (st.ok + 1)); st.ok++; } else st.fail++;
  }
  async test(model) {
    const p = resolve({ ...model, enabled: true });
    if (!base(p.baseUrl)) throw new Error('请填写接口地址');
    if (!p.model) throw new Error('请填写型号名');
    if (p.needsKey && !p.apiKey) throw new Error('请填写 API Key');
    const t0 = Date.now();
    const text = await withTimeout(sig => (p.kind === 'anthropic' ? callAnthropic : callOpenAI)(p,
      { system: SYSTEM + '\n\n【参考资料】\n1. 问：有几个颜色\n   答：黑白两色', turns: [{ role: 'user', content: '有什么颜色' }] }, sig), 20000);
    const r = parseJson(text);
    return { ok: true, ms: Date.now() - t0, reply: r.reply, formatOk: !r.badFormat };
  }
  // 向接口查询可用型号（OpenAI 兼容的 /models；Claude 的 /v1/models）
  async listModels(model) {
    const p = resolve({ ...model, enabled: true });
    const url = base(p.baseUrl) + (p.kind === 'anthropic' ? '/v1/models' : '/models');
    const headers = p.kind === 'anthropic' ? { 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' } : (p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {});
    const res = await withTimeout(sig => fetch(url, { headers, signal: sig }), 10000);
    if (!res.ok) throw await readError(res, p.label);
    const j = await res.json();
    const arr = j.data || j.models || [];
    return arr.map(x => x.id || x.name || x.model).filter(Boolean).sort();
  }
}

module.exports = { ModelRouter, PRESETS, parseJson, resolve, usable };
