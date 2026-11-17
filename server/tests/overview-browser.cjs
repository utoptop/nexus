require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Edge persistence, stable dialogs, visitor opacity, and lazy bounded 3D traffic.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message)});
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe&&window.TrajectoryPool);
 assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'idle');
 await page.evaluate(()=>{window.oldTooltip=nodeMarkers['Direct Access'].getTooltip().getElement();map.setView([-20,-60],5,{animate:false});refreshNodeLayout();});await page.waitForTimeout(150);
 const edge=await page.evaluate(()=>Object.entries(nodeMarkers).map(([name,m])=>({name,r:m.getTooltip().getElement().getBoundingClientRect().toJSON(),pinned:m.getTooltip().getElement().classList.contains('node-pinned'),present:map.hasLayer(m.getTooltip())})));
 assert.ok(edge.every(n=>n.present&&n.r.x>=0&&n.r.right<=1440&&n.r.y>=0&&n.r.bottom<=1000));assert.ok(edge.some(n=>n.pinned));assert.ok(await page.evaluate(()=>oldTooltip===nodeMarkers['Direct Access'].getTooltip().getElement()));console.log('PINNED_NODES',edge);
 await page.mouse.move(600,500);await page.mouse.down();await page.mouse.move(900,550,{steps:12});
 assert.ok(await page.evaluate(()=>Object.values(nodeMarkers).every(m=>{const r=m.getTooltip().getElement().getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight})));await page.mouse.up();
 await page.evaluate(()=>openSettings());const first=await page.locator('#settings-modal').boundingBox();
 for(const id of ['visuals','nodes','keys']){await page.evaluate(id=>switchTab(id),id);await page.waitForTimeout(80);assert.deepEqual(await page.locator('#settings-modal').boundingBox(),first);assert.equal(await page.locator('#'+id).evaluate(el=>getComputedStyle(el).animationName),'none');const content=await page.locator('#'+id).boundingBox();assert.ok(content.x>=first.x&&content.y>=first.y&&content.height>50);}
 assert.ok(first.y>=0&&first.y+first.height<=1000);await page.screenshot({path:out+'/silk-settings-desktop.png'});await page.keyboard.press('Escape');assert.ok(await page.locator('#settings-backdrop').isHidden());
 await page.evaluate(()=>toggleSidebar());await page.waitForTimeout(300);await page.locator('#visitor-options-button').click();await page.locator('#panel-opacity').fill('0.35');await page.locator('#visitor-opacity').fill('0.45');
 assert.match(await page.locator('#data-panel').evaluate(e=>getComputedStyle(e).backgroundColor),/0.35/);assert.equal(await page.evaluate(()=>currentVisitorOpacity),.45);
 await page.screenshot({path:out+'/silk-visitor-options.png'});
 await page.evaluate(()=>{
  switchDashMode('dashboard');showWorldView();
  window.demoCount=0;window.demoTicker=setInterval(()=>{
   const pts=[[31.2,121.4],[51.5,-.1],[40.7,-74],[1.3,103.8],[28.6,77.2],[-33.9,151.2],[37.7,-122.4],[48.8,2.3]];
   for(let i=0;i<8;i++)queueLiveEvent({ip:'demo-'+i,server_name:i%2?'Tokyo Edge':'Direct Access',location:'模拟访问 DEMO',lat:pts[i][0],lon:pts[i][1],time:new Date().toISOString(),count:1,lang:'zh',target_domain:'demo.example'});
  },100);
 });await page.waitForFunction(()=>TrafficGlobe.inspect().frames>12);
 const g=await page.evaluate(()=>TrafficGlobe.inspect());assert.equal(g.engine,'WebGL2');assert.ok(g.routes>=8&&g.routes<=g.routeLimit);assert.ok(g.pixels<=500000);assert.ok(g.bufferBytes<8e6);
 await page.waitForTimeout(200);assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().yaw))!==g.yaw);
 await page.screenshot({path:out+'/silk-globe-desktop.png'});
 // Check that actual geographic arcs remain finite even for antipodal positions.
 const arc=await page.evaluate(()=>TrafficGlobe.arc([0,0],[0,180]));assert.equal(arc.length,33);assert.ok(arc.flat().every(Number.isFinite));assert.ok(Math.hypot(...arc[16])>1.1);
 await page.locator('#globe-rotate').click();const yaw=await page.evaluate(()=>TrafficGlobe.inspect().yaw);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().yaw),yaw);
 const box=await page.locator('#traffic-globe').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+20,{steps:8});await page.mouse.up();assert.notEqual(await page.evaluate(()=>TrafficGlobe.inspect().yaw),yaw);
 await page.evaluate(()=>switchDashMode('map'));await page.waitForTimeout(100);const frames=await page.evaluate(()=>TrafficGlobe.inspect().frames);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().frames),frames);console.log('GLOBE_BUDGET_AND_SLEEP',g,frames);
 await page.screenshot({path:out+'/silk-map-desktop.png'});
 await page.evaluate(()=>{switchDashMode('dashboard');window.globeGL=document.getElementById('traffic-globe').getContext('webgl2');window.globeLoss=globeGL.getExtension('WEBGL_lose_context');globeLoss.loseContext();});await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'Canvas');await page.screenshot({path:out+'/silk-globe-fallback.png'});
 await page.evaluate(()=>globeLoss.restoreContext());await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'WebGL2');await page.evaluate(()=>clearInterval(demoTicker));
 await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe);
 assert.equal(await page.evaluate(()=>currentVisitorOpacity),.45);assert.equal(await page.locator('#panel-opacity').inputValue(),'0.35');
 await page.locator('.mobile-fab [aria-label="Overview"]').click();await page.waitForFunction(()=>TrafficGlobe.inspect().frames>3);await page.screenshot({path:out+'/silk-globe-mobile.png'});
 const mobile=await page.locator('#cyber-dashboard').boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=390&&mobile.y>=0&&mobile.y+mobile.height<=844);
 await page.evaluate(()=>openSettings());const m=await page.locator('#settings-modal').boundingBox();await page.evaluate(()=>switchTab('visuals'));assert.deepEqual(await page.locator('#settings-modal').boundingBox(),m);assert.ok(m.y+m.height<=844);await page.screenshot({path:out+'/silk-settings-mobile.png'});await page.evaluate(()=>closeSettings());
 await page.locator('.mobile-fab [aria-label="Map"]').click();await page.locator('.mobile-activity-btn').click();await page.waitForTimeout(300);await page.locator('#visitor-options-button').click();const pop=await page.locator('#visitor-options').boundingBox();assert.ok(pop.x>=0&&pop.x+pop.width<=390&&pop.y>=0&&pop.y+pop.height<=754);await page.screenshot({path:out+'/silk-visitor-mobile.png'});
 assert.deepEqual(errors,[]);console.log('Overview, edges, opacity and stable settings passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
