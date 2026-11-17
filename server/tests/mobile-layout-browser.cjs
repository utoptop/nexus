require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Mobile navigation, live ingestion without the island, sheets, touch scrolling and rotation.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const record=!!process.env.RECORD_MOBILE,context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',...(record?{recordVideo:{dir:'/tmp/mobile-redesign-video',size:{width:390,height:844}}}:{})});try{
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message)});
 const history=Array.from({length:300},(_,i)=>[25+i%12,100+i%30,'模拟访问','Direct Access','198.51.100.'+(i%200),new Date(Date.UTC(2026,10,16)+i*1000).toISOString(),'demo.example']);
 await page.route('http://127.0.0.1:4173/**',r=>{const u=r.request().url();return u.includes('/api/playback')?r.fulfill({json:history}):u.includes('/api/data')?r.fulfill({json:{stats:[],history:[],heatmap:[]}}):r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')});});await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrajectoryPool&&window.mobileChromeInsets);
 assert.equal(await page.locator('#web-island,.island-btn').count(),0);assert.equal(await page.evaluate(()=>typeof window.triggerWebIsland),'undefined');
 assert.equal(await page.locator('.mobile-fab button').count(),4);assert.equal(await page.locator('[data-mobile-view=map]').getAttribute('aria-current'),'page');
 await page.evaluate(()=>{window.demo=setInterval(()=>{for(let i=0;i<4;i++)queueLiveEvent({ip:'198.51.100.'+i,server_name:i%2?'Tokyo Edge':'Direct Access',location:'模拟访问',lat:26+i*3,lon:100+i*9,count:1,time:new Date().toISOString(),lang:'zh',target_domain:'demo.example'});},180);const note=document.createElement('small');note.id='mobile-demo-note';note.textContent='DEMO · 模拟访问';note.style.cssText='position:fixed;left:18px;bottom:92px;font:9px monospace;color:#64748b;z-index:8002;pointer-events:none';document.body.appendChild(note);});
 await page.waitForFunction(()=>TrajectoryPool.inspect().admitted>=12);await page.screenshot({path:out+'/mobile-redesign-map.png'});
 const camera=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()}));
 await page.locator('.mobile-activity-btn').click();await page.waitForTimeout(450);assert.equal(await page.locator('.mobile-activity-btn').getAttribute('aria-current'),'page');assert.equal(await page.locator('#data-panel').evaluate(e=>e.inert),false);
 await page.locator('[aria-label="Expand visitor panel"]').click();await page.waitForTimeout(450);assert.ok(await page.locator('#scroll-container').evaluate(e=>e.clientHeight)>250);
 const controls=await page.locator('#data-panel .title-group>div').boundingBox();assert.ok(controls.x>=0&&controls.x+controls.width<=390);
 await page.locator('#visitor-options-button').click();const opacity=await page.locator('#visitor-options').boundingBox();assert.ok(opacity.y>=0&&opacity.y+opacity.height<=mobileBottom());await page.locator('#visitor-options-button').click();
 function mobileBottom(){return 756;}
 const touch=await context.newCDPSession(page);await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:650}]});for(let y=620;y>=360;y-=30){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y}]});await page.waitForTimeout(20);}await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(150);assert.ok(await page.locator('#scroll-container').evaluate(e=>e.scrollTop)>100);
 await page.screenshot({path:out+'/mobile-redesign-visitors.png'});
 await page.locator('[aria-label="Close visitor panel"]').click();await page.waitForTimeout(400);assert.equal(await page.locator('#data-panel').evaluate(e=>e.inert),true);
 await page.locator('.mobile-fab [aria-label="Overview"]').click();await page.waitForTimeout(400);assert.equal(await page.locator('[data-mobile-view=overview]').getAttribute('aria-current'),'page');await page.screenshot({path:out+'/mobile-redesign-overview.png'});
 await page.locator('.mobile-fab [aria-label="More"]').click();await page.waitForTimeout(350);assert.ok(await page.locator('#right-menu').isVisible());assert.equal(await page.locator('[data-mobile-view=more]').getAttribute('aria-current'),'page');assert.equal(await page.evaluate(()=>document.body.classList.contains('show-dashboard')),false);await page.screenshot({path:out+'/mobile-redesign-tools.png'});
 await page.locator('[aria-label="Node settings"]').click();assert.equal(await page.locator('#nodes').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.dataset.mobileView),'more');
 await page.locator('.mobile-fab [aria-label="More"]').click();await page.locator('#right-menu [aria-label="Playback"]').click();await page.waitForFunction(()=>pbState.active);assert.equal(await page.locator('#right-menu').evaluate(e=>e.classList.contains('open')),false);const pb=await page.locator('#playback-ctrl').boundingBox();assert.ok(pb.x>=0&&pb.x+pb.width<=390&&pb.y+pb.height<=756);await page.evaluate(()=>stopPlayback());
 await page.evaluate(()=>{clearInterval(demo);document.getElementById('mobile-demo-note').remove();});
 assert.deepEqual(await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()})),camera);
 // Rotate the same session, keeping the expanded visitor state and all controls usable.
 await page.locator('.mobile-activity-btn').click();await page.locator('[aria-label="Expand visitor panel"]').click();await page.waitForTimeout(400);await page.setViewportSize({width:844,height:390});await page.waitForTimeout(450);
 const nav=await page.locator('.mobile-fab').boundingBox(),sheet=await page.locator('#data-panel').boundingBox();assert.ok(nav.height>nav.width&&sheet.x+sheet.width<nav.x);assert.ok(sheet.y>=0&&sheet.y+sheet.height<=390);
 await page.locator('#visitor-options-button').click();const landscapeOpacity=await page.locator('#visitor-options').boundingBox();assert.ok(landscapeOpacity.y>=0&&landscapeOpacity.y+landscapeOpacity.height<=390);await page.locator('#visitor-options-button').click();await page.screenshot({path:out+'/mobile-redesign-landscape.png'});
 await page.locator('.mobile-fab [aria-label="Overview"]').click();await page.waitForTimeout(300);await page.locator('#globe-expand').click();await page.waitForFunction(()=>TrafficGlobe.inspect().expanded);await page.locator('#globe-back-map').click();
 await page.setViewportSize({width:320,height:740});await page.waitForTimeout(350);await page.locator('.mobile-fab [aria-label="More"]').click();await page.waitForTimeout(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const menu=await page.locator('#right-menu').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=320&&menu.y>=0&&menu.y+menu.height<=740);
 await page.screenshot({path:out+'/mobile-redesign-small.png'});assert.equal(await page.locator('#web-island').count(),0);assert.deepEqual(errors,[]);
 console.log('Mobile redesign: no island, four destinations, touch scroll, settings, playback, rotation, small screens and globe passed');
 if(record){const video=page.video();await page.close();await video.saveAs(out+'/mobile-redesign-session.webm');}
}finally{await context.close();await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
