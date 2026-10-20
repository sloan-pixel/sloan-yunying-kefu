// Sloan云盈客服助手 · 界面
const K = window.kefu;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const PLAT_SHORT = { pinduoduo: '拼', tmall: '天', douyin: '抖', jd: '京', youzan: '有', wechat: '微', mock: '测' };
function toast(t) { const el = $('#toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 2600); }

const st = { settings: null, platforms: {}, status: {}, convs: new Map(), traces: new Map(), health: {}, selStore: null, selConv: null, tab: 'inbox', defaults: {} };

// ---------------- 顶部模式带 ----------------
const MODE_TEXT = { ai: 'AI 正在接待', human: '人工正在接待', takeover: '人工离线 · AI 接管中' };
function renderStatus() {
  const s = st.status; const m = s.effectiveMode || 'ai';
  document.body.className = 'mode-' + m;
  $('#who').textContent = MODE_TEXT[m];
  const role = s.seat?.role === 'human' ? '人工席位' : 'AI 席位';
  const why = {
    ai: '答不了的问题通过平台转接给人工子账号',
    human: 'AI 不发消息，只在后台拟稿并学习人工的回答',
    takeover: s.seat?.role === 'human' ? (s.away ? '你点了「我离开了」' : '电脑长时间无操作') + '，常规问题 AI 回复，其余发保底话术并记待办' : '没有在线的人工席位，不再转接，处理不了的发保底话术并记待办',
  }[m];
  $('#why').textContent = `${role}${s.seat?.name ? '「' + s.seat.name + '」' : ''}：${why}${s.modeOverride !== 'auto' ? '（手动指定）' : ''}`;
  $$('#mode-seg button').forEach(b => b.classList.toggle('on', b.dataset.m === (s.modeOverride || 'auto')));
  const sy = s.sync || {};
  const peers = (sy.peers || []).filter(p => p.ageSec < 60);
  $('#chip-sync').textContent = sy.status === 'ok' ? `同步正常 · 人工${sy.humanOnline ? '在线' : '离线'} · 另 ${peers.length} 台` : sy.status === 'off' ? '同步未开启' : '同步异常';
  $('#chip-sync').classList.toggle('bad', !!sy.status && sy.status.startsWith('error'));
  $('#chip-sync').title = sy.status || '';
  $('#chip-model').textContent = s.modelReady ? '模型已就绪' : '未配置模型 · 仅用知识库';
  $('#chip-model').classList.toggle('bad', !s.modelReady);
  const ab = $('#away-btn'); ab.hidden = s.seat?.role !== 'human'; ab.textContent = s.away ? '我回来了' : '我离开了';
}
$('#mode-seg').onclick = async e => { const m = e.target.dataset.m; if (!m) return; await K.saveSettings({ modeOverride: m }); };
$('#chip-model').onclick = () => { showTab('settings'); requestAnimationFrame(() => $('#s-models').scrollIntoView({ block: 'center' })); };
$('#away-btn').onclick = async () => { st.status = await K.setAway(!st.status.away); renderStatus(); };

// ---------------- 店铺列表 ----------------
function renderStores() {
  $('#stores').innerHTML = st.settings.stores.map(s => {
    const h = st.health[s.id]; const ok = h && h.input && h.msgItem >= 0 && !h.notReady;
    return `<div class="store ${s.id === st.selStore ? 'sel' : ''}" data-id="${s.id}">
      <span class="plat ${s.platform}">${PLAT_SHORT[s.platform] || '?'}</span>
      <span class="nm"><b>${esc(s.name)}</b><small>${esc(st.platforms[s.platform]?.name || s.platform)}${s.humanTarget ? ' · 转 ' + esc(s.humanTarget) : ''}</small></span>
      <span class="dot ${ok ? 'ok' : h ? 'warn' : ''}" title="${ok ? '已连接' : '未登录或未校准'}"></span></div>`;
  }).join('') || '<div class="empty">还没有店铺</div>';
}
$('#stores').onclick = e => { const el = e.target.closest('.store'); if (!el) return; st.selStore = el.dataset.id; renderStores(); showTab('backoffice'); if ($('#calib').classList.contains('on')) renderCalib(true); };
$('#add-store').onclick = () => storeDialog();

function storeDialog(existing) {
  const s = existing || { platform: 'pinduoduo', name: '', brand: '', humanTarget: '', url: '' };
  const opts = Object.entries(st.platforms).filter(([k]) => !k.startsWith('_')).map(([k, p]) => `<option value="${k}" ${k === s.platform ? 'selected' : ''}>${esc(p.name)}${p.kind === 'api' ? '（接口，预留）' : ''}</option>`).join('');
  openDialog(`<h3>${existing ? '店铺设置' : '添加店铺'}</h3>
    <div class="row"><label>平台</label><select name="platform" ${existing ? 'disabled' : ''}>${opts}</select></div>
    <div class="row"><label>店铺名称（自己看的）</label><input name="name" value="${esc(s.name)}" placeholder="例如：拼多多旗舰店-AI"></div>
    <div class="row"><label>品牌（用于匹配品牌专属 QA，可留空）</label><input name="brand" value="${esc(s.brand)}"></div>
    <div class="row"><label>转接给哪个人工子账号（平台转接列表里显示的名字）</label><input name="humanTarget" value="${esc(s.humanTarget)}"></div>
    <div class="row"><label>客服工作台网址（留空用默认）</label><input name="url" value="${esc(s.url || '')}" placeholder="${esc(st.platforms[s.platform]?.url || '')}"></div>
    <div class="row"><label>店铺补充信息（发货地、售后政策等，可留空）</label><textarea name="shopInfo" rows="2">${esc(s.shopInfo || '')}</textarea></div>
    <p class="lead" style="font-size:12px" id="plat-note">${esc(st.platforms[s.platform]?.note || '')}</p>
    <div class="acts">${existing ? '<button class="danger" data-act="remove">删除店铺</button><span class="spacer"></span>' : ''}<button data-act="cancel">取消</button><button class="primary" data-act="ok">${existing ? '保存' : '添加并打开'}</button></div>`,
  async (act, f) => {
    if (act === 'remove') { if (confirm('删除后该店铺的登录状态会保留在本机，但不再接待。确定删除？')) { await K.storeRemove(existing.id); await reload(); st.selStore = null; renderStores(); } return true; }
    if (act !== 'ok') return true;
    if (!f.name.trim()) { toast('请填写店铺名称'); return false; }
    if (existing) await K.storeUpdate({ ...existing, name: f.name, brand: f.brand, humanTarget: f.humanTarget, url: f.url, shopInfo: f.shopInfo });
    else { const n = await K.storeAdd({ platform: f.platform, name: f.name, brand: f.brand, humanTarget: f.humanTarget, url: f.url, shopInfo: f.shopInfo }); st.selStore = n.id; }
    await reload(); renderStores(); if (!existing) showTab('backoffice');
    return true;
  });
  const sel = $('#dlg select[name=platform]');
  sel && (sel.onchange = () => { $('#plat-note').textContent = st.platforms[sel.value]?.note || ''; $('#dlg input[name=url]').placeholder = st.platforms[sel.value]?.url || ''; });
}

// ---------------- 通用弹窗 ----------------
// 店铺网页是嵌在最上层的原生视图，会盖住弹窗；弹窗打开期间先把它收起来，关闭后再放回
function openDialog(html, onAct) {
  const d = $('#dlg');
  d.innerHTML = `<button class="dlg-x quiet" data-act="cancel" aria-label="关闭" title="关闭（Esc）">✕</button>` + html;
  st.dialogOpen = true; K.setViewport({ storeId: null, bounds: null });
  d.onclose = () => { st.dialogOpen = false; if (st.tab === 'backoffice') requestAnimationFrame(syncViewport); };
  d.showModal();
  // 点弹窗外面的灰色区域也能关闭
  d.onmousedown = e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } };
  d.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'cancel') { d.close(); return; }
    const f = Object.fromEntries([...d.querySelectorAll('[name]')].map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
    if (await onAct(act, f)) d.close();
  };
}

