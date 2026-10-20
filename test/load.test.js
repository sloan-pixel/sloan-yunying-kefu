// 压测：按每分钟 60 条的速度，在 3 个会话里连续进线 40 条（其中一半需要模型，模型延迟 2~4 秒）
const path = require('path'), os = require('os'), fs = require('fs'), Module = require('module');
try { require.resolve('jszip'); } catch { process.env.NODE_PATH = '/opt/npm-tools/node_modules'; Module._initPaths(); }
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const { JsonStore } = require('../engine/store'); const { QAKnowledge } = require('../engine/qa');
const { Learner } = require('../engine/learner'); const { ReplyEngine } = require('../engine/router');
const cfg = require('../adapters/platforms.json').mock.selectors;
(async () => {
  const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kefu-load-')));
  const qa = new QAKnowledge(store); await qa.importFile(path.join(__dirname, '../samples/QA知识库模板.xlsx'));
  const models = { ask: async ({ question }) => { await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000)); return { reply: '模型答：' + question.slice(-6), action: 'reply', confidence: 0.8, category: '售前', provider: 'fake', ms: 3000 }; } };
  const exe = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
  const browser = await chromium.launch({ executablePath: exe }); const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, '../mock/platform.html'));
  await page.addScriptTag({ path: path.join(__dirname, '../adapters/dom-core.js') });
  const engine = new ReplyEngine({ qa, models, learner: new Learner(store, qa), store, getSettings: () => ({ mode: 'ai', engine: {} }), actions: {
    send: (m, text) => page.evaluate(([c, t]) => window.__w.send(c, t), [m.convId, text]), transfer: m => page.evaluate(c => window.__w.transfer(c, '小美'), m.convId) } });
  const traces = []; engine.on('trace', t => t.kind === 'decision' && traces.push(t));
  await page.exposeFunction('__emit', ev => { const m = { ...ev, storeId: 's', platform: 'mock' }; ev.type === 'buyer' ? engine.onBuyerMessage(m) : engine.onSellerMessage(m); });
  await page.evaluate(cfg => { window.__w = window.KefuDomCore.createWatcher(document, cfg, e => window.__emit(e)); window.__w.start(); }, cfg);
  const convs = ['买家小林', '买家阿珍', '买家Tom']; const qs = ['有几种颜色', '这款适合送人吗{n}', '多久发货', '面料是什么{n}', '是正品吗', '有赠品吗{n}', '有优惠吗', '能放洗衣机吗{n}'];
  const sent = [];
  for (let i = 0; i < 40; i++) {
    const c = convs[i % 3], q = qs[i % qs.length].replace('{n}', i);
    sent.push({ c, q, at: Date.now() });
    await page.evaluate(([c, q]) => window.__mock.push(c, 'buyer', q), [c, q]);
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 15000));
  const ms = traces.map(t => t.totalMs).sort((a, b) => a - b);
  const p = x => ms[Math.min(ms.length - 1, Math.floor(ms.length * x))];
  console.log(`进线 40 条，产生决策 ${traces.length} 条（同一买家 1.2 秒内连发会被合并）`);
  console.log(`结果：${JSON.stringify(traces.reduce((o, t) => (o[t.outcome] = (o[t.outcome] || 0) + 1, o), {}))}`);
  console.log(`耗时 中位 ${(p(0.5) / 1000).toFixed(1)}s，90% ${(p(0.9) / 1000).toFixed(1)}s，最慢 ${(p(1) / 1000).toFixed(1)}s，超过 20 秒 ${ms.filter(x => x > 20000).length} 条`);
  const mock = await page.evaluate(() => window.__mock.state.convs);
  const unanswered = convs.map(c => { const m = mock[c]; return m.length && m[m.length - 1].from === 'buyer' ? c : null; }).filter(Boolean);
  console.log('最后一条仍是买家消息（漏回）的会话：', unanswered.length ? unanswered : '无');
  await browser.close(); process.exit(0);
})();
