#!/usr/bin/env node
// 双机同步服务（零依赖）：在线心跳 + 共享知识库 / 候选QA / 待办
// 用法：SYNC_TOKEN=自己设一个密码 PORT=8787 node sync/server.js
// 可以跑在两台电脑中的任意一台（局域网），也可以放到一台云服务器上
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SYNC_TOKEN || '';
const DATA = process.env.SYNC_DATA || path.join(__dirname, 'sync-data.json');
const DOCS = ['qa', 'candidates', 'todos', 'products'];

let db = { seats: {}, docs: { qa: [], candidates: [], todos: [], products: [] } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}
let dirty = false;
setInterval(() => { if (dirty) { fs.writeFileSync(DATA, JSON.stringify(db)); dirty = false; } }, 2000);

// 按 id 合并，保留 updatedAt 更新的一方。
// 服务端给每条被接受的数据盖一个自己的时间戳 srvTs（单调递增），客户端按它增量拉取，
// 这样两台电脑的系统时间不一致也不会漏数据；内容没变的回传不重新盖戳，避免来回同步。
let seq = 0;
const stamp = () => (seq = Math.max(Date.now(), seq + 1));
function merge(serverList, incoming) {
  const map = new Map(serverList.map(x => [x.id, x]));
  for (const it of incoming || []) {
    if (!it || !it.id) continue;
    const cur = map.get(it.id);
    if (!cur || (it.updatedAt || it.ts || 0) > (cur.updatedAt || cur.ts || 0)) map.set(it.id, { ...it, srvTs: stamp() });
    // 来的版本比服务端旧（或对方时钟慢）：给服务端版本重新盖戳，让对方下次拉回最新的，两边保持一致
    else if ((it.updatedAt || it.ts || 0) < (cur.updatedAt || cur.ts || 0)) map.set(it.id, { ...cur, srvTs: stamp() });
  }
  return [...map.values()];
}
for (const name of DOCS) for (const it of db.docs[name] || []) if (it.srvTs) seq = Math.max(seq, it.srvTs);
// 旧版数据没有 srvTs：补上，否则永远不会被拉取
for (const name of DOCS) for (const it of db.docs[name] || []) if (!it.srvTs) { it.srvTs = stamp(); dirty = true; }

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (TOKEN && req.headers['x-sync-token'] !== TOKEN) return send(res, 401, { error: 'token 错误' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
  req.on('end', () => {
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { error: 'bad json' }); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      db.seats[j.seatId] = { ...j, lastSeen: Date.now() }; dirty = true;
      return send(res, 200, { now: Date.now(), seats: db.seats });
    }
    if (url.pathname === '/seats') return send(res, 200, { now: Date.now(), seats: db.seats });
    const m = url.pathname.match(/^\/doc\/(\w+)$/);
    if (m && DOCS.includes(m[1])) {
      const name = m[1];
      if (req.method === 'POST') { db.docs[name] = merge(db.docs[name] || [], j.items); dirty = true; }
      const since = Number(url.searchParams.get('since') || 0);
      const items = (db.docs[name] || []).filter(x => (x.srvTs || 0) > since);
      return send(res, 200, { now: seq, items });
    }
    if (url.pathname === '/') return send(res, 200, { ok: true, service: 'kefu-hub-sync', seats: Object.keys(db.seats).length });
    send(res, 404, { error: 'not found' });
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`[同步服务] 已启动 http://0.0.0.0:${PORT} ${TOKEN ? '(已启用 token)' : '(警告：未设置 SYNC_TOKEN)'}`));
module.exports = { merge, server };
