// 简单 JSON 持久化：不依赖原生模块，Windows / macOS 都能直接跑
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = {};
    this.timers = {};
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  get(name, fallback) {
    if (name in this.cache) return this.cache[name];
    try { this.cache[name] = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch { this.cache[name] = fallback === undefined ? null : JSON.parse(JSON.stringify(fallback)); }
    return this.cache[name];
  }
  set(name, value) {
    this.cache[name] = value;
    clearTimeout(this.timers[name]);
    // 合并写盘，避免高频消息时频繁 IO
    this.timers[name] = setTimeout(() => this.flush(name), 300);
    return value;
  }
  flush(name) {
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache[name], null, 2));
    fs.renameSync(tmp, this.file(name));
  }
  flushAll() { for (const n of Object.keys(this.cache)) { clearTimeout(this.timers[n]); this.flush(n); } }
}

module.exports = { JsonStore };
