import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../content/page-automation.js', import.meta.url), 'utf8');
async function scenario(mode) {
  const sequence = [], responses = [];
  let priceWaits = 0, pricePending = false, bookLookups = 0;
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
  }, onComplete: async () => { sequence.push('confirm'); if (mode === 'delayed-price') pricePending = true; else if (mode !== 'confirm-fail') location.href += '?step=price'; } };
  const aside = { __reactFiber$fixture: { memoizedProps: props } };
  if (mode === 'unverified') storage.delete('interpark/captchaVerify');
  if (mode === 'existing') { c.seats.push(payload.seats[0]);storage.set('interpark/context', JSON.stringify(c)); }
  if (mode === 'wrong-session') payload.session = 'other';
  let count = mode === 'already-priced' ? 2 : mode === 'too-many' ? 3 : 0;
  const input = { get value() { return String(count); } };
  const enabled = { getClientRects:()=>[{}],getAttribute:()=>null,disabled:false };
  const minus = {...enabled,click:()=>count--};
  const plus = {...enabled,click:()=>{sequence.push('plus');if(mode !== 'plus-fail') count++;}};
  const price = {seatGrade:'1',priceGrade:'U1',pgCode:mode==='special-price'?'PG003':'PG002'};
  const row = {...enabled,__reactFiber$price:{memoizedProps:{price}},querySelector:()=>input,querySelectorAll:()=>[minus,plus]};
  const book = {...enabled,get innerText(){return `Book ${count} tickets`;},click:()=>{sequence.push('book');if(mode !== 'book-fail')location.href='https://tickets.interpark.com/onestop/payment';}};
  Object.defineProperty(book, 'disabled', {get:()=>mode === 'delayed-book' && bookLookups < 5});
  const document = {querySelectorAll:selector=>{if (selector === 'button') bookLookups++;return selector.startsWith('li[')?[row]:selector==='button'?[book]:[aside];}};
  vm.runInNewContext(source, { window, location, sessionStorage:{getItem:key=>storage.get(key)||null}, document, URL, setTimeout:fn=>setImmediate(()=>{if(pricePending && ++priceWaits === 40){location.href += '?step=price';pricePending=false;}fn();}), Promise });
  await command('lock');
  return {sequence,result:responses.find(r=>r.id==='lock' && r.type==='result').payload};
}
const success = await scenario('success');assert.deepEqual(success.sequence,['preselect','preselect','confirm','plus','plus','book']);assert.equal(success.result.outcome,'payment-ready');
for (const mode of ['unverified','existing','wrong-session']) {
  const s=await scenario(mode);assert.deepEqual(s.sequence,[]);assert.ok(s.result.error);assert.equal(s.result.uncertain,false);
}
for (const mode of ['preselect-fail','cancel']) {
  const s=await scenario(mode);assert.deepEqual(s.sequence,['preselect']);assert.ok(s.result.error);assert.equal(s.result.uncertain,true);
}
const failure=await scenario('confirm-fail');assert.ok(failure.result.error);assert.equal(failure.result.uncertain,true);
console.log('原生页面流程失败分支通过：未验证、已有座位、会话变化不操作；预选失败/取消不确认；未跳转不报成功');

const priced=await scenario('already-priced');assert.equal(priced.result.outcome,'payment-ready');assert(!priced.sequence.includes('plus'));assert.equal(priced.sequence.filter(x=>x==='book').length,1);
for (const mode of ['too-many','special-price','plus-fail','book-fail']) {
 const s=await scenario(mode);assert.ok(s.result.error);assert.equal(s.result.uncertain,true);
 if(mode !== 'book-fail')assert(!s.sequence.includes('book'));else assert.equal(s.sequence.filter(x=>x==='book').length,1);
}
console.log('票价衔接回归通过：数量补足、已有数量不加、Book 仅一次、进入付款才成功；特殊票价/数量超额/加号无效/付款未跳转不报成功。');

for (const mode of ['delayed-price','delayed-book']) {
 const s=await scenario(mode);assert.equal(s.result.outcome,'payment-ready');assert.equal(s.sequence.filter(x=>x==='book').length,1);
}
console.log('新增等待回归通过：票价跳转超过旧 3 秒窗口、Book 延迟启用；仍只提交一次。');
