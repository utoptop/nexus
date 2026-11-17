// Full viewport interaction, offshore labels and actual historical canvas pixels.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(600);
 const initial=await page.evaluate(()=>({size:map.getSize(),overview:document.body.classList.contains('show-dashboard'),drag:map.dragging.enabled(),wheel:map.scrollWheelZoom.enabled(),touch:map.touchZoom.enabled()}));
 assert.deepEqual(initial,{size:{x:1440,y:1000},overview:false,drag:true,wheel:true,touch:true});
 await page.locator('[aria-label="Zoom in"]').click();await page.waitForTimeout(300);const zoom=await page.evaluate(()=>map.getZoom());
 await page.mouse.move(650,400);await page.mouse.down();await page.mouse.move(820,440,{steps:12});await page.mouse.up();await page.waitForTimeout(800);
 const pan=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()}));assert.equal(pan.zoom,zoom);
 await page.evaluate(()=>{trueNodesMap['Direct Access']=[37.77,-122.42];trueNodesMap['US-MATRIX']=[37.33,-121.89];trueNodesMap['DM-proxy']=[34.05,-118.24];map.setView([32,-128],4,{animate:false});refreshNodeLayout();});
 const offshore=await page.evaluate(()=>{
  const coast=Coastline.mask(map);return ['Direct Access','US-MATRIX','DM-proxy'].map(name=>{const marker=nodeMarkers[name],rect=marker.getTooltip().getElement().getBoundingClientRect(),p=map.latLngToContainerPoint(displayNodesMap[name]);return{name,x:p.x,y:p.y,w:rect.width,h:rect.height,sea:coast.isSeaBox(p.x,p.y,rect.width,rect.height),leader:window.nodeElbowLines[name].getLatLngs().map(p=>[p.lat,p.lng]),true:trueNodesMap[name]};});
 });assert.ok(offshore.every(n=>n.sea));assert.ok(offshore.every(n=>n.w===138&&n.h===46));
 assert.equal(new Set(offshore.map(n=>n.x)).size,1);const sorted=offshore.slice().sort((a,b)=>a.y-b.y);for(let i=1;i<sorted.length;i++)assert.ok(sorted[i].y-sorted[i-1].y>=61.9);for(const n of offshore)assert.deepEqual(n.leader[0],n.true);
 console.log('OFFSHORE_ALIGNED',offshore.map(n=>({name:n.name,x:n.x,y:n.y,sea:n.sea})));
 await page.evaluate(()=>{TrajectoryPool.clear();TrajectoryPool.clearHistory();TrajectoryPool.setHistoryVisible(true);window.currentResBright=3.5;TrajectoryPool.addHistory([20,-145],[37.77,-122.42],'Direct Access','#ff0000');});await page.waitForTimeout(300);
 const historical=await page.evaluate(()=>{
  const c=document.querySelector('.traffic-history'),ctx=c.getContext('2d'),d=ctx.getImageData(0,0,c.width,c.height).data;let pixels=0,gray=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>25){pixels++;if(d[i+2]>d[i]&&Math.abs(d[i+1]-d[i])<15)gray++;}
  const a=map.latLngToContainerPoint([20,-145]),b=map.latLngToContainerPoint([37.77,-122.42]),scale=c.width/map.getSize().x;let solid=0;
  for(let i=1;i<50;i++){let hit=false,x=Math.round((a.x+(b.x-a.x)*i/50)*scale),y=Math.round((a.y+(b.y-a.y)*i/50)*scale);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(d[((y+dy)*c.width+x+dx)*4+3]>0)hit=true;if(hit)solid++;}
  return{pixels,gray,solid};
 });assert.ok(historical.pixels>50);assert.ok(historical.gray/historical.pixels>.95);assert.ok(historical.solid>=47);console.log('GRAY_SOLID_HISTORY',historical);
 // Overlay menus never resize/recenter the map and all dock actions remain reachable.
 const before=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),size:map.getSize()}));
 await page.locator('#nav-btn-dash').click();await page.waitForTimeout(300);assert.ok(await page.locator('#cyber-dashboard').isVisible());
 assert.deepEqual(await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),size:map.getSize()})),before);
 await page.locator('#menu-toggle-btn').click();await page.waitForTimeout(300);assert.equal(await page.locator('#menu-toggle-btn').getAttribute('aria-expanded'),'true');
 await page.locator('#right-menu [aria-label="Close display options"]').click();await page.waitForTimeout(300);assert.equal(await page.locator('#menu-toggle-btn').getAttribute('aria-expanded'),'false');
 await page.locator('.map-dock .sidebar-btn').click();await page.waitForTimeout(300);assert.ok(await page.locator('#data-panel').isVisible());assert.ok(await page.locator('#scroll-container').evaluate(e=>e.clientHeight)>300);
 for(const viewport of [{width:390,height:844},{width:844,height:390}]){
  await page.setViewportSize(viewport);await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(()=>map.getSize()),{x:viewport.width,y:viewport.height});assert.ok(await page.locator('.mobile-fab').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth)<=viewport.width);
  if(viewport.width===390){
   assert.equal(await page.evaluate(()=>nodeOverflowCards.size),0);assert.equal(await page.locator('.leaflet-tooltip.node-bubble').count(),2);
   const leaders=await page.evaluate(()=>Object.keys(trueNodesMap).map(name=>{const p=window.nodeElbowLines[name].getLatLngs(),label=displayNodesMap[name];return{start:map.latLngToContainerPoint(p[0]),sea:map.latLngToContainerPoint(p[1]),label:map.latLngToContainerPoint(label)};}));
   for(const n of leaders)assert.ok((n.sea.x-n.start.x)*(n.label.x-n.start.x)+(n.sea.y-n.start.y)*(n.label.y-n.start.y)>0,'The first leader segment must point toward the offshore label.');
  }
  await page.locator('.mobile-fab [aria-controls="right-menu"]').click();await page.waitForTimeout(300);const box=await page.locator('#right-menu').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=viewport.width);assert.ok(box.y>=0&&box.y+box.height<=viewport.height);assert.equal(await page.locator('.mobile-fab [aria-controls="right-menu"]').getAttribute('aria-expanded'),'true');
 }
 assert.deepEqual(errors,[]);console.log('Immersive viewport, offshore placement, gray history and menus passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
