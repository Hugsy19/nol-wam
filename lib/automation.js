// 自动操作的纯函数。请求只使用当前页面会话，不复用 HAR 的令牌或签名。
export function normalizeOcrAnswer(text) {
  const answer = String(text || '').replace(/\s/g, '').toUpperCase();
  return /^[A-Z]{6}$/.test(answer) ? answer : '';
}

export function makeLockPayload(page, run, quantity) {
  if (!page.session || !page.goodsCode || !page.placeCode || !page.playSeq) throw new Error('缺少当前购票会话');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) throw new Error('购票数量错误');
  const seats = run?.seats?.slice(0, quantity) || [];
  if (seats.length !== quantity || new Set(seats.map(s => s.id)).size !== quantity) throw new Error('候选座位不足或重复');
  const prefix = `${page.goodsCode}:${page.placeCode}:${page.playSeq}:`;
  if (seats.some(s => !s.id?.startsWith(prefix) || !s.grade)) throw new Error('座位与当前场次不匹配');
  return {
    goodsCode: page.goodsCode, placeCode: page.placeCode, playSeq: page.playSeq,
    seatType: 'DEFAULT', seats: seats.map(s => ({ seatGrade: s.grade, seatInfoId: s.id })),
    sessionId: page.session, autoAssign: false,
  };
}

export function lockOutcome(json) {
  if (!Array.isArray(json?.unselectableSeatInfoIds)) return 'unknown';
  return json.unselectableSeatInfoIds.length === 0 ? 'locked' : 'unavailable';
}
