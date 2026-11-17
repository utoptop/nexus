// Verify the original Cyber Nexus visual language and its live effects stay enabled.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
  const html=fs.readFileSync('/tmp/observatory-preview.html','utf8');
  await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.routeWebSocket('**/ws',()=>{});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.TrajectoryPool);
  await page.evaluate(()=>queueLiveEvent({ip:'early',server_name:'Direct Access',location:'Shanghai',lat:31,lon:121,time:new Date().toISOString(),count:1,lang:'en',target_domain:'test'}));
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(()=>window.TrajectoryPool.inspect().admitted),1);
  await page.evaluate(()=>{map.setView([25,90],2,{animate:false});baseTileLayer.setOpacity(.22);});
  await page.waitForSelector('.dc-tip',{state:'attached'});
  const style=await page.evaluate(()=>{
   const css=(s,p)=>getComputedStyle(document.querySelector(s),p);
   return{brand:document.querySelector('.dash-sidebar-logo').textContent,accent:css(':root').getPropertyValue('--accent-cyan').trim(),glass:css('.dash-kpi-card').backdropFilter,bg:css('.dash-kpi-card').backgroundColor,gradient:css('.dash-sidebar-logo').backgroundImage,cardBar:css('.dash-kpi-card','::before').backgroundImage,cardGlow:css('.dash-kpi-card','::after').display,tooltipGlass:css('.dc-tip').backdropFilter,tooltipRadius:css('.dc-tip').borderRadius,panelGlass:css('#data-panel').backdropFilter};
  });
  assert.ok(style.brand.includes('NEXUS'));assert.equal(style.accent,'#06b6d4');assert.equal(style.glass,'none'); // The opaque fullscreen overview does not need backdrop sampling.
  assert.ok(style.gradient.includes('linear-gradient'));assert.ok(style.cardBar.includes('linear-gradient'));assert.notEqual(style.cardGlow,'none');assert.ok(style.tooltipGlass.includes('blur(16px)'));assert.equal(style.tooltipRadius,'12px');assert.notEqual(style.panelGlass,'none');console.log('ORIGINAL_STYLE',style);
  const ramp=await page.evaluate(()=>[0,9,10,12,99,100,999,1000].map(n=>getDynamicNodeColor(n,false)));
  for(const color of ramp)assert.match(color,/^#[0-9a-f]{6}$/i);
  assert.equal(ramp[2],'#10b981');assert.equal(ramp[5],'#eab308');console.log('VALID_ACTIVITY_COLORS',ramp);
  await page.waitForTimeout(800);await page.screenshot({path:'/tmp/native-ui-desktop.png'});
  await page.evaluate(()=>{switchDashMode('map');baseTileLayer.setOpacity(0.22);});
  await page.waitForTimeout(500);
  await page.evaluate(()=>{
   window.demoVisit=(i=0)=>({ip:'198.51.100.'+i,server_name:i%2?'Tokyo Edge':'Direct Access',location:'中国 · 上海',lat:30+i%12,lon:110+i%30,time:new Date().toISOString(),count:1,lang:'zh',target_domain:'demo.example'});
   for(let i=0;i<30;i++)queueLiveEvent(demoVisit(i));
  });
  await page.waitForFunction(()=>nodeMarkers['Direct Access'].getElement().dataset.active==='true');
  await page.waitForSelector('.flash-trigger',{state:'attached'});
  assert.equal(await page.locator('.flash-trigger').first().evaluate(el=>getComputedStyle(el).animationName),'silky-row-flash');
  const pulse=await page.evaluate(()=>({name:getComputedStyle(nodeMarkers['Direct Access'].getElement().querySelector('.node-pulse'),'::after').animationName,title:nodeMarkers['Direct Access'].getTooltip().getElement().querySelector('.bubble-title-b').textContent,color:nodeMarkers['Direct Access'].getElement().style.getPropertyValue('--node-color'),engine:window.TrajectoryPool.inspect().engine}));
  assert.equal(pulse.name,'cyber-pulse');assert.ok(pulse.title.startsWith('🔥'));assert.equal(pulse.color,'#f43f5e');assert.equal(pulse.engine,'WebGL2');console.log('RESTORED_PULSE',pulse);
  await page.waitForTimeout(300);await page.screenshot({path:'/tmp/native-ui-map.png'});
  const odometer=await page.evaluate(()=>{
   const el=document.createElement('div');el.className='odometer-bubble';el.dataset.current='0';el.dataset.val='100';document.body.appendChild(el);wakeOdometers();return true;
  });
  await page.waitForTimeout(100);
  const middle=await page.locator('body > .odometer-bubble').evaluate(el=>Number(el.textContent));assert.ok(middle>0&&middle<100);
  await page.waitForFunction(()=>document.querySelector('body > .odometer-bubble').dataset.current==='100' && odometerFrame===0);
  assert.equal(await page.evaluate(()=>odometerFrame),0);await page.locator('body > .odometer-bubble').evaluate(el=>el.remove());console.log('ODOMETER_FINISHES',middle,100);
  await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>window.TrajectoryPool);
  await page.evaluate(()=>{map.setView([25,90],1,{animate:false});baseTileLayer.setOpacity(.22);});
  await page.waitForFunction(()=>!baseTileLayer.isLoading(),{},{timeout:20000});
  await page.evaluate(()=>{
   queueLiveEvent({ip:'198.51.100.1',server_name:'Direct Access',location:'中国 · 上海',lat:31,lon:121,time:new Date().toISOString(),count:1,lang:'zh',target_domain:'demo.example'});
  });
  await page.waitForTimeout(500);
  const mobile=await page.evaluate(()=>({brand:document.querySelector('.mobile-brand').textContent,island:!!document.getElementById('web-island'),islandHandler:typeof window.triggerWebIsland,navButtons:document.querySelectorAll('.mobile-fab button').length,navGlass:getComputedStyle(document.querySelector('.mobile-fab')).backdropFilter,width:document.documentElement.scrollWidth}));
  assert.ok(mobile.brand.includes('NEXUS'));assert.equal(mobile.island,false);assert.equal(mobile.islandHandler,'undefined');assert.equal(mobile.navButtons,4);assert.notEqual(mobile.navGlass,'none');assert.ok(mobile.width<=390);console.log('MOBILE_NATIVE',mobile);
  await page.screenshot({path:'/tmp/native-ui-mobile.png'});
  await page.evaluate(()=>{toggleMobileDrawer(true);setDrawerY(getDrawerSnaps().full,true);});await page.waitForTimeout(500);
  assert.equal(await page.locator('.mobile-activity-btn').getAttribute('aria-current'),'page');
  await page.screenshot({path:'/tmp/native-ui-mobile-panel.png'});
  await page.evaluate(()=>toggleMobileDrawer(false));
  await page.waitForTimeout(550);
  assert.equal(await page.locator('[data-mobile-view=map]').getAttribute('aria-current'),'page');
  await page.evaluate(()=>setDrawerY(getDrawerSnaps().full,true));
  assert.ok(await page.locator('#scroll-container').evaluate(el=>el.clientHeight)>250);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.node-pulse').first().evaluate(el=>getComputedStyle(el,'::after').animationName),'none');
  assert.deepEqual(errors,[]);console.log('Native UI and effects regression passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
