// 模型层：用本地假接口模拟任意 OpenAI 兼容 / Claude 接口，验证路由、备用切换、超时、思考型输出、型号列表
const http = require('http');
const { ModelRouter, parseJson } = require('../engine/llm');
const fails = []; const check = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
let mode = {};
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const port = srv.address().port, who = req.headers.host;
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] })); return; }
    const key = req.url.split('/')[1];
    const m = mode[key] || 'ok';
    if (m === 'auth') { res.statusCode = 401; res.end('{"error":"bad key"}'); return; }
    if (m === 'slow') { setTimeout(() => res.end('{}'), 5000); return; }
    const text = m === 'think' ? '<think>先想想 {"x":1}</think>\n```json\n{"reply":"有黑白两色哦","action":"reply","confidence":0.9,"category":"售前"}\n```'
      : m === 'junk' ? '你好，我是助手' : '{"reply":"有黑白两色哦","action":"reply","confidence":0.88,"category":"售前"}';
    if (req.url.includes('/v1/messages')) res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    else res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
});
srv.listen(0, async () => {
  const u = p => `http://127.0.0.1:${srv.address().port}/${p}`;
  let models = [];
  const r = new ModelRouter(() => ({ models }));
  const ask = () => r.ask({ question: '有什么颜色', references: [], timeoutMs: 3000 });
  // 未配置
  try { await ask(); check(false, '未配置应报错'); } catch (e) { check(e.noModel, '一个模型都没启用 → 报“未配置”，引擎改走知识库/转人工'); }
  // 本地模型不需要 Key
  models = [{ preset: 'ollama', baseUrl: u('a'), model: 'qwen3:8b', enabled: true }];
  let a = await ask(); check(a.reply === '有黑白两色哦' && a.provider.includes('Ollama'), '本地模型（无 Key）可用');
  // 需要 Key 但没填 → 不使用
  models = [{ preset: 'qwen', baseUrl: u('a'), model: 'x', apiKey: '', enabled: true }];
  check(r.providers().length === 0, '需要 Key 的平台没填 Key 不会被调用');
  // 第一个 401、第二个超时、第三个成功
  mode = { a: 'auth', b: 'slow', c: 'ok' };
  models = [{ preset: 'deepseek', baseUrl: u('a'), model: 'm', apiKey: 'k', enabled: true }, { preset: 'glm', baseUrl: u('b'), model: 'm', apiKey: 'k', enabled: true }, { preset: 'kimi', baseUrl: u('c'), model: 'm', apiKey: 'k', enabled: true }];
  try { a = await ask(); check(false, '总时限内第三个来不及应报错'); } catch (e) { check(/401/.test(e.message) && /超时/.test(e.message), `前一个失败自动换下一个，总时限内放弃：${e.message.slice(0, 80)}`); }
  mode = { a: 'auth', c: 'ok' }; models = [models[0], models[2]];
  a = await ask(); check(a.provider === 'Kimi(月之暗面)', '第一个 Key 错误 → 自动用第二个');
  // Claude 格式
  mode = {}; models = [{ preset: 'claude', baseUrl: u('d'), model: 'm', apiKey: 'k', enabled: true }];
  a = await ask(); check(a.reply === '有黑白两色哦', 'Claude 接口格式可用');
  // 思考型模型输出
  mode = { e: 'think' }; models = [{ preset: 'custom', baseUrl: u('e'), model: 'm', enabled: true }];
  a = await ask(); check(a.reply === '有黑白两色哦' && a.action === 'reply', '思考型模型（<think> + ```json）能正确解析');
  // 不按格式输出 → 不发给买家
  mode = { f: 'junk' }; models = [{ preset: 'custom', baseUrl: u('f'), model: 'm', enabled: true }];
  a = await ask(); check(a.action === 'handoff' && !a.reply, '模型乱答（非 JSON）不会直接发给买家');
  // 型号列表 / 测试
  const list = await r.listModels({ preset: 'custom', baseUrl: u('g'), apiKey: 'k' });
  check(list.join() === 'm-a,m-b', '获取型号列表');
  const t = await r.test({ preset: 'custom', baseUrl: u('h'), model: 'm' }); check(t.ok && t.formatOk, '测试按钮返回试答');
  try { await r.test({ preset: 'qwen', model: 'm', apiKey: '' }); check(false, ''); } catch (e) { check(/API Key/.test(e.message), '测试时提示缺少 Key'); }
  check(parseJson('{"reply":"","action":"reply","confidence":0.9}').action === 'handoff', '空回复视为转人工');
  srv.close(); console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
});
