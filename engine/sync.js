// 同步客户端：每 5 秒心跳，每 10 秒同步知识库/候选QA/待办
// 判断“人工离线”：人工席位心跳超过 offlineAfterSec 没来，或人工席位自己报告“离开”
const { EventEmitter } = require('events');

class SyncClient extends EventEmitter {
  constructor({ store, getSettings, seatInfo }) {
    super();
    this.store = store; this.getSettings = getSettings; this.seatInfo = seatInfo;
    this.seats = {}; this.lastPull = {}; this.status = 'off'; this.serverNow = Date.now();
  }
  conf() { return this.getSettings().sync || {}; }
  async req(method, p, body) {
    const c = this.conf();
    const res = await fetch(c.url.replace(/\/$/, '') + p, {
      method, headers: { 'content-type': 'application/json', 'x-sync-token': c.token || '' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`同步服务 ${res.status}`);
    return res.json();
  }
  start() {
    this.stop();
    if (!this.conf().url) { this.status = 'off'; this.emit('status', this.snapshot()); return; }
    this.hb = setInterval(() => this.heartbeat(), 5000);
    this.pl = setInterval(() => this.syncDocs(), 10000);
    this.heartbeat(); this.syncDocs();
  }
  stop() { clearInterval(this.hb); clearInterval(this.pl); }
  async heartbeat() {
    try {
      const r = await this.req('POST', '/heartbeat', this.seatInfo());
      this.seats = r.seats; this.serverNow = r.now; this.status = 'ok';
    } catch (e) { this.status = 'error: ' + e.message; }
    this.emit('status', this.snapshot());
  }
  // 是否有在线的人工席位
  humanOnline() {
    const off = (this.conf().offlineAfterSec || 30) * 1000;
    const me = this.seatInfo().seatId;
    return Object.values(this.seats).some(s => s.seatId !== me && s.role === 'human' && s.operatorPresent && this.serverNow - s.lastSeen < off);
  }
  snapshot() {
    const me = this.seatInfo().seatId;
    return { status: this.status, humanOnline: this.humanOnline(),
      peers: Object.values(this.seats).filter(s => s.seatId !== me).map(s => ({ seatId: s.seatId, name: s.name, role: s.role, mode: s.mode, operatorPresent: s.operatorPresent, ageSec: Math.round((this.serverNow - s.lastSeen) / 1000) })) };
  }
  async syncDocs() {
    if (!this.conf().url || this.syncing) return;
    this.syncing = true;   // 上一轮没结束不开始下一轮
    try {
      for (const name of ['qa', 'candidates', 'todos', 'products']) {
        try {
          const t0 = Date.now();   // 在取数据之前记时间：请求期间的新改动下一轮还会推
          const local = this.store.get(name, []);
          const since = this.lastPull[name] || 0;
          const pushedAt = (this.lastPush || {})[name] || 0;
          const changed = local.filter(x => (x.updatedAt || x.ts || 0) > pushedAt);
          const r = await this.req('POST', `/doc/${name}?since=${since}`, { items: changed });
          this.lastPush = { ...(this.lastPush || {}), [name]: t0 };
          if (r.items.length) {
            const map = new Map(this.store.get(name, []).map(x => [x.id, x]));
            let touched = false;
            for (const it of r.items) {
              const cur = map.get(it.id);
              if (!cur || (it.updatedAt || it.ts || 0) > (cur.updatedAt || cur.ts || 0)) { map.set(it.id, it); touched = true; }
            }
            if (touched) { this.store.set(name, [...map.values()]); this.emit('docs', name); }
          }
          this.lastPull[name] = Math.max(since, r.now || 0);
        } catch (e) { this.status = 'error: ' + e.message; }
      }
    } finally { this.syncing = false; }
  }
}
module.exports = { SyncClient };
