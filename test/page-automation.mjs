import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../content/page-automation.js', import.meta.url), 'utf8');
async function scenario(mode) {
  const sequence = [], responses = [];
  const c = { sessionId: 's', goods: { goodsCode: 'g', placeCode: 'p' }, playSeq: { playSeq: '001' }, seats: [] };
  const location = { origin: 'https://tickets.interpark.com', href: 'https://tickets.interpark.com/onestop/seat' };
  const storage = new Map([['interpark/context', JSON.stringify(c)], ['interpark/captchaVerify', 'true']]);
  const handlers = [];
  const window = { addEventListener: (type, handler) => handlers.push(handler), postMessage: data => responses.push(data) };
  const payload = { session: 's', goodsCode: 'g', placeCode: 'p', playSeq: '001', blockKey: '001:001', seats: [1,2].map(n => ({ seatInfoId: `g:p:001:${n}`, seatGrade: '1' })) };
  const command = action => handlers[0]({source:window, origin:location.origin, data:{__tag:'nol-scout-page',type:'command',id:action,action,payload}});
  const props = { seatSelected: [], seatSelectHandler: async (select, seat) => {
    sequence.push('preselect');
    if (mode === 'preselect-fail') return;
    c.seats.push(seat); props.seatSelected.push(seat);storage.set('interpark/context', JSON.stringify(c));
    if (mode === 'cancel') await command('cancel');
  }, onComplete: async () => { sequence.push('confirm'); if (mode !== 'confirm-fail') location.href += '?step=price'; } };
  const aside = { __reactFiber$fixture: { memoizedProps: props } };
  if (mode === 'unverified') storage.delete('interpark/captchaVerify');
  if (mode === 'existing') { c.seats.push(payload.seats[0]);storage.set('interpark/context', JSON.stringify(c)); }
  if (mode === 'wrong-session') payload.session = 'other';
  vm.runInNewContext(source, { window, location, sessionStorage:{getItem:key=>storage.get(key)||null}, document:{querySelectorAll:()=>[aside]}, URL, setTimeout:fn=>setImmediate(fn), Promise });
  await command('lock');
  return {sequence,result:responses.find(r=>r.id==='lock').payload};
}
const success = await scenario('success');assert.deepEqual(success.sequence,['preselect','preselect','confirm']);assert.equal(success.result.outcome,'locked');
for (const mode of ['unverified','existing','wrong-session']) {
  const s=await scenario(mode);assert.deepEqual(s.sequence,[]);assert.ok(s.result.error);assert.equal(s.result.uncertain,false);
}
for (const mode of ['preselect-fail','cancel']) {
  const s=await scenario(mode);assert.deepEqual(s.sequence,['preselect']);assert.ok(s.result.error);assert.equal(s.result.uncertain,true);
}
const failure=await scenario('confirm-fail');assert.ok(failure.result.error);assert.equal(failure.result.uncertain,true);
console.log('原生页面流程失败分支通过：未验证、已有座位、会话变化不操作；预选失败/取消不确认；未跳转不报成功');
