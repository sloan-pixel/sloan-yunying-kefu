// 知识库导入与匹配的边界情况
const path = require('path'), os = require('os'), fs = require('fs'), Module = require('module');
try { require.resolve('jszip'); } catch { process.env.NODE_PATH = '/opt/npm-tools/node_modules'; Module._initPaths(); }
const { JsonStore } = require('../engine/store'); const { QAKnowledge, readXlsx, readCsv } = require('../engine/qa');
const fails = []; const check = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
const fx = process.argv[2] || path.join(__dirname, 'fixtures');
(async () => {
  const qa = new QAKnowledge(new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'))));
  const rows = await readXlsx(path.join(fx, 'order.xlsx'));
  check(rows[0][0] === '问题', `多工作表时按工作簿顺序取第一个（读到：${rows[0][0]}）`);
  const csv = readCsv(path.join(fx, 'gbk.csv'));
  check(csv[1][0] === '你好' && csv[1][2].includes('哈喽'), `GBK 编码的 CSV 正确读取（读到：${csv[1][0]}）`);
  await qa.importFile(path.join(fx, 'gbk.csv'));
  await qa.importFile(path.join(fx, 'order.xlsx'));
  check(qa.items.length === 3, `「你好」「在吗」两条问候语都保留，没有互相覆盖（共 ${qa.items.length} 条）`);
  check(qa.match('在吗').item?.a === '在的亲' && qa.match('在吗').score >= 0.72, '买家只说「在吗」能命中');
  check(qa.match('你好呀').item?.a === '亲您好~', '「你好呀」命中「你好」');
  check(qa.match('在不在').item?.a === '亲您好~', '相似问法「在不在」命中');
  // ---- 关键词 / 包含问法匹配（不需要模型）----
  const qa2 = new QAKnowledge(new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-'))));
  await qa2.importFile(path.join(__dirname, '../samples/QA知识库模板.xlsx'));
  const should = { '你好，我想问一下这个衣服有几个颜色可以选': '有几个颜色', '黑色有吗': '有几个颜色', '下单了多久能发': '多久发货', '今天拍明天能发吗': '多久发货',
    '什么时候发出': '多久发货', '我身高165体重110穿什么码': '怎么选尺码', '有没有券': '有没有优惠', '能便宜点不': '有没有优惠', '是不是正品啊': '是正品吗' };
  let ok = 0; for (const [q, want] of Object.entries(should)) { const m = qa2.match(q); if (m.item?.q === want && m.score >= 0.72) ok++; else console.log('   未命中：', q, m.score.toFixed(2), m.item?.q); }
  check(ok === Object.keys(should).length, `真实买家说法命中 ${ok}/${Object.keys(should).length}（关键词、包含问法、相似问法）`);
  const shouldNot = ['质量怎么样', '包邮吗', '你们这个会掉色吗', '在吗'];
  const wrong = shouldNot.filter(q => qa2.match(q).score >= 0.72);
  check(!wrong.length, `知识库没有的问题不会乱命中（${wrong.join('、') || '无'}）`);
  check(qa2.match('下单了多久能发').via === '关键词：多久+发', '命中原因可解释：关键词：多久+发');

  // ---- 完全不配模型，整条链路照样自动回复 ----
  const { ModelRouter } = require('../engine/llm'); const { Learner } = require('../engine/learner'); const { ReplyEngine } = require('../engine/router');
  const st2 = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'))); const qa3 = new QAKnowledge(st2);
  await qa3.importFile(path.join(__dirname, '../samples/QA知识库模板.xlsx'));
  const settings = { mode: 'ai', models: [], engine: { mergeWindowMs: 50 } };
  const sent = [], transfers = [];
  const eng = new ReplyEngine({ qa: qa3, models: new ModelRouter(() => settings), learner: new Learner(st2, qa3), store: st2, getSettings: () => settings,
    actions: { send: async (m, t) => sent.push({ c: m.convId, t }), transfer: async m => { transfers.push(m.convId); return true; } } });
  const traces = []; eng.on('trace', t => t.kind === 'decision' && traces.push(t));
  eng.onBuyerMessage({ storeId: 's', convId: 'A', text: '你好，我想问一下这个衣服有几个颜色可以选' });
  eng.onBuyerMessage({ storeId: 's', convId: 'B', text: '这个能刻字吗' });
  await new Promise(r => setTimeout(r, 400));
  check(sent.some(x => x.c === 'A' && x.t.includes('燕麦色')), `不配任何模型：知识库问题照样自动回复（${traces.find(t => t.convId === 'A')?.totalMs}ms）`);
  check(transfers.includes('B'), '不配任何模型：知识库答不了的转人工');
  console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
})();