// ---------------- 标签页 ----------------
function showTab(t) {
  st.tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + t));
  if (t === 'backoffice') renderBackoffice(); else K.setViewport({ storeId: null, bounds: null });
  ({ qa: renderQA, learn: renderLearn, todos: renderTodos, monitor: renderMonitor, settings: renderSettings }[t] || (() => {}))();
}
$('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t); };

// ---------------- 收件箱 ----------------
function renderConvs() {
  const list = [...st.convs.values()].sort((a, b) => b.last - a.last);
  const storeName = id => st.settings.stores.find(s => s.id === id)?.name || '';
  $('#convs').innerHTML = list.map(c => `<div class="conv ${c.key === st.selConv ? 'sel' : ''}" data-k="${esc(c.key)}">
      <span class="plat ${c.platform}">${PLAT_SHORT[c.platform] || '?'}</span>
      <b>${esc(c.buyer)}</b><span class="t">${c.unread ? `<span class="badge">${c.unread}</span>` : hm(c.last)}</span>
      <span class="pv">${c.paused ? '<span class="tag human">人工</span> ' : ''}${esc(storeName(c.storeId))}：${esc(c.preview || '')}</span></div>`).join('')
    || '<div class="empty">暂时没有会话</div>';
}
$('#convs').onclick = e => { const el = e.target.closest('.conv'); if (!el) return; st.selConv = el.dataset.k; K.readConv(st.selConv); renderConvs(); renderThread(); };

async function renderThread() {
  if (!st.selConv) return;
  // 重画时保留正在输入的草稿和光标
  const oldInput = $('#t-input'); const draft = oldInput && st.draftFor === st.selConv ? oldInput.value : (st.drafts?.[st.selConv] || '');
  const hadFocus = oldInput && document.activeElement === oldInput; const caret = oldInput ? oldInput.selectionStart : 0;
  if (oldInput && st.draftFor) (st.drafts = st.drafts || {})[st.draftFor] = oldInput.value;
  const c = await K.getConv(st.selConv); if (!c) return;
  const sum = st.convs.get(st.selConv) || {};
  const traces = (st.traces.get(st.selConv) || []);
  const storeName = st.settings.stores.find(s => s.id === c.storeId)?.name || '';
  const WHO = { buyer: '买家', ai: 'AI', seller: '人工' };
  // 把决策过程挂在对应买家消息后面
  let html = '';
  for (const m of c.msgs) {
    html += `<div class="m ${m.from}"><span class="who">${WHO[m.from] || ''} ${hm(m.ts)}</span><div class="b">${esc(m.text)}</div></div>`;
    if (m.from === 'buyer') {
      const tr = traces.find(t => t.text && t.text.includes(m.text) && !t._shown);
      if (tr) { tr._shown = true; html += traceHtml(tr); }
    }
  }
  traces.forEach(t => delete t._shown);
  $('#thread').innerHTML = `<header><span class="plat ${c.platform}">${PLAT_SHORT[c.platform] || '?'}</span><b>${esc(c.buyer)}</b><span style="color:var(--muted)">${esc(storeName)}</span>
      <span class="spacer"></span>${sum.paused ? '<span class="tag human">已由人工接管</span><button id="t-release">交回 AI</button>' : '<button id="t-take">我来接管</button>'}</header>
    <div id="msgs">${html}</div>
    <div id="composer"><textarea id="t-input" placeholder="直接在这里回复，会通过店铺页面发出（回复后该会话转为人工接管）"></textarea><button class="primary" id="t-send">发送</button></div>`;
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  const inp = $('#t-input'); inp.value = draft; st.draftFor = st.selConv;
  if (hadFocus) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch {} }
  $('#t-send').onclick = async () => { const v = $('#t-input').value.trim(); if (!v) return; try { await K.manualSend({ key: st.selConv, text: v }); $('#t-input').value = ''; if (st.drafts) delete st.drafts[st.selConv]; } catch (e) { toast('发送失败：' + e.message); } };
  $('#t-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#t-send').click(); } };
  $('#t-take') && ($('#t-take').onclick = () => K.takeOver(st.selConv));
  $('#t-release') && ($('#t-release').onclick = () => K.release(st.selConv));
  $$('#msgs [data-fix]').forEach(a => a.onclick = () => fixDialog(traces.find(t => t.id === a.dataset.fix), c));
}
const OUTCOME = { replied: '已回复', transferred: '已转接人工', fallback: '保底话术 + 待办', todo: '已记待办', shadow: '影子草稿（未发送）', skipped: '人工接管中，未回复', error: '出错', deadline: '超时' };
function traceHtml(t) {
  const steps = (t.steps || []).filter(s => !/^已/.test(s.s)).map(s => {
    let x = s.s; if (s.score != null) x += ` ${s.score}`; if (s.via && s.score >= 0.5) x += `（${s.via}）`; if (s.provider) x += ` · ${s.provider} ${s.ms}ms`; if (s.category) x += ` · ${s.category}`; if (s.err) x += ` · ${s.err.slice(0, 40)}`;
    return `<span class="st">${esc(x)}</span>`;
  }).join('');
  const draft = t.outcome === 'shadow' ? (t.steps.find(s => s.draft)?.draft || '') : '';
  const slow = t.totalMs > 20000;
  return `<div class="trace"><div class="steps">${steps}</div><div>${OUTCOME[t.outcome] || t.outcome} · <span class="ms ${slow ? 'slow' : ''}">${(t.totalMs / 1000).toFixed(1)} 秒</span>
    ${draft ? `<br>AI 草稿：${esc(draft)}` : ''}<a data-fix="${esc(t.id)}">改写成更好的回答</a></div></div>`;
}
function fixDialog(t, c) {
  if (!t) return;
  const aiText = t.steps?.find(s => s.draft)?.draft || c.msgs.find(m => m.from === 'ai' && m.ts >= (t.received || 0))?.text || '';
  openDialog(`<h3>改写回答</h3>
    <div class="row"><label>买家的话</label><input name="q" value="${esc(t.text)}"></div>
    <div class="row"><label>更好的回答（会进入「学习」待确认）</label><textarea name="a" rows="4">${esc(aiText)}</textarea></div>
    <div class="row"><label><input type="checkbox" name="send"> 同时把这句发给买家</label></div>
    <div class="acts"><button data-act="cancel">取消</button><button class="primary" data-act="ok">保存</button></div>`,
  async (act, f) => { if (act === 'ok' && f.a.trim()) { const r = await K.correct({ question: f.q, answer: f.a, storeId: c.storeId, sendKey: f.send ? c.key : null }); toast(r && r.added ? '已加入候选问答，到「学习」里确认' : '知识库里已有相同的问答，没有重复添加'); } return true; });
}

