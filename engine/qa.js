// QA 知识库：Excel/CSV 导入 + 中文问法相似度匹配（不依赖向量库，毫秒级）
const fs = require('fs');
const path = require('path');

const PUNCT = /[\s,，。.!！?？、;；:：~～"'“”‘’()（）【】\[\]{}<>《》…\-—_·@#$%^&*+=|\\/]+/g;
const FILLER = /(亲|您好|你好|在吗|在不在|请问|麻烦|一下|呢|呀|啊|吧|哦|嗯|哈|的|了|吗)/g;

const SYN = [[/(可不可以|能不能|能否|可否|可以|是否能)/g, '能'], [/(有没有|有无)/g, '有'], [/(是不是|是否)/g, '是'], [/(多长时间|多少天|几天)/g, '多久'], [/(怎么样|咋样|如何)/g, '怎样'], [/(咋|怎么)/g, '怎'], [/(宝贝|东西|商品|产品)/g, '这个']];
function normalize(s) {
  let t = String(s || '').toLowerCase().replace(PUNCT, '');
  for (const [re, rep] of SYN) t = t.replace(re, rep);
  const core = t.replace(FILLER, '').replace(/[不没么嘛]$/, '');
  // 「在吗」「你好」这类全是语气词的问法，去掉后为空：保留原文，否则永远匹配不上
  return core || t;
}
function grams(s) {
  const out = new Set();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
// 0~1：二元组 Dice 系数 + 包含关系加分
function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = grams(na), gb = grams(nb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  let score = (2 * inter) / (ga.size + gb.size);
  if (na.includes(nb) || nb.includes(na)) score = Math.max(score, 0.75 * Math.min(na.length, nb.length) / Math.max(na.length, nb.length) + 0.25);
  return Math.min(1, score);
}

// ---------- 读取 Excel（.xlsx 是 zip，自己解析首个工作表，免装 xlsx 库） ----------
async function readXlsx(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const shared = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) {
    const xml = await ss.async('string');
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]);
      shared.push(unescapeXml(parts.join('')));
    }
  }
  // 按工作簿里的顺序取第一个工作表（不是按文件名排序）
  let sheetName = null;
  try {
    const wb = await zip.file('xl/workbook.xml').async('string');
    const rid = (wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const target = rid && ((rels.match(new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*>')) || [])[0] || '').match(/Target="([^"]+)"/);
    if (target) sheetName = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
  } catch {}
  if (!sheetName || !zip.file(sheetName)) sheetName = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))[0];
  if (!sheetName) throw new Error('Excel 里没有找到工作表');
  const xml = await zip.file(sheetName).async('string');
  const rows = [];
  for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const row = [];
    for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1];
      const col = ref ? colIndex(ref) : row.length;
      const t = (c.match(/ t="(\w+)"/) || [])[1];
      let v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (t === 's') v = shared[Number(v)];
      else if (t === 'inlineStr') v = unescapeXml([...c.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
      else if (v !== undefined) v = unescapeXml(v);
      row[col] = v === undefined ? '' : String(v);
    }
    rows.push(row);
  }
  return rows;
}
function colIndex(ref) { let n = 0; for (const ch of ref) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function unescapeXml(s) { return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

function readCsv(file) {
  const buf = fs.readFileSync(file);
  let text = buf.toString('utf8');
  // 中文版 Excel 另存的 CSV 多是 GBK 编码
  if (text.includes('\ufffd')) { try { text = new TextDecoder('gbk').decode(buf); } catch {} }
  text = text.replace(/^\ufeff/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 表头识别：问题 / 答案 / 相似问法 / 分类 / 品牌(或店铺)
const HEAD = {
  q: ['问题', '标准问题', '问法', 'question', 'q'],
  a: ['答案', '回复', '标准答案', '话术', 'answer', 'a'],
  alt: ['相似问法', '相似问题', '扩展问法', '同义问法'],
  cat: ['分类', '类别', '场景', 'category'],
  brand: ['品牌', '店铺', '适用店铺', 'brand'],
};
function rowsToQA(rows, source) {
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h || '').trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(HEAD)) idx[k] = head.findIndex(h => names.includes(h));
  if (idx.q < 0 || idx.a < 0) { idx.q = 0; idx.a = 1; }
  const body = (idx.q === 0 && idx.a === 1 && !HEAD.q.includes(head[0])) ? rows : rows.slice(1);
  return body.filter(r => r[idx.q] && r[idx.a]).map((r, i) => ({
    id: `${source}-${Date.now()}-${i}`,
    q: String(r[idx.q]).trim(),
    a: String(r[idx.a]).trim(),
    alts: idx.alt >= 0 && r[idx.alt] ? String(r[idx.alt]).split(/[|｜\n;；]/).map(s => s.trim()).filter(Boolean) : [],
    category: idx.cat >= 0 ? String(r[idx.cat] || '').trim() : '',
    brand: idx.brand >= 0 ? String(r[idx.brand] || '').trim() : '',
    source,
    hits: 0,
  }));
}

class QAKnowledge {
  constructor(store) { this.store = store; }
  get all() { return this.store.get('qa', []); }
  get items() { return this.all.filter(x => !x.deleted); }
  save(items) {
    // 未出现在新列表里的旧条目标记删除（墓碑），便于双机同步
    const keep = new Set(items.map(x => x.id)); const now = Date.now();
    const gone = this.all.filter(x => !keep.has(x.id)).map(x => x.deleted ? x : { ...x, deleted: true, updatedAt: now });
    this.store.set('qa', [...items.map(x => x.updatedAt ? x : { ...x, updatedAt: now }), ...gone]);
  }

  async importFile(file, { replace = false, brand = '' } = {}) {
    const ext = path.extname(file).toLowerCase();
    const rows = ext === '.csv' ? readCsv(file) : await readXlsx(file);
    const list = rowsToQA(rows, path.basename(file));
    if (brand) list.forEach(x => { if (!x.brand) x.brand = brand; });
    const items = replace ? list : mergeQA(this.items, list);
    this.save(items);
    return { imported: list.length, total: items.length };
  }
  upsert(item) {
    const items = this.items.slice();
    const i = items.findIndex(x => x.id === item.id);
    item = { ...item, id: item.id || `manual-${Date.now()}`, updatedAt: Date.now() };
    if (i >= 0) items[i] = { ...items[i], ...item }; else items.push({ hits: 0, alts: [], category: '', brand: '', ...item });
    this.save(items);
    return item;
  }
  remove(id) { this.save(this.items.filter(x => x.id !== id)); }

  // 返回最优匹配：{ item, score }；brand 为空的条目对所有品牌通用
  match(question, brand = '') {
    let best = null;
    for (const it of this.items) {
      if (it.brand && brand && it.brand !== brand) continue;
      let s = similarity(question, it.q);
      for (const alt of it.alts || []) s = Math.max(s, similarity(question, alt));
      if (!best || s > best.score) best = { item: it, score: s };
    }
    return best || { item: null, score: 0 };
  }
  // 前 k 条作为模型参考资料
  topK(question, brand = '', k = 5) {
    return this.items
      .filter(it => !(it.brand && brand && it.brand !== brand))
      .map(it => ({ item: it, score: Math.max(similarity(question, it.q), ...(it.alts || []).map(a => similarity(question, a))) }))
      .sort((a, b) => b.score - a.score).slice(0, k).filter(x => x.score > 0.1);
  }
  recordHit(id) {
    const all = this.all; const it = all.find(x => x.id === id);
    if (it) { it.hits = (it.hits || 0) + 1; this.store.set('qa', all); }
  }
}

function mergeQA(oldItems, newItems) {
  const map = new Map(oldItems.map(x => [normalize(x.q) + '|' + x.brand, x]));
  for (const n of newItems) {
    const key = normalize(n.q) + '|' + n.brand;
    const old = map.get(key);
    map.set(key, old ? { ...old, a: n.a, alts: [...new Set([...(old.alts || []), ...n.alts])], category: n.category || old.category, updatedAt: Date.now() } : n);
  }
  return [...map.values()];
}

module.exports = { QAKnowledge, similarity, normalize, readXlsx, readCsv, rowsToQA };
