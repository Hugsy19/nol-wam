import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../content/onestop-seat.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('let monitorStartPromise = null;'),source.indexOf('async function loop(task, blocks, ctrl)'));
function harness(){
 let resolveCatalog,builds=0,cancels=0,loops=0;
 const state={monitor:null,automation:{busy:false},catalog:{},playSeq:'1'};
 const ctx=vm.createContext({state,Promise,AbortController,timerSnapshot:()=>({state:'live'}),ensureCatalog:()=>{builds++;return new Promise(r=>resolveCatalog=r);},targetBlocks:()=>['b'],adoptTask:()=>{},renderPanel:()=>{},log:()=>{},describePrefs:()=>'',ensureLocator:async()=>({}),summarizeCatalog:()=>({}),loop:async()=>{loops++;},pageCommand:()=>{cancels++;return Promise.resolve({});},clearOverlay:()=>{},releaseTask:()=>{}});vm.runInContext(code,ctx);
 return {ctx,state,start:()=>vm.runInContext('startMonitor({intervalMs:1000})',ctx),stop:()=>vm.runInContext('stopMonitor()',ctx),resolve:()=>resolveCatalog(),stats:()=>({builds,cancels,loops})};
}
let h=harness();let a=h.start(),b=h.start();assert.equal(a,b);assert.equal(h.stats().builds,1);h.resolve();await a;assert.equal(h.stats().loops,1);
const monitor=h.state.monitor;h.state.automation.busy=true;await h.start();assert.equal(h.state.monitor,monitor);assert(!monitor.ctrl.signal.aborted);assert.equal(h.stats().cancels,0);h.stop();assert(monitor.ctrl.signal.aborted);assert.equal(h.stats().cancels,1);
h=harness();a=h.start();h.stop();h.resolve();await assert.rejects(a,/扫描启动已取消/);assert.equal(h.state.monitor,null);assert.equal(h.stats().loops,0);
console.log('竞态回归通过：并发启动仅一个监控；锁票中重复开始不取消；手动停止仍取消；目录等待中停止后不会重新开扫。');
