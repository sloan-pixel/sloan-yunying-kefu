// 商品库：商品名、链接、价格、介绍、关键词。用于收件箱一键发送商品链接，以及买家问到商品时自动带上链接
// 匹配不需要模型：关键词命中，或买家的话里包含商品名
const path = require('path');
const { readXlsx, readCsv, normalize, splitKw } = require('./qa');

const HEAD = {
  name: ['商品名', '商品名称', '名称', '商品', 'name'],
  url: ['链接', '商品链接', 'url', 'link'],
  price: ['价格', '售价', 'price'],
  desc: ['介绍', '说明', '卖点', '描述', 'desc'],
  kw: ['关键词', '关键字', 'keywords'],
  brand: ['品牌', '店铺', 'brand'],
};

class ProductLib {
  constructor(store) { this.store = store; }
  get all() { return this.store.get('products', []); }
  get items() { return this.all.filter(x => !x.deleted); }
  save(items) {
    const keep = new Set(items.map(x => x.id)); const now = Date.now();
    const gone = this.all.filter(x => !keep.has(x.id)).map(x => x.deleted ? x : { ...x, deleted: true, updatedAt: now });
    this.store.set('products', [...items, ...gone]);
  }
  upsert(p) {
    const items = this.items.slice();
    const item = { name: '', url: '', price: '', desc: '', kw: [], brand: '', ...p, id: p.id || `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, updatedAt: Date.now() };
    const i = items.findIndex(x => x.id === item.id);
    if (i >= 0) items[i] = { ...items[i], ...item }; else items.push(item);
    this.save(items); return item;
  }
  remove(id) { this.save(this.items.filter(x => x.id !== id)); }
  async importFile(file) {
    const rows = path.extname(file).toLowerCase() === '.csv' ? readCsv(file) : await readXlsx(file);
    if (!rows.length) return { imported: 0, total: this.items.length };
    const head = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {}; for (const [k, names] of Object.entries(HEAD)) idx[k] = head.findIndex(h => names.includes(h));
    if (idx.name < 0) throw new Error('第一行需要有「商品名」这一列');
    const items = this.items.slice(); let n = 0;
    for (const r of rows.slice(1)) {
      const name = String(r[idx.name] || '').trim(); if (!name) continue;
      const get = k => (idx[k] >= 0 ? String(r[idx[k]] || '').trim() : '');
      const rec = { name, url: get('url'), price: get('price'), desc: get('desc'), kw: splitKw(get('kw')), brand: get('brand') };
      const old = items.find(x => x.name === name && x.brand === rec.brand);
      if (old) Object.assign(old, rec, { updatedAt: Date.now() });
      else items.push({ ...rec, id: `p-${Date.now()}-${n}`, updatedAt: Date.now() });
      n++;
    }
    this.save(items); return { imported: n, total: items.length };
  }
  // 买家的话 → 最相关的商品（关键词或商品名命中），没有就返回 null
  match(text, brand = '') {
    const raw = String(text || '').toLowerCase();
    const nt = normalize(text);
    let best = null;
    for (const p of this.items) {
      if (p.brand && brand && p.brand !== brand) continue;
      let score = 0;
      for (const g of p.kw || []) {
        const parts = g.toLowerCase().split('+').map(x => x.trim()).filter(Boolean);
        if (parts.length && parts.every(x => raw.includes(x))) score = Math.max(score, 0.88 + 0.01 * parts.join('').length);
      }
      const nn = normalize(p.name);
      if (nn.length >= 2 && nt.includes(nn)) score = Math.max(score, 0.95);
      if (score && (!best || score > best.score)) best = { item: p, score };
    }
    return best;
  }
  search(q) {
    const s = String(q || '').trim().toLowerCase();
    return s ? this.items.filter(p => (p.name + p.desc + (p.kw || []).join('')).toLowerCase().includes(s)) : this.items;
  }
  static linkText(p) { return [p.name, p.price, p.url].filter(Boolean).join(' '); }
}

module.exports = { ProductLib };
