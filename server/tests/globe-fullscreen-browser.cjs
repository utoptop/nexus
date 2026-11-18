require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='/tmp/nexus-artifacts';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message)});
 await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('/tmp/observatory-preview.html','utf8')}));await page.routeWebSocket('**/ws',()=>{});
 await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe&&window.TrajectoryPool);await page.waitForTimeout(600);
 const camera=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()}));
 await page.locator('#nav-btn-dash').click();await page.locator('#globe-expand').click();await page.waitForFunction(()=>TrafficGlobe.inspect().expanded&&TrafficGlobe.inspect().frames>4);
 const b=await page.locator('#globe-card').boundingBox();assert.deepEqual(b,{x:0,y:0,width:1440,height:900});
 assert.equal(await page.locator('#globe-card').evaluate(el=>el.parentElement===document.body),true);assert.equal(await page.locator('#map-container').evaluate(el=>el.inert),true);
 let state=await page.evaluate(()=>TrafficGlobe.inspect());assert.equal(state.engine,'WebGL2');assert.ok(state.borderVertices>6000);assert.ok(state.pixels<=state.pixelBudget&&state.pixelBudget<=8294400);assert.ok(state.bufferBytes<64*1024*1024);
 await page.locator('#globe-rotate').click();const before=await page.evaluate(()=>TrafficGlobe.inspect());
 await page.mouse.move(700,450);await page.mouse.wheel(0,-180);await page.waitForTimeout(100);assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().zoom))>before.zoom);
 const z=await page.evaluate(()=>TrafficGlobe.inspect().zoom);await page.locator('#globe-zoom-out').click();assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().zoom))<z);
 await page.mouse.move(700,450);await page.mouse.down();await page.mouse.move(800,470,{steps:12});await page.mouse.up();assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().yaw))>before.yaw);
 await page.locator('#globe-reset').click();assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().zoom),1);
 // Clear historical activity, then compare one visit with a burst to a single node.
 await page.evaluate(()=>{TrajectoryPool.clear();window.hit=(i,lat=31.2,lon=121.4)=>queueLiveEvent({ip:'test-'+i,server_name:'Direct Access',location:'模拟访问 DEMO',lat,lon,time:new Date().toISOString(),count:1,lang:'zh',target_domain:'demo.example'});hit(0);});
 await page.waitForFunction(()=>TrafficGlobe.inspectLight('Direct Access')?.energy>0);const single=await page.evaluate(()=>TrafficGlobe.inspectLight('Direct Access').energy);
 const raster=await page.evaluate(()=>TrajectoryPool.inspect().rasterFrames);
 await page.evaluate(()=>{for(let i=1;i<=1000;i++)hit(i);});await page.waitForFunction(()=>liveQueue.size===0&&TrajectoryPool.inspect().admitted===1001);await page.waitForTimeout(150);
 const node=await page.evaluate(()=>TrafficGlobe.inspectLight('Direct Access')),visitor=await page.evaluate(()=>TrafficGlobe.inspectLight([31.2,121.4]));
 assert.ok(node.energy>single*100);assert.ok(visitor.energy>single*100);assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().rasterFrames),raster);
 console.log('REAL_ACTIVITY_AND_OCCLUSION',{single,nodeEnergy:node.energy,visitorEnergy:visitor.energy,raster});
 await page.evaluate(()=>{const points=[[51.5,-.1],[40.7,-74],[1.3,103.8],[28.6,77.2],[-33.9,151.2],[37.7,-122.4],[48.8,2.3]];window.demoTimer=setInterval(()=>points.forEach((p,i)=>hit(i+1002,...p)),180);});
 await page.waitForTimeout(450);await page.screenshot({path:out+'/globe-full-desktop.png'});
 // Read the border pass once: country lines must actually alter the sphere pixels.
 const borderPixels=await page.evaluate(()=>new Promise(resolve=>{
  const gl=document.getElementById('traffic-globe').getContext('webgl2'),draw=gl.drawArrays.bind(gl);let before;
  gl.drawArrays=function(...args){draw(...args);const mode=gl.getUniform(gl.getParameter(gl.CURRENT_PROGRAM),gl.getUniformLocation(gl.getParameter(gl.CURRENT_PROGRAM),'mode'));
   if(mode===0){before=new Uint8Array(gl.canvas.width*gl.canvas.height*4);gl.readPixels(0,0,gl.canvas.width,gl.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,before);}
   if(mode===3&&before){const after=new Uint8Array(before.length);gl.readPixels(0,0,gl.canvas.width,gl.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,after);let pixels=0;for(let i=0;i<before.length;i+=4)if(Math.abs(after[i+1]-before[i+1])>12)pixels++;gl.drawArrays=draw;resolve(pixels);}
  };
 }));assert.ok(borderPixels>1000);console.log('VISIBLE_BORDER_PIXELS',borderPixels);
 await page.evaluate(()=>clearInterval(demoTimer));const warm=await page.evaluate(()=>TrafficGlobe.inspectLight('Direct Access').energy);await page.waitForTimeout(2100);assert.ok((await page.evaluate(()=>TrafficGlobe.inspectLight('Direct Access').energy))<warm*.6);
 await page.evaluate(()=>{window.globeGL=document.getElementById('traffic-globe').getContext('webgl2');window.globeLoss=globeGL.getExtension('WEBGL_lose_context');globeLoss.loseContext();});await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'Canvas');await page.screenshot({path:out+'/globe-full-fallback.png'});
 await page.evaluate(()=>globeLoss.restoreContext());await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().engine),'WebGL2');
 await page.locator('#globe-back-map').click();await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().active),false);assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().occluded),false);assert.equal(await page.locator('#map-container').evaluate(el=>el.inert),false);
 assert.deepEqual(await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()})),camera);assert.ok((await page.evaluate(()=>TrajectoryPool.inspect().rasterFrames))>raster);
 await page.locator('[aria-label="World view"]').click();await page.waitForTimeout(150);const fit=await page.evaluate(()=>({old:TrafficRuntime.coverZoom(innerWidth,innerHeight),z:map.getZoom(),view:map.getPixelBounds(),world:map.getPixelWorldBounds()}));assert.ok(fit.z<fit.old);for(const axis of ['x','y'])assert.ok(fit.world.min[axis]>=fit.view.min[axis]&&fit.world.max[axis]<=fit.view.max[axis]);await page.waitForFunction(()=>!baseTileLayer.isLoading(),{},{timeout:20000});await page.waitForTimeout(300);const tiles=await page.evaluate(()=>Object.values(baseTileLayer._tiles).map(t=>({x:t.coords.x,y:t.coords.y,z:t.coords.z,width:t.el.naturalWidth})));assert.ok(tiles.length>0&&tiles.some(t=>t.width>0));for(const t of tiles)assert.ok(t.x>=0&&t.x<2**t.z&&t.y>=0&&t.y<2**t.z,'never request tiles outside the world');console.log('VALID_WORLD_TILES',tiles.length);await page.screenshot({path:out+'/map-whole-world-desktop.png'});
 await page.locator('#nav-btn-dash').click();await page.locator('#globe-expand').click();
 await page.evaluate(()=>{TrajectoryPool.clear();for(let i=0;i<1600;i++)TrajectoryPool.fireLine([-40+i%80,-160+i/10],getTruePos('Direct Access'),'#22d3ee',1,'Direct Access');});
 await page.waitForFunction(()=>TrafficGlobe.inspect().lights>=1600,{},{timeout:5000});console.log('ALL_ACTIVE_ORIGINS',await page.evaluate(()=>TrafficGlobe.inspect().lights));
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().expanded),false);assert.ok(await page.locator('#cyber-dashboard').isVisible());
 await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForFunction(()=>window.TrafficGlobe);
 await page.locator('.mobile-fab [aria-label="Overview"]').click();await page.locator('#globe-expand').click();await page.waitForTimeout(300);assert.deepEqual(await page.locator('#globe-card').boundingBox(),{x:0,y:0,width:390,height:844});
 const touch=await page.context().newCDPSession(page),initial=await page.evaluate(()=>TrafficGlobe.inspect().zoom);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:140,y:400,id:1},{x:240,y:400,id:2}]});
 for(let i=1;i<=5;i++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:140-i*8,y:400,id:1},{x:240+i*8,y:400,id:2}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().zoom))>initial*1.4);
 await page.locator('#globe-reset').click();await page.waitForTimeout(150);await page.screenshot({path:out+'/globe-full-mobile.png'});
 assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().pixels))<=2000000);assert.ok(await page.locator('#globe-back-map').isVisible());await page.locator('#globe-back-map').click();await page.locator('[aria-label="World view"]').click();await page.waitForTimeout(150);await page.waitForFunction(()=>!baseTileLayer.isLoading(),{},{timeout:20000});await page.waitForTimeout(300);await page.screenshot({path:out+'/map-whole-world-mobile.png'});
 assert.ok(await page.evaluate(()=>map.getZoom()<1&&document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log('Fullscreen, borders, rotation, wheel/pinch, activity, fallback and map return passed',state);
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
