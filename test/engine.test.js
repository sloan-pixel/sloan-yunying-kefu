// 应答引擎测试：用假模型、假平台动作，验证三种模式的决策和时效
// 运行：node test/engine.test.js
const os = require('os'), fs = require('fs'), path = require('path');
const Module = require('module');
// 本地开发环境的 jszip 在全局工具目录里；正式安装后由 npm install 提供
try { require.resolve('jszip'); } catch { process.env.NODE_PATH = '/opt/npm-tools/node_modules'; Module._initPaths(); }

const { JsonStore } = require('../engine/store');
const { QAKnowledge, similarity } = require('../engine/qa');
const { Learner } = require('../engine/learner');
const { ReplyEngine } = require('../engine/router');

const fails = [];
const check = (c, msg) => { console.log((c ? '✅ ' : '❌ ') + msg); if (!c) fails.push(msg); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kefu-'));
  const store = new JsonStore(dir);
  const qa = new QAKnowledge(store);
  const r = await qa.importFile(path.join(__dirname, '../samples/QA知识库模板.xlsx'));
  check(r.imported === 5, `Excel 导入 ${r.imported} 条`);
  check(qa.match('请问有什么颜色呀').score >= 0.72, `相似问法命中：有什么颜色 → ${qa.match('请问有什么颜色呀').score.toFixed(2)}`);
  check(qa.match('付款后多久能发货').item.q === '多久发货', `改写问法命中：付款后多久能发货 → ${qa.match('付款后多久能发货').item.q} ${qa.match('付款后多久能发货').score.toFixed(2)}`);
  check(qa.match('你们家狗粮好吃吗').score < 0.5, `无关问题不误命中：${qa.match('你们家狗粮好吃吗').score.toFixed(2)}`);

  let settings = { mode: 'ai', engine: { mergeWindowMs: 100, hardDeadlineMs: 3000 } };
  let modelBehavior = 'ok';
  const models = { ask: async ({ question, timeoutMs }) => {
    if (modelBehavior === 'slow') { await wait(timeoutMs + 50); const e = new Error('超时'); throw e; }
    if (modelBehavior === 'none') { const e = new Error('未配置模型'); e.noModel = true; throw e; }
    if (modelBehavior === 'low') return { reply: '不太确定', action: 'reply', confidence: 0.3, category: '售前', provider: 'fake', ms: 5 };
    await wait(50);
    return { reply: `模型答：${question}`, action: 'reply', confidence: 0.9, category: '售前', provider: 'fake', ms: 50 };
  } };
  const sent = [], transfers = [];
  let transferOk = true;
  const learner = new Learner(store, qa);
  const eng = new ReplyEngine({ qa, models, learner, store, getSettings: () => settings,
    actions: { send: async (m, text) => sent.push({ conv: m.convId, text }), transfer: async (m) => { transfers.push(m.convId); return transferOk; } } });
  const traces = []; eng.on('trace', t => traces.push(t));
  const buyer = (conv, text) => eng.onBuyerMessage({ storeId: 's1', platform: 'mock', convId: conv, buyer: conv, text, receivedAt: Date.now() });
  const last = () => traces.filter(t => t.kind === 'decision').slice(-1)[0];

  // AI 模式
  buyer('A', '有什么颜色'); await wait(300);
  check(sent.at(-1)?.text.includes('黑色') && last().outcome === 'replied', `AI模式 QA 直接回复（${last().totalMs}ms）`);
  buyer('B', '我想问下'); buyer('B', '这个面料起球吗'); await wait(400);
  check(sent.at(-1)?.text === '模型答：我想问下，这个面料起球吗', '连发两条合并后交给模型');
  buyer('C', '快递到哪了'); await wait(300);
  check(transfers.includes('C') && last().outcome === 'transferred', 'AI模式 物流问题 → 平台转接人工');
  buyer('C', '在吗'); await wait(300);
  check(last().outcome === 'skipped', '已转接的会话 AI 不再插话');
  modelBehavior = 'low'; buyer('D', '能做定制刻字吗'); await wait(300);
  check(transfers.includes('D'), '模型置信度低 → 转接');
  transferOk = false; modelBehavior = 'none'; buyer('E', '你们老板是谁'); await wait(300);
  check(last().outcome === 'todo' && store.get('todos').some(t => t.convId === 'E'), '转接失败 → 记待办');
  transferOk = true;

  // 人工离线接管
  settings = { ...settings, mode: 'ai', effectiveMode: 'takeover' };
  modelBehavior = 'ok';
  buyer('F', '退款怎么还没到'); await wait(300);
  check(!transfers.includes('F') && sent.at(-1).text.includes('售后问题已登记') && last().outcome === 'fallback', '离线接管：售后问题不转接，发售后保底话术 + 待办');
  buyer('G', '多久发货'); await wait(300);
  check(sent.at(-1).text.includes('48小时'), '离线接管：常规问题照常自动回复');
  modelBehavior = 'slow'; const t0 = Date.now(); buyer('H', '这个和上一代有什么区别'); await wait(3500);
  check(last().outcome === 'fallback' && last().totalMs < 3000, `模型超时 → 在时限内发保底话术（${last().totalMs}ms，时限 3000ms）`);

  // 人工模式：影子
  settings = { mode: 'human', engine: settings.engine };
  modelBehavior = 'ok';
  const n = sent.length;
  buyer('K', '有优惠券吗'); await wait(300);
  check(sent.length === n && last().outcome === 'shadow', '人工模式：AI 只出影子草稿不发送');
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'K', text: '亲，现在满199减20哦，领券更划算~' });
  const st = learner.readiness(0.9, 1);
  check(st.length && st[0].total === 1, `影子对比已统计：${JSON.stringify(st)}`);
  buyer('L', '可以开发票吗'); await wait(300);
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'L', text: '可以的亲，下单后在订单页申请电子发票，手机号13812345678联系我们' });
  const cands = learner.candidates;
  check(cands.some(c => c.q.includes('发票') && c.a.includes('[手机号]') && !c.a.includes('13812345678')), '人工回复生成候选QA，并去掉手机号');
  buyer('M', '能开发票不'); await wait(300);
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'M', text: '可以开的，订单页申请就行' });
  check(learner.candidates.filter(c => c.q.includes('发票')).length === 1 && learner.candidates.find(c => c.q.includes('发票')).count === 2, '相似问题自动归并到同一条候选');
  const cand = learner.candidates.find(c => c.q.includes('发票'));
  learner.approve(cand.id, { a: '可以的亲，下单后在订单页申请电子发票即可~' });
  check(qa.match('能开发票吗').score >= 0.72, '候选确认后进入知识库并可被命中');

  // 我们自己发的消息不被当成人工回复
  settings = { mode: 'ai', engine: settings.engine };
  buyer('N', '是正品吗'); await wait(300);
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'N', text: sent.at(-1).text });
  check(!eng.paused.has('s1::N'), 'AI 自己发出的消息不会被误判为人工接管');
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'N', text: '我是人工，补充一下' });
  check(eng.paused.has('s1::N'), 'AI 模式下人工插话 → 该会话自动转为人工接管');

  // ---- 审查后补充的用例 ----
  settings = { mode: 'ai', engine: { mergeWindowMs: 100, hardDeadlineMs: 3000 } };
  // 平台把 AI 的回复换行/空格改掉，仍认得是自己发的
  modelBehavior = 'ok'; buyer('P', '是正品吗'); await wait(300);
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'P', text: sent.at(-1).text.replace('，', '，\n  ') });
  check(!eng.paused.has('s1::P'), '平台改了空格换行，AI 自己的回复仍不会被当成人工');
  // 等模型期间人工插话 → AI 不再发送
  modelBehavior = 'slow2';
  models.ask = (orig => async (a) => modelBehavior === 'slow2' ? (await wait(800), { reply: '模型慢答', action: 'reply', confidence: 0.9, category: '售前', provider: 'fake', ms: 800 }) : orig(a))(models.ask);
  const n2 = sent.length; buyer('Q', '这个面料怎么样'); await wait(300);
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'Q', text: '人工：我来回答' });
  await wait(900);
  check(sent.length === n2 && last().outcome === 'skipped', '等模型期间人工插话 → AI 不再发送');
  // 同一会话串行：前一条还在等模型，后一条不会并发
  const n3 = sent.length; buyer('R', '面料是啥'); await wait(200); buyer('R', '能机洗吗'); await wait(2200);
  const rs = traces.filter(t => t.kind === 'decision' && t.convId === 'R');
  check(rs.length === 2 && rs[1].steps[0].at >= 700 && sent.length === n3 + 2, `同一会话两条消息依次处理、不并发（第二条在第一条完成后才开始）`);
  // 模型慢于时限 → 保底话术，且之后不会再补发模型答案
  models.ask = async () => { await wait(3600); return { reply: '迟到的答案', action: 'reply', confidence: 0.9, category: '售前', provider: 'fake', ms: 3600 }; };
  const n4 = sent.length; buyer('S', '保修多久'); await wait(4200);
  const sTexts = sent.slice(n4).map(x => x.text);
  check(sTexts.length === 1 && !sTexts.includes('迟到的答案') && last().outcome === 'fallback' && last().totalMs < 3400, `模型超过时限：只发一次保底话术，不再补发迟到答案（${last().totalMs}ms）`);
  // 平台欢迎语不算人工
  settings.engine.ignoreSellerPatterns = ['欢迎光临'];
  eng.onSellerMessage({ storeId: 's1', platform: 'mock', convId: 'T', text: '欢迎光临本店～' });
  check(!eng.paused.has('s1::T'), '配置的平台自动欢迎语不算人工插话');

  // 商品库 + 订单信息 + 卡片发送识别
  {
    const { ProductLib } = require('../engine/products');
    const plib = new ProductLib(store);
    plib.upsert({ name: '针织开衫 秋冬款', url: 'https://shop.example.com/item/1001', price: '¥189', kw: ['开衫'] });
    check(plib.match('这件开衫有M码吗')?.item.name === '针织开衫 秋冬款', '商品库：关键词命中商品');
    check(!plib.match('你们发什么快递'), '商品库：无关问题不命中');
    const s2 = [], asks = [];
    const set2 = { mode: 'ai', engine: { mergeWindowMs: 50, hardDeadlineMs: 3000, humanOnly: [] } };
    const eng2 = new ReplyEngine({ qa, learner, store, products: plib, getSettings: () => set2,
      models: { ask: async a => { asks.push(a); return { reply: '有的亲', action: 'reply', confidence: 0.9, category: '售前', provider: 'fake', ms: 1 }; } },
      actions: { send: async (m, t) => s2.push(t), transfer: async () => true,
        getOrders: async () => [{ lines: ['订单号 123', '状态 待发货'] }] } });
    eng2.onBuyerMessage({ storeId: 's2', platform: 'mock', convId: 'P', buyer: 'P', text: '开衫M码还有货吗', receivedAt: Date.now() });
    await wait(300);
    check(s2.length === 2 && s2[1].includes('item/1001'), `回复后自动补发商品链接：${s2.join(' / ')}`);
    check(asks[0]?.orderInfo.includes('待发货') && asks[0]?.product?.name === '针织开衫 秋冬款', '模型作答时带上订单信息和商品信息');
    eng2.onBuyerMessage({ storeId: 's2', platform: 'mock', convId: 'P', buyer: 'P', text: '开衫起球吗', receivedAt: Date.now() });
    await wait(300);
    check(s2.length === 3, '同一会话同一商品链接只发一次');
    set2.engine.autoProductLink = false;
    eng2.onBuyerMessage({ storeId: 's2', platform: 'mock', convId: 'Q', buyer: 'Q', text: '开衫有现货吗', receivedAt: Date.now() });
    await wait(300);
    check(s2.length === 4, '关闭「自动带链接」后不补发');
    eng2.expectOurs('s2::R');
    eng2.onSellerMessage({ storeId: 's2', platform: 'mock', convId: 'R', text: '【订单】123 待发货' });
    check(!eng2.paused.has('s2::R'), '一键发送的订单卡片不被当成人工插话');
    eng2.onSellerMessage({ storeId: 's2', platform: 'mock', convId: 'R', text: '亲我来帮您看下' });
    check(eng2.paused.has('s2::R'), '之后人工真实回复仍会被识别为接管');
  }

  const lat = store.get('latency', []);
  console.log(`\n记录 ${lat.length} 条耗时，最大 ${Math.max(...lat.map(x => x.ms))}ms`);
  store.flushAll();
  console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();
