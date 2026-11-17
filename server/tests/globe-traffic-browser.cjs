require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Real pixels and counters: node labels, incremental visitor bubbles, flowing dashes.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message)});
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe);
 await page.evaluate(()=>{
  trueNodesMap['HK-A']=[22.3,114.1];trueNodesMap['HK-B']=[22.3,114.1];trueNodesMap['HK-C']=[22.3,114.1];trueNodesMap['Back <node>']=[0,-90];nodeHits['HK-A']=12345;nodeHits['Back <node>']=9876;
  switchDashMode('dashboard');TrafficGlobe.setExpanded(true);TrajectoryPool.clear();TrajectoryPool.clearHistory();
  window.hit=n=>{for(let i=0;i<n;i++)queueLiveEvent({ip:'counter-test',server_name:'Direct Access',location:'模拟访问',lat:27,lon:90,time:new Date().toISOString(),count:1,lang:'zh',target_domain:'demo.example'});};
 });await page.locator('#globe-rotate').click();await page.waitForFunction(()=>document.querySelectorAll('.globe-node-label').length===Object.keys(trueNodesMap).length);
 const labels=await page.evaluate(()=>Array.from(document.querySelectorAll('.globe-node-label'),el=>({name:el.dataset.node,hits:el.dataset.hits,text:el.querySelector('.globe-node-count').textContent,rail:el.classList.contains('in-rail'),rect:el.getBoundingClientRect().toJSON()})));
 assert.equal(labels.find(l=>l.name==='HK-A').text,'12,345');assert.equal(labels.find(l=>l.name==='Back <node>').hits,'9876');assert.ok(labels.find(l=>l.name==='Back <node>').rail);
 for(const a of labels.filter(l=>!l.rail))for(const b of labels.filter(l=>l!==a&&!l.rail))assert.ok(a.rect.right+8<=b.rect.x||b.rect.right+8<=a.rect.x||a.rect.bottom+8<=b.rect.y||b.rect.bottom+8<=a.rect.y,'floating labels must not overlap');
 const baseline=await page.evaluate(()=>nodeHits['Direct Access']);
 await page.evaluate(()=>{
  window.projectGlobe=(pos)=>{const state=TrafficGlobe.inspect(),lat=pos[0]*Math.PI/180,lon=pos[1]*Math.PI/180,p=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)],x=Math.cos(state.yaw)*p[0]+Math.sin(state.yaw)*p[2],z=-Math.sin(state.yaw)*p[0]+Math.cos(state.yaw)*p[2],c=document.getElementById('traffic-globe'),r=Math.min(c.clientWidth,c.clientHeight)*.385*state.zoom;return{x:c.clientWidth/2+x*r,y:c.clientHeight/2-(Math.cos(state.pitch)*p[1]-Math.sin(state.pitch)*z)*r};};
  window.measureBubble=()=>new Promise(resolve=>{
   const gl=document.getElementById('traffic-globe').getContext('webgl2'),draw=gl.drawArrays.bind(gl),p=projectGlobe([27,90]),ratio=gl.canvas.width/gl.canvas.clientWidth,x=Math.round(p.x*ratio-36),y=Math.round(gl.canvas.height-p.y*ratio-36),side=72;
   gl.drawArrays=function(...args){if(args[0]!==gl.POINTS){draw(...args);return;}const before=new Uint8Array(side*side*4),after=new Uint8Array(before.length);gl.readPixels(x,y,side,side,gl.RGBA,gl.UNSIGNED_BYTE,before);draw(...args);gl.readPixels(x,y,side,side,gl.RGBA,gl.UNSIGNED_BYTE,after);let pixels=0;for(let i=0;i<after.length;i+=4)if(Math.max(after[i+1]-before[i+1],after[i+2]-before[i+2])>15)pixels++;gl.drawArrays=draw;resolve(pixels);};
  });hit(1);
 });await page.waitForFunction(()=>TrafficGlobe.inspectLight([27,90])?.hits===1);const single=await page.evaluate(()=>measureBubble());
 await page.evaluate(()=>hit(30));await page.waitForFunction(()=>TrafficGlobe.inspectLight([27,90])?.hits===31);const middle=await page.evaluate(()=>measureBubble());
 await page.evaluate(()=>hit(300));await page.waitForFunction(()=>TrafficGlobe.inspectLight([27,90])?.hits===331);const busy=await page.evaluate(()=>measureBubble());
 assert.ok(middle>single*1.1&&busy>middle*1.1,JSON.stringify({single,middle,busy}));
 console.log('INCREMENTAL_BUBBLE_PIXELS',{single,middle,busy});await page.waitForFunction(n=>document.querySelector('.globe-node-label[data-node="Direct Access"]').dataset.hits===String(n),baseline+331);assert.equal(await page.locator('.globe-node-label[data-node="Direct Access"]').getAttribute('data-hits'),String(baseline+331));assert.ok(await page.getByText('+331',{exact:true}).isVisible());
 await page.screenshot({path:out+'/directional-globe-counters.png'});
 // Isolate one arc and compare moving brightness peaks in source → destination order.
 const frames=await page.evaluate(()=>new Promise(resolve=>{
  TrajectoryPool.clear();TrajectoryPool.clearHistory();currentInitSpeed=.5;hit(1);
  const gl=document.getElementById('traffic-globe').getContext('webgl2'),draw=gl.drawArraysInstanced.bind(gl),collected=[];
  gl.drawArraysInstanced=function(...args){
   const program=gl.getParameter(gl.CURRENT_PROGRAM),count=args[3];if(!count){draw(...args);return;}
   const path=TrafficGlobe.arc([27,90],getTruePos('Direct Access')),s=TrafficGlobe.inspect(),c=gl.canvas,ratio=c.width/c.clientWidth,r=Math.min(c.clientWidth,c.clientHeight)*.385*s.zoom,coords=[];
   for(let i=0;i<path.length-1;i++)for(let k=0;k<8;k++){const t=k/8,p=path[i].map((v,j)=>v+(path[i+1][j]-v)*t),x=Math.cos(s.yaw)*p[0]+Math.sin(s.yaw)*p[2],z=-Math.sin(s.yaw)*p[0]+Math.cos(s.yaw)*p[2];coords.push({x:Math.round((c.clientWidth/2+x*r)*ratio),y:Math.round(c.height-(c.clientHeight/2-(Math.cos(s.pitch)*p[1]-Math.sin(s.pitch)*z)*r)*ratio)});}
   const x=Math.min(...coords.map(p=>p.x))-3,y=Math.min(...coords.map(p=>p.y))-3,w=Math.max(...coords.map(p=>p.x))-x+4,h=Math.max(...coords.map(p=>p.y))-y+4,before=new Uint8Array(w*h*4),after=new Uint8Array(before.length);
   gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,before);draw(...args);gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,after);
   const samples=coords.map(p=>{const n=((p.y-y)*w+p.x-x)*4;return Math.max(0,after[n+1]-before[n+1])+Math.max(0,after[n+2]-before[n+2]);});
   const phase=gl.getUniform(program,gl.getUniformLocation(program,'time'))*gl.getUniform(program,gl.getUniformLocation(program,'flowSpeed'));collected.push({samples,phase});
   if(collected.length>=8){gl.drawArraysInstanced=draw;resolve(collected);}
  };
 }));
 let a,b;for(const f of frames){b=frames.find(g=>g.phase-f.phase>2&&g.phase-f.phase<5);if(b){a=f;break;}}assert.ok(a&&b);
 const maxA=Math.max(...a.samples),maxB=Math.max(...b.samples);assert.ok(maxA>20&&maxB>20);let best=0,score=-Infinity;
 for(let shift=-8;shift<=8;shift++){let sum=0;for(let i=22;i<a.samples.length-22;i++)sum+=(a.samples[i]/maxA-.3)*(b.samples[i+shift]/maxB-.3);if(sum>score){score=sum;best=shift;}}
 assert.ok(best>0,'3D dash peaks must visibly advance toward the node');console.log('3D_FORWARD_PEAK_SHIFT',best,maxA,maxB);
 await page.evaluate(()=>{window.demo=setInterval(()=>hit(8),120)});await page.waitForTimeout(350);await page.screenshot({path:out+'/directional-globe-live.png'});await page.evaluate(()=>clearInterval(demo));
 // Count and label DOM remain correct after rotation, collapse, and GPU fallback.
 await page.locator('#globe-expand').click();await page.waitForTimeout(200);assert.equal(await page.locator('.globe-node-label').count(),6);
 await page.locator('#globe-expand').click();await page.evaluate(()=>{window.gl=document.getElementById('traffic-globe').getContext('webgl2');window.loss=gl.getExtension('WEBGL_lose_context');loss.loseContext();});await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'Canvas');assert.equal(await page.locator('.globe-node-label').count(),6);
 await page.evaluate(()=>loss.restoreContext());await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'WebGL2');
 await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe);await page.locator('.mobile-fab [aria-label="Overview"]').click();await page.locator('#globe-expand').click();await page.waitForFunction(()=>document.querySelectorAll('.globe-node-label').length===2);
 const mobile=await page.locator('.globe-node-label').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().toJSON()));for(const b of mobile)assert.ok(b.x>=0&&b.right<=390);await page.screenshot({path:out+'/directional-globe-mobile.png'});
 assert.deepEqual(errors,[]);console.log('3D names, exact counts, bubble growth, forward ribbons and mobile labels passed');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
