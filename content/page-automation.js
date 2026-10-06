// MAIN world：调用当前页面已挂载的 React 选座回调，不硬编码 webpack 模块号。
(() => {
  const TAG = 'nol-scout-page';
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
  window.addEventListener('message', async ev => {
    const d = ev.data;
    if (ev.source !== window || ev.origin !== location.origin || d?.__tag !== TAG || d.type !== 'command') return;
    const reply = payload => window.postMessage({ __tag: TAG, type: 'result', id: d.id, payload }, location.origin);
    if (d.action === 'cancel') { cancelled = true; reply({ ok: true }); return; }
    if (d.action === 'status') {
      try { const c = context(); reply({ verified: !!sessionStorage.getItem('interpark/captchaVerify'), session: c.sessionId, selectedIds: (c.seats || []).map(s => s.seatInfoId) }); } catch (e) { reply({ error: '页面上下文不可用' }); }
      return;
    }
    if (d.action !== 'lock') return;
    if (busy) { reply({ error: '页面自动锁票处理中' }); return; }
    busy = true; cancelled = false;
    let changed = false;
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
      await selected.onComplete();
      for (let i = 0; i < 30; i++) {
        const c = context();
        if (c.sessionId !== p.session) throw new Error('提交期间会话改变');
        if (new URL(location.href).searchParams.get('step') === 'price' && matchingSeats(c, ids)) {
          reply({ outcome: 'locked', seatIds: ids }); return;
        }
        await pause(100);
      }
      throw new Error('页面未确认锁票并进入票价步骤，请检查页面提示');
    } catch (e) { reply({ error: e.message, uncertain: changed }); }
    finally { busy = false; }
  });
})();