// ---------------- 店铺后台（内嵌网页） ----------------
const CAL_FIELDS = [
  ['convList', '会话列表里的一个会话', true], ['convUnread', '会话上的未读红点/数字', true], ['convName', '会话列表里的买家名字', true],
  ['currentName', '当前聊天窗口顶部的买家名字', false], ['msgItem', '聊天记录里的一条消息（整行）', true], ['msgBuyer', '一条「买家」消息（整行）', true],
  ['msgSeller', '一条「我方」消息（整行）', true], ['msgSystem', '一条系统提示/订单卡片（没有就跳过）', true], ['msgText', '消息里的文字气泡', true], ['input', '回复输入框', false], ['sendBtn', '发送按钮（没有就留空，用回车）', false],
];
function storeObj() { return st.settings.stores.find(s => s.id === st.selStore); }
function renderBackoffice() {
  const s = storeObj();
  $('#bo-name').textContent = s ? s.name : '未选择店铺';
  const h = st.health[st.selStore];
  $('#bo-health').textContent = !s ? '' : !h ? '页面未就绪：请登录，然后点「校准」' : h.notReady ? '还没校准：点「校准」告诉软件消息和输入框在哪' : `已连接 · 当前会话 ${h.currentConv || '无'} · 识别到 ${h.msgItem} 条消息${h.input ? '' : ' · 找不到输入框'}`;
  if (s && st.tab === 'backoffice') requestAnimationFrame(syncViewport);
}
function syncViewport() {
  if (st.dialogOpen || st.tab !== 'backoffice' || st.pageHidden) { K.setViewport({ storeId: null, bounds: null }); return; }
  const r = $('#viewport').getBoundingClientRect();
  K.setViewport({ storeId: st.selStore, bounds: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } });
}
window.addEventListener('resize', () => st.tab === 'backoffice' && syncViewport());
$('#bo-login').onclick = () => { if (!st.selStore) return; showPage(); K.storeReload({ id: st.selStore, login: true }); };
$('#bo-reload').onclick = () => { if (!st.selStore) return; showPage(); K.storeReload({ id: st.selStore, login: false }); };
$('#bo-back').onclick = () => st.selStore && K.storeBack(st.selStore);
// 收起店铺网页：网页还在后台运行（登录状态、消息接收都不受影响），只是不挡住界面
function showPage() { st.pageHidden = false; $('#bo-hide').textContent = '收起网页'; $('#viewport .ph').textContent = '在左侧选择一个店铺'; syncViewport(); }
$('#bo-hide').onclick = () => {
  if (st.pageHidden) return showPage();
  st.pageHidden = true; $('#bo-hide').textContent = '展开网页';
  $('#viewport .ph').textContent = '网页已收起，仍在后台运行。点「展开网页」继续操作。';
  syncViewport();
};
// 全局 Esc：取消正在进行的点选
document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.picking) K.cancelPick(st.selStore); });
$('#bo-edit').onclick = () => storeObj() && storeDialog(storeObj());
$('#bo-calib').onclick = () => { const on = $('#calib').classList.toggle('on'); $('#bo-calib').textContent = on ? '收起校准' : '校准'; renderCalib(true); requestAnimationFrame(syncViewport); };
$('#cal-close').onclick = () => $('#bo-calib').click();
$('#cal-cancel').onclick = () => K.cancelPick(st.selStore);
function renderCalib(withTransfer) {
  const s = storeObj(); if (!s) return;
  const sel = { ...(st.platforms[s.platform]?.selectors || {}), ...(s.selectors || {}) };
  $('#cal-grid').innerHTML = CAL_FIELDS.map(([k, label, list]) => `<div class="cal ${sel[k] ? 'done' : ''}"><span class="lbl">${label}</span><code title="${esc(sel[k] || '')}">${esc(sel[k] || '未设置')}</code><button data-k="${k}" data-list="${list ? 1 : ''}" data-label="${esc(label)}">点选</button></div>`).join('');
  if (withTransfer) $('#cal-transfer').value = JSON.stringify(sel.transferSteps || [], null, 0);
}
$('#cal-grid').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  showPage();
  toast('到下面的页面里点「' + b.dataset.label + '」，按 Esc 或「取消点选」退出');
  st.picking = true; $('#cal-cancel').hidden = false;
  try {
    const r = await K.calibrate({ storeId: st.selStore, field: b.dataset.k, list: !!b.dataset.list, label: b.dataset.label });
    if (r) toast(`已记录：匹配到 ${r.count} 个「${r.sample || '元素'}」`); else toast('已取消点选');
    await reload(); renderCalib();
  } catch (err) { toast(/无响应/.test(err.message) ? '已取消点选' : '校准失败：' + err.message); }
  finally { st.picking = false; $('#cal-cancel').hidden = true; }
};
$('#cal-save-transfer').onclick = async () => {
  let steps; try { steps = JSON.parse($('#cal-transfer').value || '[]'); } catch { return toast('格式不对，请检查 JSON'); }
  const s = storeObj(); await K.storeUpdate({ ...s, selectors: { ...(s.selectors || {}), transferSteps: steps } }); await reload(); toast('转接步骤已保存');
};

