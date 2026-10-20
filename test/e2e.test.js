// 全链路：模拟平台页(真实 Chromium) ⇄ 页面适配 ⇄ 应答引擎(Node)，测端到端时效
// 运行：node test/e2e.test.js
const path = require('path'), os = require('os'), fs = require('fs'), Module = require('module');
try { require.resolve('jszip'); } catch { process.env.NODE_PATH = '/opt/npm-tools/node_modules'; Module._initPaths(); }
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const { JsonStore } = require('../engine/store'); const { QAKnowledge } = require('../engine/qa');
const { Learner } = require('../engine/learner'); const { ReplyEngine } = require('../engine/router');
const cfg = require('../adapters/platforms.json').mock.selectors;
const fails = []; const check = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };

(async () => {
  const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kefu-e2e-')));
  const qa = new QAKnowledge(store); await qa.importFile(path.join(__dirname, '../samples/QA知识库模板.xlsx'));
  const learner = new Learner(store, qa);
  // 假模型：模拟 2.5 秒的云端延迟
  const models = { ask: async ({ question }) => { await new Promise(r => setTimeout(r, 2500)); return { reply: '亲，这款面料是纯棉的，不容易起球哦~', action: 'reply', confidence: 0.85, category: '售前', provider: 'fake', ms: 2500 }; } };
  const exe = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
  const browser = await chromium.launch({ executablePath: exe }); const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, '../mock/platform.html'));
  await page.addScriptTag({ path: path.join(__dirname, '../adapters/dom-core.js') });
  let settings = { mode: 'ai', engine: {} };
  const engine = new ReplyEngine({ qa, models, learner, store, getSettings: () => settings, actions: {
    send: (m, text) => page.evaluate(([c, t]) => window.__w.send(c, t), [m.convId, text]),
    transfer: m => page.evaluate(c => window.__w.transfer(c, '小美'), m.convId) } });
  const traces = []; engine.on('trace', t => t.kind === 'decision' && traces.push(t));
  await page.exposeFunction('__emit', ev => { const m = { ...ev, storeId: 's', platform: 'mock' }; ev.type === 'buyer' ? engine.onBuyerMessage(m) : engine.onSellerMessage(m); });
  await page.evaluate(cfg => { window.__w = window.KefuDomCore.createWatcher(document, cfg, e => window.__emit(e)); window.__w.start(); }, cfg);
  const buyer = (c, t) => page.evaluate(([c, t]) => window.__mock.push(c, 'buyer', t), [c, t]);
  const sellerMsgs = c => page.evaluate(c => window.__mock.state.convs[c].filter(m => m.from === 'seller').map(m => m.text), c);
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return Date.now() - t; await new Promise(r => setTimeout(r, 100)); } return -1; };

  let t = Date.now(); await buyer('买家小林', '有几种颜色');
  let d = await until(async () => (await sellerMsgs('买家小林')).some(x => x.includes('燕麦色')));
  check(d >= 0 && d < 20000, `QA 问题：买家发出 → 页面上出现回复 ${(d / 1000).toFixed(1)} 秒`);
  await buyer('买家Tom', '这个面料起球吗');
  d = await until(async () => (await sellerMsgs('买家Tom')).some(x => x.includes('纯棉')));
  check(d >= 0 && d < 20000, `模型问题（模型 2.5 秒）：端到端 ${(d / 1000).toFixed(1)} 秒`);
  await buyer('买家阿珍', '快递到哪了');
  d = await until(() => page.evaluate(() => window.__mock.state.transfers.length > 0));
  check(d >= 0 && d < 20000, `物流问题：转接提示 + 平台转接完成 ${(d / 1000).toFixed(1)} 秒`);
  const tr = await page.evaluate(() => window.__mock.state.transfers[0]);
  check(tr && tr.to === '人工客服-小美', '转接到了指定的人工子账号');
  // 人工在页面里直接打字回复 → AI 停止插话
  await page.fill('#reply-input', '我是人工，我来跟进'); await page.click('#send-btn');
  await new Promise(r => setTimeout(r, 1500));
  check(engine.paused.has('s::买家阿珍'), '人工在页面里回复后，该会话标记为人工接管');
  // 同时多个买家
  settings = { mode: 'ai', engine: {} };
  t = Date.now();
  await buyer('买家小林', '多久发货'); await buyer('买家Tom', '是正品吗');
  d = await until(async () => (await sellerMsgs('买家小林')).some(x => x.includes('48小时')) && (await sellerMsgs('买家Tom')).some(x => x.includes('正品')));
  check(d >= 0 && d < 20000, `两个会话同时进线，都在时限内回复 ${(d / 1000).toFixed(1)} 秒`);
  const wrong = (await sellerMsgs('买家小林')).some(x => x.includes('正品')) || (await sellerMsgs('买家Tom')).some(x => x.includes('48小时'));
  check(!wrong, '回复没有发错会话');
  console.log('\n决策耗时：', traces.map(x => `${x.text}=${x.outcome}/${x.totalMs}ms`).join('  '));
  await browser.close(); store.flushAll();
  console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
})();
