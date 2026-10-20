// 双机同步：心跳/人工在线判断、知识库合并、删除同步
const path = require('path'), os = require('os'), fs = require('fs');
process.env.PORT = '18787'; process.env.SYNC_TOKEN = 't0k'; process.env.SYNC_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'd.json');
const { server } = require('../sync/server');
const { JsonStore } = require('../engine/store'); const { QAKnowledge } = require('../engine/qa'); const { SyncClient } = require('../engine/sync');
const fails = []; const check = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
const mk = (role, present) => { const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-'))); const s = { sync: { url: 'http://127.0.0.1:18787', token: 't0k', offlineAfterSec: 2 } };
  const info = { seatId: role, name: role, role, operatorPresent: present };
  return { store, qa: new QAKnowledge(store), info, c: new SyncClient({ store, getSettings: () => s, seatInfo: () => info }) }; };
(async () => {
  const ai = mk('ai', true), hu = mk('human', true);
  await hu.c.heartbeat(); await ai.c.heartbeat();
  check(ai.c.status === 'ok' && ai.c.humanOnline(), 'AI 席位看到人工在线');
  hu.info.operatorPresent = false; await hu.c.heartbeat(); await ai.c.heartbeat();
  check(!ai.c.humanOnline(), '人工点「我离开了」→ AI 席位判定人工离线');
  hu.info.operatorPresent = true; await hu.c.heartbeat(); await new Promise(r => setTimeout(r, 2300)); await ai.c.heartbeat();
  check(!ai.c.humanOnline(), '人工席位心跳中断超过时限 → 判定离线');
  hu.qa.upsert({ q: '能开发票吗', a: '可以的', id: 'x1' }); await new Promise(r => setTimeout(r, 400));
  await hu.c.syncDocs(); await ai.c.syncDocs();
  check(ai.qa.items.some(x => x.id === 'x1'), '人工机新增的问答同步到 AI 机');
  await new Promise(r => setTimeout(r, 20)); hu.qa.remove('x1'); await new Promise(r => setTimeout(r, 400));
  await hu.c.syncDocs(); await ai.c.syncDocs();
  check(!ai.qa.items.some(x => x.id === 'x1'), '删除也会同步');
  // 人工机的系统时间慢了 1 小时：它新加的问答仍要同步过去
  await ai.c.syncDocs();
  const items = hu.store.get('qa', []); items.push({ id: 'skew1', q: '慢时钟', a: '答', alts: [], updatedAt: Date.now() - 3600e3 }); hu.store.set('qa', items);
  hu.c.lastPush = { qa: 0 };
  await hu.c.syncDocs(); await ai.c.syncDocs();
  check(ai.qa.items.some(x => x.id === 'skew1'), '两台电脑时间不一致也不会漏同步');
  // 来回同步不会无限循环
  const before = ai.store.get('qa').length; let fired = 0; ai.c.on('docs', () => fired++);
  await ai.c.syncDocs(); await hu.c.syncDocs(); await ai.c.syncDocs();
  check(fired === 0 && ai.store.get('qa').length === before, '没有新改动时不会反复拉取刷新');
  // 冲突：AI 机写了一条，时钟慢的人工机随后改它被服务端判为旧版本 → 人工机应拉回服务端版本，两边一致
  const now = Date.now();
  let it = ai.store.get('qa', []); it.push({ id: 'cf1', q: '冲突', a: 'AI版', alts: [], updatedAt: now }); ai.store.set('qa', it);
  await ai.c.syncDocs(); await hu.c.syncDocs();
  it = hu.store.get('qa', []); const x = it.find(y => y.id === 'cf1'); x.a = '人工慢时钟版'; x.updatedAt = now - 3600e3 + 5; hu.store.set('qa', it);
  hu.c.lastPush = { ...hu.c.lastPush, qa: 0 };
  await hu.c.syncDocs(); await hu.c.syncDocs();
  check(hu.store.get('qa').find(y => y.id === 'cf1').a === ai.store.get('qa').find(y => y.id === 'cf1').a, '时钟不一致产生冲突后两台电脑最终一致');
  const bad = new SyncClient({ store: ai.store, getSettings: () => ({ sync: { url: 'http://127.0.0.1:18787', token: 'wrong' } }), seatInfo: () => ai.info });
  await bad.heartbeat(); check(bad.status.startsWith('error'), '密码错误被拒绝');
  server.close(); console.log(fails.length ? `\n失败 ${fails.length} 项` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
})();
