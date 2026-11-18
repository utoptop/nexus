// Generate render_dashboard_fixture first. Exercises filter, scrolling and replay in the real globe.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out=process.env.GLOBE_ARTIFACT_DIR||'/tmp/nexus-artifacts';fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN'}),page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});page.on('dialog',d=>d.dismiss());
  const now=Date.now(),domains=['logger.example.test','HTTPS://PROXY.EXAMPLE.TEST.:443/admin','127.0.0.1:4173','logger.example.test.business.test','api.logger.example.test','shop.example.test','<img src=x onerror=alert(1)>'];
  const rows=Array.from({length:260},(_,i)=>['198.51.100.'+i,'测试位置 '+i,1,new Date(now-i*1000).toISOString(),'zh',20+i%40,30+i%90,'Direct Access',domains[i%domains.length]]);
  const history=Array.from({length:600},(_,i)=>[20+i%40,30+i%90,'测试位置 '+i,'Direct Access','203.0.113.'+i,new Date(now-600000+i*1000).toISOString(),domains[i%domains.length]]);
  const isSelf=value=>{try{return ['logger.example.test','proxy.example.test','127.0.0.1'].includes(new URL(value.includes('://')?value:'http://'+value).hostname.toLowerCase().replace(/\.$/,''));}catch{return false;}};
  let failure=false;
  await page.route('http://127.0.0.1:4173/**',route=>{
   const u=new URL(route.request().url());
   if(u.pathname.endsWith('/api/data')){requests.push(u.href);const stats=rows.filter(r=>!u.searchParams.has('hide_nexus')||!isSelf(r[8]));return route.fulfill({json:{stats,history:stats.map(s=>[s[5],s[6],s[1],s[7],s[0],s[3],s[8]]),heatmap:[[new Date(now).toISOString(),stats.length]]}});}
   if(u.pathname.endsWith('/api/playback')){requests.push(u.href);return failure?route.fulfill({status:503,json:{error:'test unavailable'}}):route.fulfill({json:u.searchParams.get('days')==='0'?[]:history.filter(h=>!u.searchParams.has('hide_nexus')||!isSelf(h[6]))});}
   return route.fulfill({contentType:'text/html',body:fs.readFileSync(process.env.DASHBOARD_FIXTURE_PATH||'/tmp/observatory-preview.html','utf8')});
  });await page.routeWebSocket('**/ws',()=>{});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.TrafficGlobe);
  await page.evaluate(async()=>{await applyFilters(true);switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});
  await page.waitForFunction(()=>document.querySelectorAll('.globe-visitor-row').length>0);
  assert.ok(await page.locator('#globe-pane-visitors').isVisible());
  assert.ok(await page.locator('.globe-visitor-row').count()<12);
  assert.equal(await page.locator('.globe-visitor-content img').count(),0);
  const scroll=page.locator('#globe-visitor-list');
  await scroll.evaluate(el=>el.scrollTop=88*100);await page.waitForTimeout(150);
  const anchor=await page.evaluate(()=>document.querySelector('.globe-visitor-row[data-index="100"] .globe-visitor-ip').textContent);
  await page.evaluate(()=>queueLiveEvent({ip:'new-business-visit',location:'上海',server_name:'Direct Access',target_domain:'shop.example.test',time:new Date().toISOString(),lang:'zh',lat:31,lon:121,count:1}));
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>document.querySelector('.globe-visitor-row[data-index="'+Math.floor(document.getElementById('globe-visitor-list').scrollTop/88)+'"] .globe-visitor-ip').textContent),anchor);
  await scroll.evaluate(el=>el.scrollTop=0);
  await page.locator('#globe-hide-nexus').check();
  await page.waitForFunction(()=>!Array.from(statsMap.values()).some(s=>s[8]==='logger.example.test'));
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#hide-nexus-visitors').isChecked(),true);
  assert.ok(requests.some(u=>u.includes('hide_nexus=true')&&u.includes('nexus_host=127.0.0.1')));
  const baseline=await page.evaluate(()=>nodeHits['Direct Access']);
  await page.evaluate(()=>{for(const target_domain of ['logger.example.test','https://PROXY.EXAMPLE.TEST.:443/admin','127.0.0.1:4173'])queueLiveEvent({ip:'hidden-live',server_name:'Direct Access',target_domain,time:new Date().toISOString(),lat:31,lon:121,count:1});});
  await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>nodeHits['Direct Access']),baseline);
  assert.ok(await page.evaluate(()=>Array.from(statsMap.values()).some(s=>s[8]==='api.logger.example.test')));
  await page.screenshot({path:out+'/globe-visitors-desktop.png'});
  await page.locator('#globe-replay-range').selectOption('1');await page.locator('#globe-replay-start').click();
  await page.waitForFunction(()=>pbState.active&&pbState.index>0);
  assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().expanded),true);
  assert.equal(await page.locator('#playback-ctrl').evaluate(e=>e.parentElement.id),'globe-card');
  assert.equal(await page.locator('#pb-play-btn').evaluate(e=>Boolean(e.closest('[inert]'))),false);
  await page.locator('#pb-play-btn').click();const paused=await page.evaluate(()=>pbState.index);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>pbState.index),paused);
  await page.locator('#pb-speed').selectOption('2');await page.locator('#pb-play-btn').click();await page.waitForTimeout(220);assert.ok(await page.evaluate(n=>pbState.index>n+20,paused));
  const expected=history.filter(h=>!isSelf(h[6])).length;
  await page.evaluate(()=>{if(pbState.playing)togglePlayPause();seekPlayback(pbState.hist.length-1);});
  await page.waitForFunction(()=>pbState.seekTarget===null&&pbState.index===pbState.hist.length);
  assert.equal(await page.evaluate(()=>Object.values(nodeHits).reduce((a,b)=>a+b,0)),expected);
  await page.evaluate(()=>seekPlayback(20));await page.waitForFunction(()=>pbState.seekTarget===null&&pbState.index===21);
  assert.equal(await page.evaluate(()=>Object.values(nodeHits).reduce((a,b)=>a+b,0)),21);
  await page.locator('#globe-back-map').click();
  assert.equal(await page.evaluate(()=>pbState.index),21);assert.equal(await page.evaluate(()=>pbState.active),true);
  assert.notEqual(await page.locator('#playback-ctrl').evaluate(e=>e.parentElement.id),'globe-card');
  await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});
  assert.equal(await page.evaluate(()=>pbState.index),21);
  await page.screenshot({path:out+'/globe-replay-desktop.png'});
  await page.locator('#playback-ctrl .danger-btn').click();await page.waitForFunction(()=>!pbState.active&&statsMap.size>100);
  await page.locator('#globe-hide-nexus').uncheck();await page.waitForFunction(()=>Array.from(statsMap.values()).some(s=>s[8]==='logger.example.test'));
  await page.locator('#globe-hide-nexus').check();
  // Empty and failed playback must release loading state and restore live data.
  await page.locator('#globe-replay-range').selectOption('0');await page.locator('#globe-replay-start').click();await page.waitForFunction(()=>!pbState.active&&!pbState.loading&&statsMap.size>100);
  failure=true;await page.locator('#globe-replay-range').selectOption('1');await page.locator('#globe-replay-start').click();await page.waitForFunction(()=>!pbState.active&&!pbState.loading&&statsMap.size>100);failure=false;
  for(const [width,height] of [[390,844],[844,390]]){
   await page.setViewportSize({width,height});await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.TrafficGlobe&&!dataRequest?.signal.aborted&&statsMap.size>100);
   await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});await page.waitForTimeout(300);
   assert.equal(await page.locator('#globe-hide-nexus').isChecked(),true);
   await page.locator('#globe-replay-start').click();await page.waitForFunction(()=>pbState.active&&pbState.index>=3);await page.locator('#pb-play-btn').click();await page.waitForTimeout(300);
   for(const selector of ['#globe-data-panel','#playback-ctrl','.globe-view-controls']){const b=await page.locator(selector).boundingBox();assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=width+1&&b.y+b.height<=height+1,selector+JSON.stringify(b));}
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:out+`/globe-replay-${width===390?'mobile':'landscape'}.png`});
   await page.locator('#playback-ctrl .danger-btn').click();await page.waitForFunction(()=>!pbState.active);
  }
  assert.deepEqual(errors,[]);console.log('PASS: Nexus-domain filter and persistence, bounded scroll with stable anchor, escaped details, globe replay/pause/speed/seek/stop, empty/error recovery, portrait and landscape controls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