// ---------------- 知识库 ----------------
async function renderQA() {
  const items = await K.qaList(); const f = $('#qa-search').value.trim();
  const list = f ? items.filter(x => (x.q + x.a + (x.alts || []).join('') + (x.kw || []).join('')).includes(f)) : items;
  $('#qa-body').innerHTML = list.slice(0, 500).map(x => `<tr><td><b style="font-weight:500">${esc(x.q)}</b>${x.alts?.length ? `<div class="alts">${esc(x.alts.join(' | '))}</div>` : ''}${x.kw?.length ? `<div class="alts">关键词：${esc(x.kw.join(' | '))}</div>` : ''}</td>
    <td class="a">${esc(x.a)}</td><td>${esc(x.category)}</td><td>${esc(x.brand || '通用')}</td><td class="num">${x.hits || 0}</td>
    <td style="white-space:nowrap"><button class="quiet" data-edit="${esc(x.id)}">编辑</button><button class="quiet danger" data-del="${esc(x.id)}">删除</button></td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">知识库是空的。点「导入 Excel」，或从「学习」里确认候选问答。</td></tr>`;
  $('#qa-body').onclick = async e => {
    const id = e.target.dataset.edit || e.target.dataset.del; if (!id) return;
    if (e.target.dataset.del) { if (confirm('删除这条问答？')) { await K.qaRemove(id); renderQA(); } return; }
    qaDialog(items.find(x => x.id === id));
  };
}
function qaDialog(x = {}) {
  openDialog(`<h3>${x.id ? '编辑问答' : '新增问答'}</h3>
    <div class="row"><label>问题</label><input name="q" value="${esc(x.q || '')}"></div>
    <div class="row"><label>相似问法（用 | 分隔）</label><input name="alts" value="${esc((x.alts || []).join(' | '))}"></div>
    <div class="row"><label>关键词（买家的话里出现就命中，用 | 分隔；+ 表示都要出现，如：多久+发 | 发货）</label><input name="kw" value="${esc((x.kw || []).join(' | '))}"></div>
    <div class="row"><label>答案</label><textarea name="a" rows="4">${esc(x.a || '')}</textarea></div>
    <div class="row"><label>分类</label><input name="category" value="${esc(x.category || '')}" placeholder="售前 / 物流 / 售后…"></div>
    <div class="row"><label>品牌（留空 = 通用）</label><input name="brand" value="${esc(x.brand || '')}"></div>
    <div class="acts"><button data-act="cancel">取消</button><button class="primary" data-act="ok">保存</button></div>`,
  async (act, f) => {
    if (act !== 'ok') return true;
    if (!f.q.trim() || !f.a.trim()) { toast('问题和答案都要填'); return false; }
    await K.qaUpsert({ ...x, q: f.q.trim(), a: f.a.trim(), alts: f.alts.split(/[|｜]/).map(s => s.trim()).filter(Boolean), kw: f.kw.split(/[|｜,，]/).map(s => s.trim()).filter(Boolean), category: f.category.trim(), brand: f.brand.trim() });
    renderQA(); return true;
  });
}
$('#qa-add').onclick = () => qaDialog();
$('#qa-search').oninput = () => renderQA();
$('#qa-import').onclick = async () => { try { const r = await K.qaImport({ replace: false }); if (r) { toast(`导入 ${r.imported} 条，知识库共 ${r.total} 条`); renderQA(); } } catch (e) { toast('导入失败：' + e.message); } };
$('#qa-export').onclick = async () => { const p = await K.qaExport(); if (p) toast('已导出'); };
$('#qa-try-btn').onclick = async () => {
  const v = $('#qa-try').value.trim(); if (!v) return;
  const r = await K.qaTest({ text: v }); const th = st.settings.engine?.qaDirectThreshold ?? st.defaults.qaDirectThreshold;
  $('#qa-try-out').innerHTML = r.item && r.score > 0 ? `匹配度 <b class="num">${r.score.toFixed(2)}</b>：${esc(r.item.q)}（${esc(r.via || '')}）→ ${r.score >= th ? '<b>直接回复</b>' : '不够确定，交给模型参考作答（没配模型则转人工）'}` : '没有相近的问答：交给模型，没配模型则转人工';
};
$('#qa-try').onkeydown = e => e.key === 'Enter' && $('#qa-try-btn').click();

// ---------------- 学习 ----------------
async function renderLearn() {
  const s = await K.learnState();
  $('#ready-body').innerHTML = s.readiness.map(r => `<tr><td>${esc(r.category)}</td><td class="num">${r.total}</td><td class="num">${r.agree}</td>
    <td><div style="display:flex;align-items:center;gap:8px"><div class="bar"><i style="width:${Math.round(r.rate * 100)}%"></i></div><span class="num">${Math.round(r.rate * 100)}%</span></div></td>
    <td>${r.ready ? '<span class="tag ai">可以交给 AI 托管</span>' : r.total < 20 ? '<span style="color:var(--muted)">样本不足 20 条</span>' : '<span style="color:var(--muted)">继续学习</span>'}</td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">切到「人工」模式接待一段时间后，这里会出现统计。</td></tr>';
  $('#cand-body').innerHTML = s.candidates.map(c => `<tr data-id="${esc(c.id)}"><td>${esc(c.q)}${c.alts.length ? `<div class="alts">${esc(c.alts.join(' | '))}</div>` : ''}${c.fromCorrection ? '<div class="tag human" style="display:inline-block;margin-top:4px">人工改写</div>' : ''}</td>
    <td class="a"><textarea rows="2" style="width:100%">${esc(c.a)}</textarea>${c.answers.length > 1 ? `<div class="alts">其他答法：${esc(c.answers.filter(a => a !== c.a).join(' / '))}</div>` : ''}${c.oneOff ? '<div class="warn">像是针对某个订单的一次性答复（含单号、补偿或“已为您…”），确认前请改成通用说法</div>' : ''}</td>
    <td class="num">${c.count}</td><td style="white-space:nowrap"><button class="primary" data-ok>加入知识库</button> <button class="quiet" data-no>忽略</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">暂时没有候选。人工接待时的回答会自动整理到这里。</td></tr>';
}
$('#cand-body').onclick = async e => {
  const tr = e.target.closest('tr'); if (!tr?.dataset.id) return;
  if (e.target.hasAttribute('data-ok')) { await K.candApprove({ id: tr.dataset.id, edits: { a: tr.querySelector('textarea').value.trim() } }); toast('已加入知识库'); renderLearn(); }
  if (e.target.hasAttribute('data-no')) { await K.candReject(tr.dataset.id); renderLearn(); }
};

// ---------------- 待办 ----------------
async function renderTodos() {
  const all = await K.todos(); const show = $('#todo-showdone').checked;
  const open = all.filter(t => !t.done); updateTodoCount(open.length);
  const storeName = id => st.settings.stores.find(s => s.id === id)?.name || id;
  $('#todo-body').innerHTML = (show ? all : open).map(t => `<tr style="${t.done ? 'opacity:.5' : ''}"><td class="num">${new Date(t.ts).toLocaleString()}</td><td>${esc(storeName(t.storeId))}</td><td>${esc(t.buyer)}</td><td>${esc(t.text)}</td><td>${esc(t.category)} · ${esc(t.reason || '')}</td>
    <td>${t.done ? '已处理' : `<button data-done="${esc(t.id)}">标记已处理</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">没有待办</td></tr>';
}
function updateTodoCount(n) { const c = $('#todo-count'); c.hidden = !n; c.textContent = n; }
$('#todo-body').onclick = async e => { const id = e.target.dataset.done; if (id) { await K.todoDone(id); renderTodos(); } };
$('#todo-showdone').onchange = renderTodos;

// ---------------- 时效监控 ----------------
const recent = [];
async function renderMonitor() {
  const range = Number($('#mon-range').value); const since = Date.now() - range;
  const l = (await K.latency()).filter(x => x.ts >= since); const ms = l.map(x => x.ms).sort((a, b) => a - b);
  const pct = p => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : 0;
  const within = ms.length ? ms.filter(x => x <= 20000).length / ms.length : 1;
  const over30 = ms.filter(x => x > 30000).length;
  const by = o => l.filter(x => x.outcome === o).length;
  $('#mon-stats').innerHTML = [
    ['处理消息', ms.length, ''], ['20 秒内完成', Math.round(within * 100) + '%', within >= 0.98 ? 'good' : 'bad'], ['超过 30 秒', over30, over30 ? 'bad' : 'good'],
    ['中位耗时', (pct(0.5) / 1000).toFixed(1) + ' 秒', ''], ['90% 在', (pct(0.9) / 1000).toFixed(1) + ' 秒内', pct(0.9) > 20000 ? 'bad' : ''], ['最慢', (pct(1) / 1000).toFixed(1) + ' 秒', ''],
    ['AI 直接回复', by('replied'), ''], ['转接人工', by('transferred'), ''], ['保底 / 待办', by('fallback') + by('todo'), ''],
  ].map(([k, v, c]) => `<div class="stat ${c}"><b>${v}</b><span>${k}</span></div>`).join('');
  $('#mon-body').innerHTML = recent.slice(0, 80).map(t => `<tr><td class="num">${hm(t.at)}</td><td>${esc(t.buyer)}</td><td>${esc(t.text)}</td><td>${OUTCOME[t.outcome] || t.outcome}</td>
    <td class="num" style="${t.totalMs > 20000 ? 'color:var(--danger)' : ''}">${(t.totalMs / 1000).toFixed(1)}s</td><td style="font-size:12px;color:var(--muted)">${esc((t.steps || []).map(s => s.s).join(' → '))}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">还没有记录</td></tr>';
}
$('#mon-range').onchange = renderMonitor;

// ---------------- 设置 ----------------
function renderSettings() {
  const s = st.settings, e = { ...st.defaults, ...(s.engine || {}) };
  $('#s-seat-name').value = s.seat.name; $('#s-seat-role').value = s.seat.role; $('#s-auto-takeover').checked = !!s.autoTakeover; $('#s-idle').value = s.idleMinutes;
  $('#s-shopinfo').value = s.shopInfo || '';
  $('#s-sync-url').value = s.sync.url || ''; $('#s-sync-token').value = s.sync.token || ''; $('#s-sync-off').value = s.sync.offlineAfterSec || 30;
  $('#s-qa-th').value = e.qaDirectThreshold; $('#s-model-th').value = e.modelMinConfidence; $('#s-deadline').value = e.hardDeadlineMs; $('#s-handoff').value = e.handoffMsg; $('#s-holding-ms').value = e.holdingAfterMs; $('#s-ignore').value = (e.ignoreSellerPatterns || []).join('，');
  renderModels();
  const groups = e.humanOnly || st.defaults.humanOnly;
  $('#s-humanonly').innerHTML = groups.map(g => `<div class="form" style="margin-bottom:8px" data-cat="${esc(g.category)}">
      <label>${esc(g.category)} 关键词</label><input data-k="words" value="${esc(g.words.join('，'))}">
      <label>${esc(g.category)} 保底话术</label><input data-k="fallback" value="${esc((e.fallback || {})[g.category] || st.defaults.fallback[g.category] || '')}"></div>`).join('')
    + `<div class="form"><label>其他问题保底话术</label><input id="s-fb-default" value="${esc((e.fallback || {})['默认'] || st.defaults.fallback['默认'])}"></div>`;
}
// 模型列表：任意平台、任意顺序，第一个失败自动换下一个
function renderModels() {
  const P = st.presets || {};
  const opts = cur => Object.entries(P).map(([k, p]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  const ms = st.settings.models;
  $('#s-models').innerHTML = (ms.length ? ms.map((m, i) => { const p = P[m.preset] || {}; return `<div class="model-card ${m.enabled ? 'on' : ''}" data-i="${i}">
      <div class="mrow">
        <label class="en"><input type="checkbox" data-f="enabled" ${m.enabled ? 'checked' : ''}> 启用</label>
        <select data-f="preset">${opts(m.preset)}</select>
        <input data-f="apiKey" type="password" placeholder="${p.needsKey === false ? 'API Key（本地模型不用填）' : 'API Key'}" value="${esc(m.apiKey || '')}">
        <input data-f="model" list="ml-${i}" placeholder="型号名，如 ${esc(p.model || 'qwen-plus')}" value="${esc(m.model || '')}"><datalist id="ml-${i}"></datalist>
      </div>
      <div class="mrow">
        <input data-f="baseUrl" placeholder="接口地址（留空用默认：${esc(p.baseUrl || '必须填写')}）" value="${esc(m.baseUrl || '')}">
        <span class="mbtns">${p.keyUrl ? `<button class="quiet" data-key="${i}">获取 Key</button>` : ''}<button data-list="${i}">获取型号</button><button data-test="${i}">测试</button>
        <button class="quiet" data-up="${i}" title="上移（优先使用）" ${i ? '' : 'disabled'}>↑</button><button class="quiet" data-down="${i}" title="下移" ${i < ms.length - 1 ? '' : 'disabled'}>↓</button><button class="quiet danger" data-del="${i}" title="删除">删除</button></span>
      </div><div class="mres" id="mres-${i}"></div></div>`; }).join('') : '<p class="lead">还没有模型。</p>')
    + `<button id="s-add-model">添加模型</button>`;
  $('#s-add-model').onclick = () => { collectModels().push({ id: 'm' + Date.now(), preset: 'qwen', apiKey: '', model: (P.qwen || {}).model || '', baseUrl: '', enabled: true }); renderModels(); };
  $('#s-models').onchange = e => {
    if (e.target.dataset.f === 'preset') { const i = Number(e.target.closest('.model-card').dataset.i); collectModels(); const m = st.settings.models[i]; m.model = (P[m.preset] || {}).model || ''; m.baseUrl = ''; renderModels(); }
  };
  $('#s-models').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset, list = collectModels();
    if (d.key) return K.openExternal((P[list[+d.key].preset] || {}).keyUrl);
    if (d.up) { const i = +d.up; [list[i - 1], list[i]] = [list[i], list[i - 1]]; return renderModels(); }
    if (d.down) { const i = +d.down; [list[i + 1], list[i]] = [list[i], list[i + 1]]; return renderModels(); }
    if (d.del) { list.splice(+d.del, 1); return renderModels(); }
    const i = +(d.test ?? d.list), label = b.textContent, card = list[i];
    // 等待期间界面可能已重画，结果写到当时那张卡片上（按 id 找）
    const show = (cls, text) => { const el = document.querySelector(`.model-card[data-i="${st.settings.models.indexOf(card) >= 0 ? st.settings.models.indexOf(card) : -1}"] .mres`); if (el) { el.className = 'mres ' + cls; el.textContent = text; } };
    b.disabled = true; b.textContent = d.test ? '测试中…' : '查询中…'; show('', '');
    try {
      if (d.test) {
        const r = await K.modelTest(card);
        show(r.formatOk ? 'ok' : 'warn', r.formatOk ? `连接成功，${(r.ms / 1000).toFixed(1)} 秒。试答：${r.reply || '（判断为转人工）'}` : `能连上，但回答格式不对（${(r.ms / 1000).toFixed(1)} 秒），换一个型号试试`);
      } else {
        const names = await K.modelList(card);
        const k = st.settings.models.indexOf(card), dl = document.getElementById('ml-' + k);
        if (dl) dl.innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
        show('ok', names.length ? `可用型号 ${names.length} 个，点「型号名」输入框即可选择：${names.slice(0, 12).join('、')}${names.length > 12 ? '…' : ''}` : '接口没有返回型号列表，请按平台文档手动填写');
      }
    } catch (err) { show('bad', '失败：' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 160)); }
    if (b.isConnected) { b.disabled = false; b.textContent = label; }
  };
}
function collectModels() {
  const rows = $$('#s-models .model-card');
  if (!rows.length) return st.settings.models;
  st.settings.models = rows.map(row => {
    const m = { ...st.settings.models[Number(row.dataset.i)] };
    row.querySelectorAll('[data-f]').forEach(el => { m[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    return m;
  });
  return st.settings.models;
}
// 数字输入：空、非数字或超出范围时用默认值，避免把阈值存成 0
function num(sel, lo, hi, dflt) { const raw = $(sel).value.trim(); const v = Number(raw); return raw === '' || !Number.isFinite(v) || v < lo || v > hi ? dflt : v; }
$('#s-save').onclick = async () => {
  const humanOnly = $$('#s-humanonly [data-cat]').map(el => ({ category: el.dataset.cat, words: el.querySelector('[data-k=words]').value.split(/[,，、\s]+/).filter(Boolean) }));
  const fallback = Object.fromEntries($$('#s-humanonly [data-cat]').map(el => [el.dataset.cat, el.querySelector('[data-k=fallback]').value]));
  fallback['默认'] = $('#s-fb-default').value;
  const patch = {
    seat: { ...st.settings.seat, name: $('#s-seat-name').value.trim(), role: $('#s-seat-role').value },
    autoTakeover: $('#s-auto-takeover').checked, idleMinutes: Number($('#s-idle').value) || 5, shopInfo: $('#s-shopinfo').value,
    models: collectModels(),
    sync: { url: $('#s-sync-url').value.trim(), token: $('#s-sync-token').value, offlineAfterSec: Number($('#s-sync-off').value) || 30 },
    engine: { ...(st.settings.engine || {}), qaDirectThreshold: num('#s-qa-th', 0.3, 1, st.defaults.qaDirectThreshold), modelMinConfidence: num('#s-model-th', 0, 1, st.defaults.modelMinConfidence),
      hardDeadlineMs: num('#s-deadline', 5000, 28000, st.defaults.hardDeadlineMs), handoffMsg: $('#s-handoff').value.trim() || st.defaults.handoffMsg,
      holdingAfterMs: num('#s-holding-ms', 0, 20000, 0), humanOnly, fallback,
      ignoreSellerPatterns: $('#s-ignore').value.split(/[,，、\n]+/).map(x => x.trim()).filter(Boolean) },
  };
  await K.saveSettings(patch); await reload(); toast('设置已保存');
};

// ---------------- 实时事件 ----------------
K.on('status', s => { st.status = s; renderStatus(); });
K.on('convsReset', list => { st.convs = new Map(list.map(c => [c.key, c])); if (st.selConv && !st.convs.has(st.selConv)) { st.selConv = null; $('#thread').innerHTML = '<div class="empty">请选择会话</div>'; } renderConvs(); });
K.on('toast', t => toast(t));
K.on('conv', c => { st.convs.set(c.key, c); renderConvs(); if (c.key === st.selConv) renderThread(); });
K.on('trace', t => {
  if (t.kind !== 'decision') return;
  const k = `${t.storeId}::${t.convId}`; const arr = st.traces.get(k) || []; arr.push(t); st.traces.set(k, arr.slice(-50));
  recent.unshift({ ...t, at: Date.now() }); recent.length = Math.min(recent.length, 200);
  if (k === st.selConv) renderThread(); if (st.tab === 'monitor') renderMonitor();
});
K.on('todo', () => { K.todos().then(t => updateTodoCount(t.filter(x => !x.done).length)); if (st.tab === 'todos') renderTodos(); });
K.on('health', ({ storeId, health }) => { st.health[storeId] = health; renderStores(); if (storeId === st.selStore && st.tab === 'backoffice') renderBackoffice(); });
K.on('docs', name => { if (name === 'qa' && st.tab === 'qa') renderQA(); if (name === 'todos' && st.tab === 'todos') renderTodos(); if (name === 'candidates' && st.tab === 'learn') renderLearn(); });

async function reload() {
  const s = await K.getState();
  st.settings = s.settings; st.platforms = s.platforms; st.presets = s.presets; st.status = s.status; st.defaults = s.defaults; st.health = { ...st.health, ...s.health };
  for (const c of s.convs) st.convs.set(c.key, c);
}
(async () => {
  await reload(); renderStatus(); renderStores(); renderConvs();
  if (!st.selStore && st.settings.stores[0]) st.selStore = st.settings.stores[0].id;
  renderStores();
  K.todos().then(t => updateTodoCount(t.filter(x => !x.done).length));
})();
