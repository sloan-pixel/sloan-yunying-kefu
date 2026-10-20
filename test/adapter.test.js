// 在真实 Chromium 里跑模拟平台页 + dom-core，验证：收消息、自动切会话、受控输入框发送、转接、不重复回复历史
// 运行：node test/adapter.test.js   （需要 playwright；本机开发用）
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const cfg = require('../adapters/platforms.json').mock.selectors;

(async () => {
  const exe = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, '../mock/platform.html'));
  await page.addScriptTag({ path: path.join(__dirname, '../adapters/dom-core.js') });
  await page.evaluate((cfg) => {
    window.__ev = [];
    window.__known = new Map();
    const w = window.KefuDomCore.createWatcher(document, cfg, e => {
      window.__ev.push({ ...e, at: Date.now() });
      if (e.type === 'buyer') {
        if (e.text.includes('转人工')) w.transfer(e.convId, '小美');
        else w.send(e.convId, '自动回复：' + e.text);
      }
    }, { pollMs: 300, known: window.__known });
    window.__w = w; w.start();
  }, cfg);

  const fails = [];
  const check = (c, msg) => { console.log((c ? '✅ ' : '❌ ') + msg); if (!c) fails.push(msg); };

  // 1) 不在当前会话的买家发消息 → 自动打开会话并回复
  const t0 = Date.now();
  await page.evaluate(() => window.__mock.push('买家小林', 'buyer', '这个有几个颜色'));
  await page.waitForFunction(() => (window.__mock.state.convs['买家小林'] || []).some(m => m.from === 'seller'), null, { timeout: 8000 }).catch(() => {});
  const lin = await page.evaluate(() => window.__mock.state.convs['买家小林']);
  check(lin.some(m => m.from === 'seller' && m.text === '自动回复：这个有几个颜色'), `未读会话自动打开并回复（${Date.now() - t0}ms）`);

  // 2) 另一个会话的新消息
  await page.evaluate(() => window.__mock.push('买家Tom', 'buyer', '多久发货'));
  await page.waitForFunction(() => window.__mock.state.convs['买家Tom'].some(m => m.from === 'seller'), null, { timeout: 8000 }).catch(() => {});
  const tom = await page.evaluate(() => window.__mock.state.convs['买家Tom']);
  check(tom.filter(m => m.from === 'seller').length === 1, '第二个会话回复且只回复一次');

  // 3) 当前打开会话里连续两条相同的话，两条都要识别
  await page.evaluate(() => { window.__mock.push('买家Tom', 'buyer', '在吗'); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.__mock.push('买家Tom', 'buyer', '在吗'); });
  await page.waitForTimeout(1500);
  const tom2 = await page.evaluate(() => window.__mock.state.convs['买家Tom'].filter(m => m.text === '自动回复：在吗').length);
  check(tom2 === 2, `重复的相同问句各识别一次（实际 ${tom2}）`);

  // 4) 有历史的会话：历史不重复回复
  await page.evaluate(() => window.__mock.push('买家阿珍', 'buyer', '新的问题'));
  await page.waitForFunction(() => window.__mock.state.convs['买家阿珍'].some(m => m.text === '自动回复：新的问题'), null, { timeout: 8000 }).catch(() => {});
  const zhen = await page.evaluate(() => window.__mock.state.convs['买家阿珍'].map(m => m.text));
  check(zhen.includes('自动回复：新的问题') && !zhen.includes('自动回复：之前问过的问题'), '历史消息不重复回复，新消息正常回复');

  // 5) 转接
  await page.evaluate(() => window.__mock.push('买家小林', 'buyer', '我要转人工'));
  await page.waitForFunction(() => window.__mock.state.transfers.length > 0, null, { timeout: 8000 }).catch(() => {});
  const tr = await page.evaluate(() => window.__mock.state.transfers);
  check(tr.length === 1 && tr[0].to === '人工客服-小美' && tr[0].conv === '买家小林', '按步骤转接到指定人工子账号');

  // 6) 卖家消息被识别（用于区分人工回复）
  const ev = await page.evaluate(() => window.__ev);
  check(ev.some(e => e.type === 'seller' && e.text.startsWith('自动回复')), '卖家侧消息能被识别');
  check(!ev.some(e => e.type === 'buyer' && e.text === '之前问过的问题'), '历史买家消息没有上报');
  console.log('事件数：', ev.length, '健康检查：', JSON.stringify(await page.evaluate(() => window.__w.health())));

  // 7) 校准：生成的选择器能命中
  const sel = await page.evaluate(() => {
    const el = document.querySelectorAll('.conv-item')[1];
    return { list: window.KefuDomCore.selectorFor(el, document, true), one: window.KefuDomCore.selectorFor(document.querySelector('#send-btn'), document, false), bubble: window.KefuDomCore.selectorFor(document.querySelector('.msg .bubble'), document, true) };
  });
  const counts = await page.evaluate(s => ({ list: document.querySelectorAll(s.list).length, one: document.querySelectorAll(s.one).length, bubble: document.querySelectorAll(s.bubble).length }), sel);
  check(counts.list === 3 && counts.one === 1 && counts.bubble > 1, `校准选择器：${JSON.stringify(sel)} → ${JSON.stringify(counts)}`);

  // 8) 重建监听（配置更新/页面内跳转）后不会重复回复旧消息
  const before = await page.evaluate(() => window.__ev.filter(e => e.type === 'buyer').length);
  await page.evaluate((cfg) => { window.__w.stop(); window.__w2 = window.KefuDomCore.createWatcher(document, cfg, e => window.__ev.push(e), { pollMs: 300, known: window.__known }); window.__w2.start(); }, cfg);
  await page.evaluate(() => { const s = window.__mock.state; window.__mock.push('买家Tom', 'system', '刷新'); });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__ev.filter(e => e.type === 'buyer').length);
  check(after === before, `重建监听后不重复上报旧消息（之前 ${before}，之后 ${after}）`);
  // 9) 虚拟列表：顶部旧消息被裁掉、其余重新渲染 → 不会把旧买家消息当新的
  const b9 = await page.evaluate(() => window.__ev.filter(e => e.type === 'buyer').length);
  await page.evaluate(() => { const st = window.__mock.state; st.current = '买家Tom'; st.convs['买家Tom'].splice(0, 2); window.__mock.push('买家Tom', 'system', '裁剪'); });
  await page.waitForTimeout(1500);
  const a9 = await page.evaluate(() => window.__ev.filter(e => e.type === 'buyer').length);
  check(a9 === b9, `列表顶部被裁掉后不重复上报（之前 ${b9}，之后 ${a9}）`);
  await browser.close();
  console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();
