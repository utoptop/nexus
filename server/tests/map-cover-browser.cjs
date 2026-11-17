// Regression for blank map margins and labels drifting to distant oceans.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(600);
async function covered(label){
 const b=await page.evaluate(()=>({view:map.getPixelBounds(),world:map.getPixelWorldBounds(),zoom:map.getZoom(),min:map.getMinZoom(),size:map.getSize()}));
 for(const axis of ['x','y']){
  if(b.world.max[axis]-b.world.min[axis]>=b.size[axis]){assert.ok(b.view.min[axis]>=b.world.min[axis]-1.1,JSON.stringify({label,b}));assert.ok(b.view.max[axis]<=b.world.max[axis]+1.1,JSON.stringify({label,b}));}
  else {assert.ok(b.world.min[axis]>=b.view.min[axis]&&b.world.max[axis]<=b.view.max[axis],JSON.stringify({label,b}));assert.ok(Math.abs((b.view.min[axis]+b.view.max[axis])-(b.world.min[axis]+b.world.max[axis]))<2,JSON.stringify({label,b}));}
 }
 assert.ok(b.zoom>=b.min);console.log('COVERS',label,b.size,b.zoom);
}
await covered('initial');
for(const [w,h] of [[1920,1080],[3440,1440],[1024,768],[844,390],[390,844],[1440,900]]){
 await page.setViewportSize({width:w,height:h});await page.waitForTimeout(300);await covered('resize');
 await page.evaluate(()=>showWorldView());await covered('world button');
 await page.evaluate(()=>map.setZoom(-10,{animate:false}));await covered('minimum zoom');
 for(const p of [[10000,10000],[-10000,-10000]]){await page.evaluate(p=>map.panBy(p,{animate:false}),p);await page.waitForTimeout(100);await covered('pan boundary');}
}
await page.evaluate(()=>{map.setView([20,0],TrafficRuntime.coverZoom(innerWidth,innerHeight),{animate:false});trueNodesMap['Direct Access']=[37.77,-122.42];trueNodesMap['US-MATRIX']=[37.33,-121.89];trueNodesMap['DM-proxy']=[34.05,-118.24];trueNodesMap['ASIA-HK']=[22.28,114.17];refreshNodeLayout();});
async function labels(limit){
 const data=await page.evaluate(()=>Object.entries(nodeMarkers).filter(([n,m])=>m.isTooltipOpen()).map(([name,m])=>{
  const tip=m.getTooltip().getElement().getBoundingClientRect(),anchor=map.latLngToContainerPoint(displayNodesMap[name]);
  const pts=window.nodeElbowLines[name].getLatLngs().map(p=>map.latLngToContainerPoint(p));
  return{name,tip:tip.toJSON(),x:anchor.x,sea:Coastline.mask(map).landFraction(anchor.x,anchor.y,tip.width,tip.height),length:pts.slice(1).reduce((s,p,i)=>s+Math.hypot(p.x-pts[i].x,p.y-pts[i].y),0)};
 }));
 assert.ok(data.length>0);
 for(const a of data){assert.ok(a.length<=limit+3,JSON.stringify(a));assert.ok(a.sea<=.01+.0001,JSON.stringify(a));for(const b of data)if(a!==b)assert.ok(a.tip.right+10<=b.tip.x||b.tip.right+10<=a.tip.x||a.tip.bottom+10<=b.tip.y||b.tip.bottom+10<=a.tip.y);}
 console.log('SHORT_OFFSHORE_LABELS',data.map(n=>({name:n.name,length:n.length,x:n.x})));return data;
}
const desktop=await labels(112);const west=desktop.filter(n=>['Direct Access','US-MATRIX','DM-proxy'].includes(n.name));assert.equal(west.length,3);assert.equal(new Set(west.map(n=>n.x)).size,1);
// Layout never redirects the actual visitor path to the offshore label.
await page.evaluate(()=>TrajectoryPool.fireLine([31.23,121.47],getTruePos('Direct Access'),'#06b6d4',1,'Direct Access'));
const endpoint=await page.evaluate(()=>({end:TrajectoryPool.inspectGeometry('Direct Access')[0].b,real:map.latLngToContainerPoint(trueNodesMap['Direct Access'])}));assert.deepEqual(endpoint.end,endpoint.real);
await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(600);await covered('mobile initial');assert.equal(await page.evaluate(()=>nodeOverflowCards.size),0);const mobile=await labels(96);assert.equal(mobile.length,2);
assert.deepEqual(errors,[]);console.log('Map coverage and near-coast label regressions passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
