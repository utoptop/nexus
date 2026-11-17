require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Real event ingestion, first visible frame, bounded edge data and responsive menus.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForFunction(()=>window.TrafficGlobe);
 assert.ok(await page.evaluate(()=>TrajectoryPool.snapshotTraffic().every(r=>r.energy===0&&r.age>3200)),'loading history must never produce a live access flash');
 await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);TrajectoryPool.clear();TrajectoryPool.clearHistory();
  window.visit=n=>queueLiveEvent({ip:'hud-test',server_name:'Direct Access',location:'模拟访问',lat:27,lon:90,time:new Date().toISOString(),count:n,lang:'zh',target_domain:'demo.example'});
 });await page.waitForFunction(()=>TrafficGlobe.inspect().lights===2&&TrafficGlobe.inspect().frames>5);
 const baseline=await page.evaluate(()=>Object.values(nodeHits).reduce((a,b)=>a+b,0));
 await page.evaluate(()=>{
  const gl=document.getElementById('traffic-globe').getContext('webgl2'),draw=gl.drawArrays.bind(gl);
  gl.drawArrays=function(...args){draw(...args);const light=TrafficGlobe.inspectLight([27,90]);if(args[0]===gl.POINTS&&light?.hits===1){window.firstLightAge=performance.now()-light.at;gl.drawArrays=draw;}};
  visit(1);
 });await page.waitForFunction(()=>Number.isFinite(window.firstLightAge));const latency=await page.evaluate(()=>firstLightAge);assert.ok(latency<100,'a light should reach a frame without the old 125 ms polling delay');
 await page.waitForFunction(()=>TrafficGlobe.inspect().metrics.rate===.2);
 await page.evaluate(()=>visit(250));await page.waitForFunction(()=>TrafficGlobe.inspect().metrics.rate===50.2);
 let metrics=await page.evaluate(()=>TrafficGlobe.inspect().metrics);assert.equal(metrics.total,baseline+251);assert.equal(metrics.origins,1);assert.equal(metrics.nodes,1);
 assert.equal(await page.locator('[data-metric="rate"]').getAttribute('data-value'),'50.2');
 assert.ok((await page.locator('.globe-trend-line').getAttribute('d')).includes('L'));
 const before=await page.evaluate(()=>TrafficGlobe.inspect().hudUpdates);await page.waitForTimeout(1000);assert.ok(await page.evaluate(n=>TrafficGlobe.inspect().hudUpdates-n,before)<=5);
 await page.locator('#globe-tab-nodes').click();assert.equal(await page.locator('#globe-pane-nodes').isVisible(),true);assert.equal(await page.locator('#globe-pane-traffic').isVisible(),false);
 assert.equal(await page.locator('.globe-hot-node span').first().textContent(),'Direct Access');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#globe-tab-traffic').getAttribute('aria-selected'),'true');
 await page.screenshot({path:out+'/realtime-data-desktop.png'});
 await page.locator('#globe-data-toggle').click();const hiddenUpdates=await page.evaluate(()=>TrafficGlobe.inspect().hudUpdates);await page.evaluate(()=>visit(10));await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().hudUpdates),hiddenUpdates);
 await page.locator('#globe-data-toggle').click();await page.waitForFunction(total=>TrafficGlobe.inspect().metrics.total===total,baseline+261);
 await page.waitForTimeout(5100);await page.waitForFunction(()=>TrafficGlobe.inspect().metrics.rate===0);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().metrics.nodes),0);
 console.log('FIRST_VISIBLE_LIGHT_MS',latency,'EXACT_EDGE_METRICS',metrics);
 for(const [width,height] of [[390,844],[844,390]]){
  await page.setViewportSize({width,height});await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.TrafficGlobe);
  await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});await page.waitForTimeout(250);
  const boxes=await page.locator('#globe-data-panel,.globe-view-controls').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().toJSON()));for(const b of boxes)assert.ok(b.x>=0&&b.right<=width&&b.y>=0&&b.bottom<=height);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#globe-tab-nodes').click();assert.equal(await page.locator('#globe-pane-nodes').isVisible(),true);await page.locator('#globe-tab-traffic').click();
  await page.screenshot({path:out+`/realtime-data-${width===390?'mobile':'landscape'}.png`});
 }
 assert.deepEqual(errors,[]);console.log('Immediate visitor lights, live data, bounded updates, idle decay and mobile menus passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
