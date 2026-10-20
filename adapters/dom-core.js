// 页面内适配核心：在商家客服网页里监听新消息、切换会话、填写并发送回复、执行转接
// 全部在页面内部完成（不移动真实鼠标、不抢焦点），选择器由 platforms.json 或“校准”提供
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KefuDomCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const textOf = el => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  // 按行取文字（订单卡片、商品卡片用）：去掉空行和按钮文字
  // 卡片里的文字拆成一行行，去掉按钮上的字
  const linesOf = (el, skip) => {
    if (!el) return [];
    const sk = (skip || []).filter(Boolean);
    // 优先按文字节点拆（标签和值通常是两个节点，方便显示成「订单号：xxx」），节点太碎时再按显示的行拆
    let lines = [];
    {
      const w = el.ownerDocument.createTreeWalker(el, 4);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentElement; if (p && (p.closest('button,script,style') && el.contains(p.closest('button,script,style')))) continue;
        const t = n.nodeValue.trim(); if (t) lines.push(t);
      }
      if (lines.length > 40 || lines.some(x => x.length === 1 && /[¥￥$:：]/.test(x))) lines = String(el.innerText || el.textContent || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    }
    return lines.map(x => sk.reduce((a, b) => (a === b ? '' : a.endsWith(b) ? a.slice(0, -b.length).trim() : a), x)).filter(Boolean);
  };

  function q(doc, sel, base) { if (!sel) return null; try { return (base || doc).querySelector(sel); } catch { return null; } }
  function qa(doc, sel, base) { if (!sel) return []; try { return [...(base || doc).querySelectorAll(sel)]; } catch { return []; } }
  function matchesOrHas(el, sel) { if (!sel) return false; try { return el.matches(sel) || !!el.querySelector(sel); } catch { return false; } }

  function createWatcher(doc, cfg, emit, opts = {}) {
    const win = doc.defaultView;
    const seen = new WeakSet();
    const known = opts.known || new Map();   // convId -> 已处理过的消息签名集合（防止重复；可跨重建保留）
    let currentConv = null, busy = false, autoOpen = opts.autoOpen !== false, timer = null, observer = null;
    const log = (...a) => opts.debug && console.log('[kefu]', ...a);

    function convIdNow() {
      const n = textOf(q(doc, cfg.currentName));
      return n || null;
    }
    function msgNodes() { return qa(doc, cfg.msgItem); }
    function roleOf(el) {
      if (cfg.msgSystem && matchesOrHas(el, cfg.msgSystem)) return 'system';
      if (cfg.msgBuyer && matchesOrHas(el, cfg.msgBuyer)) return 'buyer';
      if (cfg.msgSeller && matchesOrHas(el, cfg.msgSeller)) return 'seller';
      if (cfg.msgBuyer && !cfg.msgSeller) return 'seller';
      if (cfg.msgSeller && !cfg.msgBuyer) return 'buyer';
      return 'unknown';
    }
    function msgText(el) { return textOf(cfg.msgText ? (q(doc, cfg.msgText, el) || el) : el); }

    // 扫描当前打开的会话
    let convChangedAt = 0, pendingConv = null;
    function scanCurrent(firstOpen) {
      const conv = convIdNow();
      if (!conv) return;
      // 会话切换后等页面渲染稳定再扫描，防止把上一个会话的消息算到新会话头上
      if (conv !== currentConv) {
        if (pendingConv !== conv) { pendingConv = conv; convChangedAt = Date.now(); return; }
        if (Date.now() - convChangedAt < (opts.settleMs || 500)) return;
        currentConv = conv; pendingConv = null; firstOpen = true;
      }
      const nodes = msgNodes();
      // 签名 = 角色 + 文字 + 上一条的文字（列表顶部被裁掉、旧消息加载进来都不影响），再按出现次数区分完全相同的
      const occ = new Map();
      const texts = nodes.map(n => msgText(n));
      const sigs = nodes.map((n, i) => { const base = roleOf(n) + '|' + texts[i] + '|' + (i ? texts[i - 1] : ''); const c = (occ.get(base) || 0) + 1; occ.set(base, c); return sigBase(n) || base + '#' + c; });
      let set = known.get(conv);
      const isFirst = !set;
      if (!set) { set = new Set(); known.set(conv, set); }
      // 首次打开某会话：最后一条卖家消息之前的历史全部视为已读，只处理之后的买家消息
      let startIdx = 0;
      if (isFirst) {
        let lastSeller = -1;
        nodes.forEach((n, i) => { if (roleOf(n) === 'seller') lastSeller = i; });
        startIdx = (firstOpen && opts.answerUnreadOnOpen !== false) ? lastSeller + 1 : nodes.length;
        nodes.slice(0, startIdx).forEach((n, i) => { seen.add(n); set.add(sigs[i]); });
      }
      // 已知的最后一条消息之前的都是历史（列表滚动/裁剪时会重新渲染），只处理它之后的新消息
      let lastKnown = -1;
      if (!isFirst) sigs.forEach((sg, i) => { if (set.has(sg)) lastKnown = i; });
      nodes.forEach((n, i) => {
        if (seen.has(n)) return;
        if (i <= lastKnown) { seen.add(n); set.add(sigs[i]); return; }
        seen.add(n);
        const s = sigs[i];
        if (set.has(s) && !isFirst) return;
        set.add(s);
        const role = roleOf(n); const text = texts[i];
        if (!text || role === 'system' || role === 'unknown') return;
        emit({ type: role === 'buyer' ? 'buyer' : 'seller', convId: conv, buyer: conv, text, receivedAt: Date.now() });
      });
    }
    function sigBase(n) {
      const idAttr = n.getAttribute && (n.getAttribute(cfg.msgIdAttr || 'data-id') || n.getAttribute('data-msgid') || n.getAttribute('data-msg-id'));
      return idAttr ? 'id:' + idAttr : null;
    }

    // 有未读的会话 → 页面内点击打开
    // 当前会话还没扫描稳定前不要切走，否则刚打开的未读消息会漏掉
    async function waitSettled() {
      for (let i = 0; i < 30; i++) { scanCurrent(false); if (!pendingConv) return; await sleep(100); }
    }
    function openUnread() {
      if (!autoOpen || busy || pendingConv) return false;
      for (const item of qa(doc, cfg.convList)) {
        if (!q(doc, cfg.convUnread, item)) continue;
        const name = textOf(q(doc, cfg.convName, item)) || textOf(item);
        if (currentConv && name && name.includes(currentConv)) continue;
        log('open unread', name);
        (q(doc, cfg.convClick, item) || item).click();
        return true;
      }
      return false;
    }

    async function openConv(convId) {
      await waitSettled();
      if (convIdNow() === convId) return true;
      for (const item of qa(doc, cfg.convList)) {
        const name = textOf(q(doc, cfg.convName, item)) || textOf(item);
        if (name.includes(convId)) {
          (q(doc, cfg.convClick, item) || item).click();
          for (let i = 0; i < 20; i++) { await sleep(100); if (convIdNow() === convId) { scanCurrent(false); return true; } }
        }
      }
      return false;
    }

    // 填入文本（execCommand 走浏览器原生输入事件，React/Vue 受控输入框也能识别）
    function fillInput(el, text) {
      el.focus();
      const isCE = el.isContentEditable;
      if (isCE) { const r = doc.createRange(); r.selectNodeContents(el); const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); }
      else if (el.select) el.select();
      let ok = false;
      try { ok = doc.execCommand('insertText', false, text); } catch {}
      const val = isCE ? textOf(el) : el.value;
      if (!ok || !val || !val.includes(text.slice(0, 5))) {
        if (isCE) el.textContent = text;
        else {
          const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        }
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    }
    function pressEnter(el) {
      for (const type of ['keydown', 'keypress', 'keyup'])
        el.dispatchEvent(new win.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }

    // 同一个页面里的发送/转接必须排队，否则并发切会话会串
    let chain = Promise.resolve();
    function enqueue(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

    function send(convId, text) { return enqueue(() => doSend(convId, text)); }
    function transfer(convId, target) { return enqueue(() => doTransfer(convId, target)); }

    async function doSend(convId, text) {
      busy = true;
      try {
        if (convId && !(await openConv(convId))) throw new Error('找不到会话：' + convId);
        const input = q(doc, cfg.input);
        if (!input) throw new Error('找不到输入框（请校准 input）');
        fillInput(input, text);
        await sleep(80);
        const btn = q(doc, cfg.sendBtn);
        if (btn) btn.click(); else { if (opts.onNeedEnter) await opts.onNeedEnter(); else pressEnter(input); }
        await sleep(150);
        scanCurrent(false);
        return true;
      } finally { busy = false; }
    }

    // 转接：按 cfg.transferSteps 依次执行；{target} 替换为人工子账号名称
    async function doTransfer(convId, target) {
      busy = true;
      try {
        if (convId && !(await openConv(convId))) throw new Error('找不到会话：' + convId);
        const steps = cfg.transferSteps || [];
        if (!steps.length) throw new Error('未配置转接步骤（请校准 transferSteps）');
        for (const st of steps) {
          const t = st.text ? st.text.replace('{target}', target || '') : '';
          let el = null;
          for (let i = 0; i < 30 && !el; i++) {
            if (st.clickText) el = qa(doc, st.clickText).find(e => textOf(e).includes(t));
            else el = q(doc, st.click || st.type);
            if (!el) await sleep(100);
          }
          if (!el) throw new Error('转接步骤找不到元素：' + JSON.stringify(st));
          if (st.type) fillInput(el, t); else el.click();
          await sleep(st.wait || 250);
        }
        return true;
      } finally { busy = false; }
    }

    // ---------- 订单栏 / 商品栏 ----------
    // 卡片 = 一条订单或一个商品；发送按钮 = 卡片里平台自带的「发送」按钮
    function cards(itemSel, sendSel) {
      return qa(doc, itemSel).map((card, idx) => {
        const btn = q(doc, sendSel, card);
        return { idx, lines: linesOf(card, btn ? [textOf(btn)] : []), canSend: !!btn };
      });
    }
    function readCards(kind, convId) { return kind === 'orders' && convId ? enqueue(() => doReadCards(kind, convId)) : doReadCards(kind); }
    async function doReadCards(kind, convId) {
      if (kind === 'orders' && convId) { if (!(await openConv(convId))) throw new Error('找不到会话：' + convId); await sleep(300); }
      if (kind === 'orders') { if (!cfg.orderItem) throw new Error('还没校准「订单卡片」'); return cards(cfg.orderItem, cfg.orderSend); }
      if (!cfg.goodsItem) throw new Error('还没校准「商品卡片」');
      return cards(cfg.goodsItem, cfg.goodsSend);
    }
    function clickCard(kind, convId, idx, matchText) {
      return enqueue(async () => {
        busy = true;
        try {
          if (convId && !(await openConv(convId))) throw new Error('找不到会话：' + convId);
          await sleep(200);
          const itemSel = kind === 'orders' ? cfg.orderItem : cfg.goodsItem, sendSel = kind === 'orders' ? cfg.orderSend : cfg.goodsSend;
          if (!itemSel || !sendSel) throw new Error(kind === 'orders' ? '还没校准订单卡片或发送按钮' : '还没校准商品卡片或发送按钮');
          const list = qa(doc, itemSel);
          // 优先按文字找（卡片顺序可能变），找不到再按序号
          const card = (matchText && list.find(c => textOf(c).includes(matchText))) || list[idx];
          if (!card) throw new Error('页面上找不到这张卡片，可能已刷新，请点「刷新」');
          const btn = q(doc, sendSel, card);
          if (!btn) throw new Error('这张卡片上没有发送按钮');
          btn.click();
          await sleep(300);
          scanCurrent(false);
          return true;
        } finally { busy = false; }
      });
    }

    function tick() { try { scanCurrent(false); if (!busy) openUnread(); } catch (e) { log(e); } }
    function start() {
      stop();
      observer = new win.MutationObserver(() => { clearTimeout(observer._t); observer._t = setTimeout(tick, 60); });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      timer = setInterval(tick, opts.pollMs || 700);
      tick();
    }
    function stop() { observer && observer.disconnect(); clearInterval(timer); }
    function health() {
      return { input: !!q(doc, cfg.input), convList: qa(doc, cfg.convList).length, msgItem: msgNodes().length, currentConv: convIdNow(), sendBtn: !!q(doc, cfg.sendBtn),
        orders: cfg.orderItem ? qa(doc, cfg.orderItem).length : null, goods: cfg.goodsItem ? qa(doc, cfg.goodsItem).length : null };
    }
    return { start, stop, send, transfer, health, scanCurrent, setAutoOpen: v => { autoOpen = v; }, openConv, readCards, clickCard };
  }

  // ---------- 校准：鼠标悬停高亮，点击生成选择器 ----------
  function cssEscape(s) { return String(s).replace(/([^\w-])/g, '\\$1'); }
  function stableClasses(el) {
    // 过滤掉明显是哈希/状态的 class
    return [...el.classList].filter(c => !/^(active|hover|selected|focus|cur|current|on|is-|has-)/i.test(c) && !/[A-Za-z0-9]{6,}_[A-Za-z0-9]{4,}|^[a-z]{1,3}-?[a-f0-9]{5,}$|\d{3,}/.test(c)).slice(0, 3);
  }
  function part(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return '#' + cssEscape(el.id);
    const da = [...el.attributes].find(a => /^data-(testid|test|role|type|e2e)/.test(a.name));
    if (da) return `${el.tagName.toLowerCase()}[${da.name}="${String(da.value).replace(/["\\]/g, '\\$&')}"]`;
    const cls = stableClasses(el);
    return el.tagName.toLowerCase() + cls.map(c => '.' + cssEscape(c)).join('');
  }
  // list=true：生成能匹配同类兄弟元素的选择器；false：尽量唯一
  function selectorFor(el, doc, list) {
    const parts = []; let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++, cur = cur.parentElement) {
      parts.unshift(part(cur));
      const sel = parts.join(' > ');
      const n = qa(doc, sel).length;
      if (parts[0].startsWith('#') && (!list || n >= 1)) return sel;
      if (!list && n === 1) return sel;
      if (list && n >= 2 && depth >= 1) return sel;
    }
    let sel = parts.join(' > ');
    if (!list && qa(doc, sel).length > 1) {
      const idx = [...el.parentElement.children].indexOf(el) + 1;
      sel += `:nth-child(${idx})`;
    }
    return sel;
  }
  function startPicker(doc, { list = false, onPick, onCancel, label = '' } = {}) {
    const box = doc.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff5a1f;background:rgba(255,90,31,.12);border-radius:3px;transition:all .05s';
    const tip = doc.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;font:13px/1.4 sans-serif;padding:8px 14px;border-radius:6px;pointer-events:none';
    tip.textContent = `校准：请点击「${label}」${list ? '（任意一个即可，会自动匹配同类）' : ''}　框太小按 ↑ 扩大，↓ 缩小，Esc 取消`;
    doc.body.append(box, tip);
    let target = null, hovered = null, up = 0;
    const win = doc.defaultView;
    // ↑ 键：框往外扩一层（选中父元素），↓ 键：缩回
    const lift = el => { let t = el; for (let i = 0; i < up && t.parentElement && t.parentElement !== doc.body; i++) t = t.parentElement; return t; };
    const draw = () => { if (!hovered) return; target = lift(hovered); const r = target.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
    const move = e => { if (e.target !== hovered) { hovered = e.target; up = 0; } draw(); };
    // 点选期间把点击完全拦下（在 window 捕获阶段，最早一层），平台页面收不到这次点击：
    // 点「发送订单」等按钮做校准时，不会真的发出去
    const block = e => { e.preventDefault(); e.stopImmediatePropagation(); };
    const click = e => { block(e); cleanup(); target = target || lift(e.target); const sel = selectorFor(target, doc, list); onPick && onPick({ selector: sel, count: qa(doc, sel).length, sample: textOf(target).slice(0, 40) }); };
    const key = e => {
      if (e.key === 'Escape') { block(e); cleanup(); onCancel && onCancel(); }
      else if (e.key === 'ArrowUp') { block(e); up++; draw(); }
      else if (e.key === 'ArrowDown') { block(e); up = Math.max(0, up - 1); draw(); }
    };
    const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];
    function cleanup() {
      win.removeEventListener('mousemove', move, true); win.removeEventListener('click', click, true); win.removeEventListener('keydown', key, true);
      // 稍后再放开按下/抬起事件，防止抬起事件晚到触发平台的点击
      setTimeout(() => BLOCKED.forEach(t => win.removeEventListener(t, block, true)), 50);
      box.remove(); tip.remove();
    }
    win.addEventListener('mousemove', move, true); win.addEventListener('click', click, true); win.addEventListener('keydown', key, true);
    BLOCKED.forEach(t => win.addEventListener(t, block, true));
    return cleanup;
  }

  // 校准检查：每个选择器在当前页面上找到几个
  function countSelectors(doc, selectors) {
    const out = {}, samples = {}; let total = 0;
    for (const [k, v] of Object.entries(selectors || {})) {
      if (typeof v !== 'string' || !v) continue;
      const els = qa(doc, v); out[k] = els.length; total += els.length;
      if (els.length) samples[k] = textOf(els[0]).slice(0, 40) || (els[0].tagName === 'TEXTAREA' || els[0].tagName === 'INPUT' ? '（输入框）' : '（无文字）');
    }
    return { counts: out, samples, total };
  }
  return { createWatcher, startPicker, selectorFor, countSelectors };
});
