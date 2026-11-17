// Browser storage, per-visit rendering, light decay, background and GPU recovery.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=fs.readFileSync('/tmp/observatory-preview.html','utf8');
  await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.routeWebSocket('**/ws',()=>{});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>Boolean(liveQueue.db));
  const spool=await page.evaluate(async()=>{
   const q=new TrafficRuntime.EventQueue(512);while(!q.db)await new Promise(r=>setTimeout(r,5));
   for(let i=0;i<25000;i++)q.push({ip:String(i),server_name:i%2?'A':'B',count:1});
   const peak=q.size,seen=new Set();let peakRAM=0;
   const deadline=performance.now()+20000;
   while(q.size && performance.now()<deadline){
    peakRAM=Math.max(peakRAM,q.readySize);
    while(q.readySize)seen.add(q.shift().ip);
    await new Promise(r=>setTimeout(r,0));
   }
   const result={peak,peakRAM,pending:q.size,unique:seen.size,received:q.received,dequeued:q.dequeued,rejected:q.rejected};
   // Clear during pending writes/reads cannot resurrect the previous scope.
   for(let i=0;i<2000;i++)q.push({ip:'old'+i,count:1});q.flush();q.clear();q.push({ip:'new',count:1});
   await new Promise(r=>setTimeout(r,100));result.afterClear=q.size;result.first=q.shift().ip;
   q.db.close();q.storage.deleteDatabase(q.dbName);return result;
  });
  assert.equal(spool.unique,25000);assert.equal(spool.dequeued,25000);assert.equal(spool.pending,0);assert.ok(spool.peakRAM<=512);assert.equal(spool.rejected,0);assert.equal(spool.afterClear,1);assert.equal(spool.first,'new');console.log('DISK_INBOX',spool);
  await page.evaluate(()=>{
   switchDashMode('map');window.TrajectoryPool.clear();
   window.sameVisitor=()=>({ip:'198.51.100.1',server_name:'Direct Access',target_domain:'test',location:'Shanghai',lat:31,lon:121,time:new Date().toISOString(),count:1,lang:'en'});
  });
  await page.waitForTimeout(400);
  await page.evaluate(()=>{for(let i=0;i<3000;i++)queueLiveEvent(sameVisitor());});
  await page.waitForFunction(()=>window.TrajectoryPool.inspect().drawnVisitors===3000);
  const repeated=await page.evaluate(()=>({info:window.TrajectoryPool.inspect(),level:nodeMarkers['Direct Access'].getElement().dataset.activity,shadow:getComputedStyle(nodeMarkers['Direct Access'].getTooltip().getElement()).boxShadow}));
  assert.equal(repeated.info.routes,1);assert.equal(repeated.info.admitted,3000);assert.equal(repeated.info.drawnVisitors,3000);assert.equal(repeated.info.activePackets+repeated.info.completed,3000);assert.equal(repeated.info.engine,'WebGL2');assert.equal(repeated.info.drawCalls,2);assert.notEqual(repeated.shadow,'none');assert.ok(Number(repeated.level)>0);console.log('SAME_LOCATION',repeated.info.activePackets,repeated.level);
  await page.waitForTimeout(5000);
  const faded=await page.evaluate(()=>Number(nodeMarkers['Direct Access'].getElement().dataset.activity));
  assert.ok(faded<Number(repeated.level));console.log('BRIGHTNESS_DECAY',repeated.level,faded);
  // Emulate page visibility through the browser-facing property and DOM event.
  await page.evaluate(()=>{
   window.TrajectoryPool.clear();liveQueue.clear();
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));
   for(let i=0;i<2000;i++)queueLiveEvent(sameVisitor());
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>liveQueue.size),2000);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>window.TrajectoryPool.inspect().drawnVisitors===2000);
  assert.equal(await page.evaluate(()=>liveQueue.size),0);console.log('BACKGROUND_RESTORED',2000);
  await page.evaluate(()=>{
   window.TrajectoryPool.clear();
   window.glLoss=document.querySelector('.traffic-packets').getContext('webgl2').getExtension('WEBGL_lose_context');glLoss.loseContext();
  });
  await page.waitForFunction(()=>window.TrajectoryPool.inspect().engine==='Canvas');
  await page.evaluate(()=>{for(let i=0;i<600;i++)queueLiveEvent(sameVisitor());});
  await page.waitForFunction(()=>window.TrajectoryPool.inspect().drawnVisitors===600);
  await page.evaluate(()=>glLoss.restoreContext());
  await page.waitForFunction(()=>window.TrajectoryPool.inspect().engine==='WebGL2');
  assert.equal(await page.evaluate(()=>document.querySelector('.traffic-packets').getContext('webgl2').getError()),0);console.log('GPU_RECOVERY','Canvas → WebGL2, 600 visits retained');
  const fault=await page.evaluate(async()=>{
   const q=new TrafficRuntime.EventQueue(128);while(!q.db)await new Promise(r=>setTimeout(r,5));q.db.close();
   for(let i=0;i<256;i++)q.push({ip:String(i),count:1});
   q.flush();q.storage.deleteDatabase(q.dbName);return{error:q.error,ready:q.readySize};
  });
  assert.ok(fault.error);assert.equal(fault.ready,128);console.log('STORAGE_FAULT',fault);
  await page.evaluate(()=>{
   window.TrajectoryPool.clear();window.TrajectoryPool.clearHistory();
   window.TrajectoryPool.addHistory([31,121],getTruePos('Direct Access'),'Direct Access','#2be5ff');
   applyVisualStyles(4,0,3,0.1,0.5,1.5,0.5,20,60);
  });
  await page.waitForTimeout(300);
  const dark=await page.evaluate(()=>{
   const c=document.querySelector('.traffic-history'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
   let sum=0;for(let i=3;i<pixels.length;i+=4)sum+=pixels[i];return sum;
  });
  assert.equal(dark,0);console.log('ZERO_HISTORY_BRIGHTNESS',dark);
  assert.deepEqual(errors,[]);console.log('Activity, background and fault checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
