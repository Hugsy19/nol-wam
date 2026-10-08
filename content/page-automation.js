// MAIN world：调用当前页面已挂载的 React 选座回调，不硬编码 webpack 模块号。
(() => {
  const TAG = 'nol-scout-page';
  const VERSION = '0.8.9';
  let busy = false, cancelled = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const context = () => JSON.parse(sessionStorage.getItem('interpark/context') || '{}');
  function controller() {
    const nodes = document.querySelectorAll('aside, [class*="SeatInfo"], [class*="SeatMap_seatGroup"]');
    for (const node of nodes) {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
      let current = node[key], root = current;
      while (root?.return) root = root.return;
      // DOM 的 fiber 指针可能仍指向上一次 render；跟随 React root.current 选择当前分支。
      if (root?.stateNode?.current && root.stateNode.current !== root && current?.alternate) current = current.alternate;
      for (let fiber = current, depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
        const p = fiber.memoizedProps;
        if (typeof p?.seatSelectHandler === 'function' && Array.isArray(p.seatSelected) && typeof p.onComplete === 'function') return p;
        if (typeof p?.seatSelectHandler === 'function' && Array.isArray(p.selectedSeat) && typeof p.validateAndSubmit === 'function') return { ...p, seatSelected: p.selectedSeat, onComplete: p.validateAndSubmit };
      }
    }
    throw new Error('未找到页面原生选座处理器，请保持在手动选座界面');
  }
  function check(payload) {
    if (cancelled) throw new Error('自动锁票已取消，请检查已预选座位');
    const c = context();
    if (c.sessionId !== payload.session || c.goods?.goodsCode !== payload.goodsCode || c.goods?.placeCode !== payload.placeCode || c.playSeq?.playSeq !== payload.playSeq) throw new Error('页面会话或场次已改变');
    if (c.goods?.isInterlocking) throw new Error('外部联动座位暂不支持自动锁票');
    if (!sessionStorage.getItem('interpark/captchaVerify')) throw new Error('页面验证码尚未通过');
    if (new URL(location.href).searchParams.get('step') && new URL(location.href).searchParams.get('step') !== 'seat') throw new Error('页面已离开手动选座步骤');
    return c;
  }
  function matchingSeats(c, ids) {
    const actual = (c.seats || []).map(s => s.seatInfoId).sort();
    return actual.length === ids.length && actual.every((id, i) => id === [...ids].sort()[i]);
  }
  function atStep(step) {
    return new URL(location.href).searchParams.get('step') === step || new URL(location.href).pathname === '/onestop/' + step;
  }
  function assertSelection(payload, ids) {
    if (cancelled) throw new Error('自动操作已取消，请检查页面');
    const c = context();
    if (c.sessionId !== payload.session || c.goods?.goodsCode !== payload.goodsCode || c.goods?.placeCode !== payload.placeCode || c.playSeq?.playSeq !== payload.playSeq || !matchingSeats(c, ids)) throw new Error('票价步骤会话、场次或座位已改变');
    return c;
  }
  function rowPrice(node) {
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
    let current = node[key], root = current;
    while (root?.return) root = root.return;
    if (root?.stateNode?.current && root.stateNode.current !== root && current?.alternate) current = current.alternate;
    for (let fiber = current, depth = 0; fiber && depth < 15; fiber = fiber.return, depth++) {
      const price = fiber.memoizedProps?.price;
      if (price?.priceGrade && price.seatGrade != null) return price;
    }
    return null;
  }
  const usable = node => node.getClientRects().length > 0 && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const rowCount = row => {
    const input = row.querySelector('input');
    const count = Number(input?.value);
    if (!input || !Number.isInteger(count) || count < 0) throw new Error('无法确认票价数量');
    return count;
  };
  async function finishPricing(payload, ids, progress) {
    progress("已进入票价页，正在确认 General 票价与数量");
    const targets = new Map();
    for (const seat of payload.seats) targets.set(String(seat.seatGrade), (targets.get(String(seat.seatGrade)) || 0) + 1);
    let rows = [];
    for (let i = 0; i < 300; i++) {
      assertSelection(payload, ids);
      if (!atStep('price')) throw new Error('页面已离开票价步骤');
      rows = [...document.querySelectorAll('li[class*="typeItem"]')].filter(row => row.getClientRects().length > 0).map(row => ({ row, price: rowPrice(row) }));
      if (rows.length && [...targets.keys()].every(grade => rows.some(item => String(item.price?.seatGrade) === grade))) break;
      await pause(50);
    }
    const chosen = new Map();
    for (const [grade, quantity] of targets) {
      const matches = rows.filter(({ price }) => price && String(price.seatGrade) === grade && price.pgCode === 'PG002' && !price.isMembership && !price.isHPointCertify && !price.isRandomCertifyOnce && !price.discountName && !price.discountNumber && !price.priceSettingType);
      if (matches.length !== 1) throw new Error('普通票价不能唯一确认，请手动选择票价');
      chosen.set(matches[0].row, quantity);
    }
    for (const { row } of rows) {
      if (!chosen.has(row) && rowCount(row) !== 0) throw new Error('页面已有其他票价数量，请手动检查');
    }
    for (const [row, quantity] of chosen) {
      let count = rowCount(row);
      if (count > quantity) throw new Error('当前票价数量超过目标，请手动检查');
      while (count < quantity) {
        assertSelection(payload, ids);
        if (!atStep('price')) throw new Error('页面已离开票价步骤');
        const buttons = [...row.querySelectorAll('button')];
        // 原站 Counter 的顺序：DecrementButton、只读 Input、IncrementButton。
        if (buttons.length !== 2 || !usable(buttons[1])) throw new Error('票价加号不可用，请检查页面提示');
        progress(`票价数量 ${count} → ${count + 1}，点击加号`);
        buttons[1].click();
        let next = count;
        for (let i = 0; i < 40 && next === count; i++) { await pause(50); assertSelection(payload, ids); next = rowCount(row); }
        if (next !== count + 1 || next > quantity) throw new Error('票价数量未按预期增加，请检查页面');
        count = next;
      }
    }
    assertSelection(payload, ids);
    for (const { row } of rows) if (rowCount(row) !== (chosen.get(row) || 0)) throw new Error('提交前票价数量不一致');
    if (!atStep('price')) throw new Error('页面已离开票价步骤');
    progress(`票价数量已确认：${ids.length} 张，等待 Book 按钮可用`);
    let book = null;
    for (let i = 0; i < 60; i++) {
      assertSelection(payload, ids);
      if (!atStep('price')) throw new Error('页面已离开票价步骤');
      for (const { row } of rows) if (rowCount(row) !== (chosen.get(row) || 0)) throw new Error('等待 Book 时票价数量改变');
      const buttons = [...document.querySelectorAll('button')].filter(node => usable(node) && new RegExp('^Book\\s+' + ids.length + '\\s+tickets?$','i').test((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()));
      if (buttons.length > 1) throw new Error('存在多个 Book 按钮，无法唯一确认');
      if (buttons.length === 1) { book = buttons[0]; break; }
      await pause(50);
    }
    if (!book) throw new Error('未找到匹配数量且可用的 Book 按钮，请检查页面语言或提示');
    book.click();
    progress(`已点击 Book ${ids.length} ticket，等待进入付款页`);
    for (let i = 0; i < 200; i++) {
      assertSelection(payload, ids);
      if (atStep('payment')) return;
      await pause(50);
    }
    throw new Error('Book 已点击，但未确认进入付款页，请检查页面，不会重复提交');
  }
  window.addEventListener('message', async ev => {
    const d = ev.data;
    if (ev.source !== window || ev.origin !== location.origin || d?.__tag !== TAG || d.type !== 'command') return;
    const reply = payload => window.postMessage({ __tag: TAG, type: 'result', id: d.id, payload }, location.origin);
    if (d.action === 'cancel') { cancelled = true; reply({ ok: true }); return; }
    if (d.action === 'status') {
      try { const c = context(); reply({ version: VERSION, verified: !!sessionStorage.getItem('interpark/captchaVerify'), session: c.sessionId, selectedIds: (c.seats || []).map(s => s.seatInfoId) }); } catch (e) { reply({ error: '页面上下文不可用' }); }
      return;
    }
    if (d.action !== 'lock') return;
    if (busy) { reply({ error: '页面自动锁票处理中' }); return; }
    busy = true; cancelled = false;
    let changed = false;
    const progress = message => window.postMessage({ __tag: TAG, type: 'progress', id: d.id, payload: { message } }, location.origin);
    try {
      const p = d.payload;
      const c = check(p);
      const ids = p.seats?.map(s => s.seatInfoId);
      if (!ids?.length || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => !id.startsWith(`${p.goodsCode}:${p.placeCode}:${p.playSeq}:`))) throw new Error('候选座位不合法');
      if ((c.seats || []).length || controller().seatSelected.length) throw new Error('页面已有选中座位，请先人工处理');
      for (const seat of p.seats) {
        check(p);
        changed = true;
        await controller().seatSelectHandler(true, seat, p.blockKey, false);
        await pause(150);
        if (!(context().seats || []).some(s => s.seatInfoId === seat.seatInfoId)) throw new Error('页面预选失败，请检查提示');
      }
      check(p);
      if (!matchingSeats(context(), ids)) throw new Error('页面选中座位与目标不一致');
      const selected = controller();
      if (selected.seatSelected.length !== ids.length) throw new Error('页面选座状态尚未就绪');
      // 由原生回调负责预选校验、seats/select、预约倒计时和路由跳转。
      progress("已调用 Submit，等待进入票价页");
      await selected.onComplete();
      for (let i = 0; i < 150; i++) {
        const c = context();
        if (c.sessionId !== p.session) throw new Error('提交期间会话改变');
        if (atStep('price') && matchingSeats(c, ids)) {
          await finishPricing(p, ids, progress);
          reply({ outcome: 'payment-ready', seatIds: ids }); return;
        }
        await pause(100);
      }
      throw new Error('页面未确认座位提交并进入票价步骤，请检查页面提示');
    } catch (e) { reply({ error: e.message, uncertain: changed }); }
    finally { busy = false; }
  });
})();
