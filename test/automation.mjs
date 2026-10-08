import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeLockPayload, lockOutcome, normalizeOcrAnswer } from '../lib/automation.js';
import { decodeBlockStatus } from '../lib/nol-api.js';
const har = JSON.parse(fs.readFileSync(process.argv[2] || new URL('../../tickets.interpark.com.har', import.meta.url)));
const entry = har.log.entries.find(e => e.request.url.includes('/seats/select'));
const expected = JSON.parse(entry.request.postData.text);
const page = { ...expected, session: expected.sessionId };
const run = { blockKey: '001:001', seats: expected.seats.map(s => ({ id: s.seatInfoId, grade: s.seatGrade })), seatNos: ['194'] };
assert.deepEqual(makeLockPayload(page, run, 1), expected);
assert.throws(() => makeLockPayload({ ...page, playSeq: '999' }, run, 1));
assert.throws(() => makeLockPayload(page, run, 2));
assert.equal(lockOutcome(JSON.parse(entry.response.content.text)), 'locked');
assert.equal(lockOutcome({}), 'unknown');
assert.equal(lockOutcome({ unselectableSeatInfoIds: ['taken'] }), 'unavailable');
assert.equal(normalizeOcrAnswer(' aB CDEF\n'), 'ABCDEF');
assert.equal(normalizeOcrAnswer('ABC123'), '');
assert.equal(normalizeOcrAnswer('ABC!12'), '');
const source = fs.readFileSync(new URL('../content/onestop-seat.js', import.meta.url), 'utf8');
const start = source.indexOf('async function maybeLockBest(');
const end = source.indexOf('// ---------------- 页面座位图定位', start);
async function scenario({ outcome = 'locked', verified = true, expired = false } = {}) {
  let calls = 0, stopped = false;
  const monitor = { task: { quantity: 1 }, ctrl: new AbortController() };
  const state = { ...page, monitor, prefs: { autoLock: true }, automation: { busy: false, locked: null, uncertain: false, lastAttempt: 0 }, catalog: { blocks: [{ key: run.blockKey, seats: run.seats }] } };
  const sandbox = {
    window: { addEventListener: () => {} }, document: { querySelector: () => null }, sleep: async () => {},
    CAPTCHA_SEL: { box: '.captcha' }, state, C: () => ({ active: false, passed: verified }), timerSnapshot: () => ({ state: expired ? 'dead' : 'live' }),
    makeLockPayload, lockOutcome, decodeBlockStatus, Date, ctx: () => ({}),
    getSeatStatus: async () => ({ [run.blockKey]: '8' }),
    getSeatMeta: async () => [{ seats: expected.seats }],
    pageCommand: async action => {
      if (action === 'status') return { version: '0.8.9', verified, session: page.session, selectedIds: [] };
      calls++;
      if (outcome === 'timeout') throw Error('timeout');
      state.automation.lockReceipt = { ids: run.seats.map(s => s.id), outcome };
      return outcome === 'locked' ? { outcome: 'payment-ready' } : { error: 'failed', uncertain: true };
    },
    selectSeats: async () => { calls++; if (outcome === 'timeout') throw Error('timeout'); return outcome === 'locked' ? { unselectableSeatInfoIds: [] } : outcome === 'unavailable' ? { unselectableSeatInfoIds: ['taken'] } : {}; },
    noteLockSkip: () => {}, hitSummary: () => 'seat', log: () => {}, notifySoon: () => {}, renderPanel: () => {},
    stopMonitor: () => { stopped = true; state.monitor = null; },
  };
  vm.createContext(sandbox);vm.runInContext(source.slice(start, end), sandbox);
  await sandbox.maybeLockBest(run, monitor);
  state.automation.lastAttempt = 0;
  await sandbox.maybeLockBest(run, monitor);
  return { calls, stopped, a: state.automation };
}
let result = await scenario();assert.equal(result.calls, 1);assert.equal(result.stopped, true);assert.ok(result.a.locked);
for (const outcome of ['timeout', 'unavailable', 'unknown']) {
  result = await scenario({ outcome });assert.equal(result.calls, 1);assert.equal(result.a.uncertain, true);assert.equal(result.stopped, false);
}
assert.equal((await scenario({ verified: false })).calls, 0);
assert.equal((await scenario({ expired: true })).calls, 0);
console.log('自动锁票：HAR 请求一致、场次/数量校验、成功停止、冲突/超时/未知响应不重试、验证码/会话门禁全部通过');
