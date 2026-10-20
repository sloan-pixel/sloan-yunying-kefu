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
  console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
})();
