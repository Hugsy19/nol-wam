const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
(async()=>{
 const extension=require('path').resolve(__dirname,'..');
 const context=await chromium.launchPersistentContext(fs.mkdtempSync(require('path').join(require('os').tmpdir(),'nol-mv3-')),{
   executablePath:process.env.TEST_CHROME_EXECUTABLE,headless:true,
   args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-features=DisableLoadExtensionCommandLineSwitch'],ignoreDefaultArgs:['--disable-extensions'],
 });
 try {
  let sw=context.serviceWorkers()[0];if(!sw)sw=await context.waitForEvent('serviceworker',{timeout:10000});
  const id=sw.url().split('/')[2];console.log('MV3 service worker loaded');
  const har=JSON.parse(fs.readFileSync(require('path').resolve(extension,'../tickets.interpark.com_new.har')));
  const image=JSON.parse(har.log.entries.find(e=>e.request.url.includes('/captcha/image')).response.content.text).Img;
  const answer=new URL(har.log.entries.find(e=>e.request.url.includes('/captcha/verify')).request.url).searchParams.get('p1');
  const page=await context.newPage();page.on('pageerror',e=>console.log('offscreen error:',e.message));
  await page.goto(`chrome-extension://${id}/offscreen/sound.html`);
  const result=await page.evaluate(async({image,answer})=>{
   const timeout=new Promise((_,reject)=>setTimeout(()=>reject(Error('OCR timed out after 12 seconds')),12000));
   return Promise.race([(async()=>{const w=await localWorker();const{data}=await w.recognize(await prepareCaptcha(image));await w.terminate();return{matched:data.text.replace(/\s/g,'').toUpperCase()===answer.toUpperCase(),confidence:data.confidence};})(),timeout]);
  },{image,answer});console.log('Extension-origin OCR',JSON.stringify(result));
  await page.close();
  await sw.evaluate(()=>chrome.storage.local.set({scoutPrefs:{captchaAutoSolve:true,autoLock:false}}));
  const session='26010154_M000000141021'+Math.floor(Date.now()/1000);
  await context.route('https://api-ticketfront.interpark.com/**',route=>route.fulfill({contentType:'text/plain',body:String(Date.now())}));
  await context.route('https://tickets.interpark.com/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/captcha/image'))return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({Img:image,EncRnd:'fixture'})});
    if(path.endsWith('/captcha/verify'))return route.fulfill({contentType:'application/json',body:'{"result":"Y"}'});
    return route.fulfill({contentType:'text/html',body:`<!DOCTYPE html><html><body><script>
      window.submitted='';
      fetch('/onestop/api/captcha/image',{method:'POST',headers:{'x-onestop-session':'${session}'}}).then(r=>r.json()).then(j=>{
        const modal=document.createElement('div');modal.className='fixtureModal';
        modal.innerHTML='<div class="ModalCaptchaText_layerWrap"><div class="ModalCaptchaText_captchaContent"><div class="ModalCaptchaText_captchaBox"><div class="ModalCaptchaText_captchaImage"><img></div></div><input class="ModalCaptchaText_captchaInput"></div></div><footer><button disabled>Input Complete</button></footer>';
        modal.querySelector('img').src=j.Img;const input=modal.querySelector('input'),button=modal.querySelector('button');
        input.addEventListener('input',()=>{button.disabled=input.value.length!==6;});
        button.onclick=()=>{window.submitted=input.value;fetch('/onestop/api/captcha/verify?p1='+input.value,{headers:{'x-onestop-session':'${session}'}});};
        document.body.appendChild(modal);
      });
    </script></body></html>`});
  });
  const booking=await context.newPage();
  await booking.goto('https://tickets.interpark.com/onestop/seat');
  try { await booking.waitForFunction(()=>window.submitted,null,{timeout:20000}); } catch(e) {
    console.log('Fixture DOM',await booking.evaluate(()=>({input:!!document.querySelector('input[class*=captchaInput]'),inputLength:document.querySelector('input[class*=captchaInput]')?.value.length,logs:document.getElementById('nol-scout-host')?.shadowRoot?.textContent?.slice(-3000)})));
    console.log('SW state',await sw.evaluate(async()=>({contexts:await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}),prefs:(await chrome.storage.local.get('scoutPrefs')).scoutPrefs})));
    throw e;
  }
  const completed=await booking.evaluate(answer=>({matched:window.submitted===answer.toUpperCase(),inputFilled:document.querySelector('input[class*=captchaInput]').value.length===6}),answer);
  console.log('Actual content→background→offscreen→input→submit:',JSON.stringify(completed));
  if(!completed.matched)throw Error('End-to-end OCR did not match');
  console.log('Offscreen contexts:',await sw.evaluate(async()=> (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length));

 } finally {await context.close();}
})();
