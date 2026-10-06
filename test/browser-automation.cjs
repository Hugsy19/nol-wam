const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const assert = require('assert/strict');
const root = require('path').resolve(__dirname, '..') + '/';
(async () => {
 const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 try {
  const page = await browser.newPage();
  const errors = [];page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/vendor/ocr/')) {
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return route.fulfill({contentType,body:fs.readFileSync(root+pathname.slice(1))});
    }
    if (route.request().url().includes('/seats/select')) return route.fulfill({status:201,contentType:'application/json',body:'{"unselectableSeatInfoIds":[]}'});
    return route.fulfill({contentType:'text/html',body:'<html><body><aside></aside><div class="modal"><div class="ModalCaptchaText_layerWrap"><div class="ModalCaptchaText_captchaContent"><div class="ModalCaptchaText_captchaBox"><button>Refresh</button><div class="ModalCaptchaText_captchaImage"><img src="data:image/png;base64,AA=="></div></div><input class="ModalCaptchaText_captchaInput" /></div></div><footer><button disabled>Input Complete</button></footer></div></body></html>'});
  });
  await page.goto('https://tickets.interpark.com/onestop/seat');
  await page.addScriptTag({content:fs.readFileSync(root+'lib/captcha-dom.js','utf8').replace(/export /g,'')});
  assert.deepEqual(await page.evaluate(()=>{
    const x=findCaptchaControls(document);
    return {input:!!x.input, image:!!x.image, button:!!x.button, disabled:x.button.disabled, incorrectOldSelector:document.querySelector('[class*="captchaBox"]').querySelector('input')===null};
  }),{input:true,image:true,button:true,disabled:true,incorrectOldSelector:true});
  const content = fs.readFileSync(root+'content/onestop-seat.js','utf8');
  const captchaCode = content.slice(content.indexOf('function captchaAutoNote('),content.indexOf('const pagePending'));
  await page.addScriptTag({content:fs.readFileSync(root+'lib/automation.js','utf8').replace(/export /g,'')});
  await page.evaluate(()=>{
    window.submitted=0;
    window.state={session:'session', prefs:{captchaAutoSolve:true},automation:{captchaGeneration:0,ocrBusy:false,ocrTried:new Set()}};
    window.C=()=>({active:true,kind:'text'});window.timerSnapshot=()=>({state:'live'});window.log=()=>{};window.sleep=ms=>new Promise(r=>setTimeout(r,ms));
    window.chrome={runtime:{sendMessage:async()=>{await sleep(30);state.automation.captchaGeneration++;return{text:'ABCDEF',confidence:90};}}};
    const button=document.querySelector('footer button');
    document.querySelector('input').addEventListener('input',e=>{button.disabled=e.target.value.length!==6;});
    button.onclick=()=>submitted++;
  });
  await page.addScriptTag({content:captchaCode});
  await page.evaluate(async()=>{await maybeSolveCaptcha();await maybeSolveCaptcha();});
  assert.equal(await page.evaluate(()=>submitted),1);
  assert.equal(await page.locator('input').inputValue(),'ABCDEF');
  const delayed = await page.evaluate(async()=>{
    document.querySelector('input').remove();
    const image=document.querySelector('[class*=captchaImage] img');image.removeAttribute('src');
    const button=document.querySelector('footer button');button.disabled=true;
    submitted=0;state.automation.ocrTried.clear();state.automation.captchaNote='';
    const stop=watchCaptchaDom(document,()=>maybeSolveCaptcha(),()=>true);
    const noise=document.createElement('span');document.body.appendChild(noise);
    const churn=setInterval(()=>noise.textContent=String(Math.random()),20);
    setTimeout(()=>{const input=document.createElement('input');input.className='UpdatedCaptcha_captchaInput__hash';input.addEventListener('input',()=>button.disabled=input.value.length!==6);document.querySelector('[class*=captchaContent]').appendChild(input);},50);
    setTimeout(()=>image.src='data:image/png;base64,AQ==',150);
    await sleep(1000);stop();clearInterval(churn);noise.remove();
    return{submitted,value:document.querySelector('input').value};
  });
  assert.deepEqual(delayed,{submitted:1,value:'ABCDEF'});
  console.log('同图通知竞态与等待回归通过：持续 DOM 更新期间仍能处理延迟输入框和仅 src 属性更新，且只提交一次');

  await page.addScriptTag({path:root+'content/onestop-hook.js'});
  await page.addScriptTag({path:root+'content/page-automation.js'});
  await page.evaluate(()=>{
    window.messages=[];window.sequence=[];
    window.addEventListener('message',e=>messages.push(e.data));
    const c={sessionId:'session',goods:{goodsCode:'g',placeCode:'p'},playSeq:{playSeq:'001'},seats:[]};
    sessionStorage.setItem('interpark/context',JSON.stringify(c));sessionStorage.setItem('interpark/captchaVerify','true');
    const props={seatSelected:[],seatSelectHandler:async(selected,seat,block,external)=>{
      sequence.push(['preselect',seat.seatInfoId,block,external]);
      props.seatSelected.push(seat);c.seats.push(seat);sessionStorage.setItem('interpark/context',JSON.stringify(c));
    },onComplete:async()=>{
      sequence.push(['confirm']);
      const res=await fetch('/onestop/api/seats/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seats:c.seats})});
      await res.json();history.pushState({},'', '/onestop/seat?step=price');
    }};
    document.querySelector('aside').__reactFiber$fixture={memoizedProps:props};
  });
  const result=await page.evaluate(()=>new Promise(resolve=>{
    window.addEventListener('message',function handler(e){if(e.data.__tag==='nol-scout-page'&&e.data.id==='test'&&e.data.type==='result'){window.removeEventListener('message',handler);resolve(e.data.payload);}});
    window.postMessage({__tag:'nol-scout-page',type:'command',action:'lock',id:'test',payload:{session:'session',goodsCode:'g',placeCode:'p',playSeq:'001',blockKey:'001:001',seats:[{seatInfoId:'g:p:001:1',seatGrade:'1'},{seatInfoId:'g:p:001:2',seatGrade:'1'}]}},location.origin);
  }));
  assert.equal(result.outcome,'locked');
  assert.deepEqual(await page.evaluate(()=>sequence.map(x=>x[0])),['preselect','preselect','confirm']);
  assert.equal(new URL(page.url()).searchParams.get('step'),'price');
  const api=await page.evaluate(()=>messages.find(m=>m.__tag==='nol-scout-hook'&&m.type==='api'&&m.payload.url.includes('/seats/select')));
  assert.deepEqual(api.payload.requestSeatIds,['g:p:001:1','g:p:001:2']);
  const samples = ['tickets.interpark.com.har','tickets.interpark.com_new.har'].map(name=>{
    const har=JSON.parse(fs.readFileSync(require('path').resolve(root, '../'+name)));
    return {name, sample:JSON.parse(har.log.entries.find(e=>e.request.url.includes('/captcha/image')).response.content.text).Img,
      answer:new URL(har.log.entries.find(e=>e.request.url.includes('/captcha/verify')).request.url).searchParams.get('p1')};
  });
  await page.evaluate(()=>{chrome.runtime.getURL=p=>location.origin+'/'+p;chrome.runtime.onMessage={addListener:()=>{}};});
  await page.addScriptTag({path:root+'vendor/ocr/tesseract.min.js'});
  await page.addScriptTag({path:root+'offscreen/ocr.js'});
  const results = await page.evaluate(async samples=>{
    const w=await localWorker(), results=[];
    for(const {name,sample,answer} of samples){const {data}=await w.recognize(await prepareCaptcha(sample));
      results.push({name,matched:data.text.replace(/\s/g,'').toUpperCase()===answer.toUpperCase(),confidence:data.confidence});}
    await w.terminate();return results;
  },samples);
  console.log('两份 HAR 本地 OCR:',JSON.stringify(results));
  assert.ok(results.every(r=>r.matched&&r.confidence>=40));
  const popup = await browser.newPage();
  await popup.addInitScript(()=>{
    window.savedPrefs=JSON.parse(localStorage.getItem('fixturePrefs')||'{}');window.savedSettings={notify:true,sound:true,minIntervalMs:600};
    window.chrome={storage:{local:{get:async()=>({scoutPrefs:savedPrefs}),set:async data=>{if(data.scoutPrefs){savedPrefs=data.scoutPrefs;localStorage.setItem('fixturePrefs',JSON.stringify(savedPrefs));}}}},tabs:{query:async()=>[]},runtime:{sendMessage:async msg=>{
      if(msg.type==='get-state')return{serverNow:Date.now(),time:{},tasks:[],stats:[],logs:[],hits:[],settings:savedSettings,scoutPrefs:savedPrefs,seatState:null,lastCatalog:null};
      if(msg.type==='update-settings'){savedSettings={...savedSettings,...msg.settings};return{ok:true};}
      return{ok:true};
    }}};
  });
  await popup.route('**/*',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('/popup.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(root+'popup/popup.js')});
    if(pathname.endsWith('/popup.css'))return route.fulfill({contentType:'text/css',body:fs.readFileSync(root+'popup/popup.css')});
    return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'popup/popup.html')});
  });
  await popup.goto('https://tickets.interpark.com/test/popup.html');
  await popup.locator('#setToggle').click();
  await popup.locator('#sAutoCaptcha').check();await popup.locator('#sAutoLock').check();
  await popup.evaluate(async()=>{await refresh();});
  assert.ok(await popup.locator('#sAutoCaptcha').isChecked());
  assert.ok(await popup.locator('#sAutoLock').isChecked());
  await popup.locator('#sSave').click();
  await popup.waitForFunction(()=>savedPrefs.captchaAutoSolve&&savedPrefs.autoLock);
  await popup.reload();await popup.locator('#setToggle').click();
  assert.ok(await popup.locator('#sAutoCaptcha').isChecked());
  assert.ok(await popup.locator('#sAutoLock').isChecked());
  console.log('popup 设置通过：未保存勾选不被刷新覆盖，保存并重开后两个开关保持开启');
  assert.deepEqual(errors,[]);
  console.log('Chrome 集成检查通过：新 HAR 验证码 DOM、初始禁用按钮、逐座预选→原生确认→price 跳转、真实 fetch 响应及座位关联');
 } finally {await browser.close();}
})();
