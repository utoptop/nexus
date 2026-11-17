require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Full viewport, truthful bounded aggregates, rendering suspension, and responsive navigation.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.OverviewDashboard);
 assert.equal(await page.evaluate(()=>typeof dashPieChart),'undefined');
 const camera=await page.evaluate(()=>({c:map.getCenter(),z:map.getZoom()}));
 await page.locator('#nav-btn-dash').click();await page.waitForFunction(()=>TrafficGlobe.inspect().frames>2);
 assert.deepEqual(await page.locator('#cyber-dashboard').boundingBox(),{x:0,y:0,width:1440,height:1000});
 const initialHeat=await page.evaluate(()=>dashBarChart.data.datasets[0].data.reduce((s,n)=>s+n,0));assert.equal(initialHeat,420);
 await page.evaluate(()=>{
  resetPlaybackData();
  for(let i=0;i<6001;i++)ingestVisitor({ip:'summary-'+i,location:i===6000?'末尾来源':'来源 '+i%7,server_name:i%2?'Tokyo Edge':'Direct Access',lat:25+i%8,lon:100+i%20,time:new Date().toISOString(),count:i===6000?7000:1,lang:'zh',target_domain:i===6000?'tail.example':'api.example'},false);
  lastDashboardUpdate=-1000;updateDashboard();
 });
 const data=await page.evaluate(()=>({overview:OverviewDashboard.inspect(),total:document.getElementById('kpi-total').textContent,regions:dashPieChart.data.labels,regionCounts:dashPieChart.data.datasets[0].data,heat:dashBarChart.data.datasets[0].data,rate:document.getElementById('kpi-rate').textContent}));
 assert.equal(data.overview.cacheEntries,6000);assert.equal(data.overview.cachedVisits,12999);assert.equal(data.overview.regionTotal,12999);assert.equal(data.total,'13,000');assert.equal(data.regions[0],'末尾来源');assert.equal(data.regionCounts[0],7000);assert.equal(data.rate,'0');assert.equal(data.heat.length,24);assert.equal(data.heat.filter(Boolean).length,1);assert.equal(data.heat.reduce((s,n)=>s+n,0),13000);
 // Real visits continue processing while the flat map and its DOM updates are suspended.
 const rasters=await page.evaluate(()=>TrajectoryPool.inspect().rasterFrames);
 await page.evaluate(()=>queueLiveEvent({ip:'live',location:'实时来源',server_name:'Tokyo Edge',lat:40,lon:115,time:new Date().toISOString(),count:37,lang:'zh',target_domain:'live.example'}));await page.waitForFunction(()=>TrajectoryPool.inspect().represented===37);
 await page.evaluate(()=>{lastDashboardUpdate=-1000;updateDashboard();});
 assert.equal(await page.locator('#kpi-rate').textContent(),'7.4');assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().rasterFrames),rasters);
 assert.equal(await page.evaluate(()=>pendingVisitorUpdates.size),1);assert.ok(await page.locator('.overview-rank-name[data-active=true]').count()>0);
 const aggregation=await page.evaluate(()=>OverviewDashboard.inspect().aggregations);await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>OverviewDashboard.inspect().aggregations),aggregation);
 // Fullscreen and settings preserve the overview; Escape from the globe returns one level.
 await page.locator('#immersive-toggle').click();await page.waitForFunction(()=>!!document.fullscreenElement);await page.locator('#immersive-toggle').click();await page.waitForFunction(()=>!document.fullscreenElement);
 await page.locator('[aria-label="Overview settings"]').click();await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.body.classList.contains('show-dashboard')),true);
 await page.locator('#globe-expand').click();await page.waitForFunction(()=>TrafficGlobe.inspect().expanded);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.body.classList.contains('show-dashboard')),true);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().expanded),false);
 await page.locator('#overview-back').click();await page.waitForFunction(()=>!TrajectoryPool.inspect().occluded&&pendingVisitorUpdates.size===0);assert.equal(await page.locator('#map-container').evaluate(e=>e.inert),false);assert.deepEqual(await page.evaluate(()=>({c:map.getCenter(),z:map.getZoom()})),camera);
 const updates=await page.evaluate(()=>OverviewDashboard.inspect().updates);await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>OverviewDashboard.inspect().updates),updates);
 await page.evaluate(()=>applyFilters(false));assert.equal(await page.evaluate(()=>Object.values(nodeHits).reduce((s,n)=>s+n,0)),13037);
 console.log('AGGREGATES_AND_RENDER_SLEEP',data.overview,'rate',7.4,'total',13037);
 for(const [w,h] of [[390,844],[844,390],[320,740]]){
  await page.setViewportSize({width:w,height:h});await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.OverviewDashboard);await page.locator('[data-mobile-view=overview]').click();await page.waitForTimeout(1200);
  assert.deepEqual(await page.locator('#cyber-dashboard').boundingBox(),{x:0,y:0,width:w,height:h});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#overview-target-list').scrollIntoViewIfNeeded();const rect=await page.locator('#overview-target-list').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=w&&rect.y>=0&&rect.y+rect.height<=h);
  await page.screenshot({path:out+`/immersive-overview-data-${w}.png`});
  const f=await page.evaluate(()=>TrafficGlobe.inspect().frames);await page.waitForTimeout(250);if(w<769&&h>500)assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().frames),f);
  await page.locator('#cyber-dashboard').evaluate(e=>e.scrollTo(0,0));await page.waitForTimeout(200);await page.screenshot({path:out+`/immersive-overview-${w}.png`});
  await page.locator('[data-mobile-view=map]').click();await page.waitForFunction(()=>!TrajectoryPool.inspect().occluded);assert.equal(await page.locator('#map-container').evaluate(e=>e.inert),false);
 }
 assert.deepEqual(errors,[]);console.log('Immersive overview: fullscreen, charts, cache eviction, idle aggregation, settings, camera, mobile, landscape and small screens passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
