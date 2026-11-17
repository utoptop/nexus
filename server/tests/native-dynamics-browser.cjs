require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Exercise idle → individual access → burst → decay through the real event pipeline.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const artifact='/tmp/nexus-artifacts';
 const record=Boolean(process.env.RECORD_NATIVE);
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',...(record?{recordVideo:{dir:'/tmp/native-dynamics-video',size:{width:1440,height:1000}}}:{})});
 try{
  const page=await context.newPage(),errors=[],timeline={startedAt:Date.now()};
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
  const html=fs.readFileSync('/tmp/observatory-preview.html','utf8');
  await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.routeWebSocket('**/ws',()=>{});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForTimeout(800);
  await page.evaluate(()=>{
   baseTileLayer.setOpacity(.2);
   window.TrajectoryPool.clear();
   window.dynamicVisit=(n=1,lat=31,lon=121,node='Direct Access')=>{
    for(let i=0;i<n;i++)queueLiveEvent({ip:'198.51.100.200',server_name:node,target_domain:'preview.example',location:'中国 · 上海',lat,lon,count:1,time:new Date().toISOString(),lang:'zh'});
   };
   window.captureActivity=()=>{
    const m=Object.values(visitorMarkers).find(m=>m._visitorIP==='198.51.100.200'),el=m&&cluster.getVisibleParent(m)?.getElement();
    const tip=nodeMarkers['Direct Access'].getTooltip().getElement(),orb=el?.querySelector('.odometer-bubble');
    return{bubbleWidth:orb?.getBoundingClientRect().width||0,source:TrajectoryPool.inspectSource([31,121]),node:nodeMarkers['Direct Access']._activityLevel,burst:nodeMarkers['Direct Access']._activityBurst,shadow:getComputedStyle(tip).boxShadow,bubbleLevel:Number(el?.style.getPropertyValue('--visitor-activity')||0),bubbleBurst:Number(el?.style.getPropertyValue('--visitor-burst')||0),radius:tip.getBoundingClientRect().height,info:TrajectoryPool.inspect()};
   };
  });
  await page.waitForTimeout(1000);
  const idle=await page.evaluate(()=>captureActivity());assert.equal(idle.source,null);
  timeline.idle=(Date.now()-timeline.startedAt)/1000;await page.screenshot({path:artifact+'/native-live-idle.png'});
  await page.evaluate(()=>dynamicVisit());await page.waitForFunction(()=>TrajectoryPool.inspect().drawnVisitors===1);await page.waitForFunction(()=>Object.values(visitorMarkers).some(m=>m._visitorIP==='198.51.100.200'));await page.waitForTimeout(80);
  const single=await page.evaluate(()=>captureActivity());assert.ok(single.source);assert.ok(single.source.burst>0);assert.ok(single.burst>0);assert.notEqual(single.shadow,idle.shadow);
  await page.waitForTimeout(550);
  for(const n of [12,36,120,360]){await page.evaluate(n=>{dynamicVisit(n);dynamicVisit(Math.ceil(n/4),51,-.12,'Tokyo Edge');},n);await page.waitForTimeout(220);}
  await page.waitForFunction(()=>liveQueue.size===0);await page.waitForTimeout(80);
  const busy=await page.evaluate(()=>captureActivity());
  assert.ok(busy.source.radius>single.source.radius);assert.ok(busy.node>single.node);assert.ok(busy.bubbleLevel>.4);assert.ok(busy.bubbleWidth>single.bubbleWidth);assert.ok(busy.bubbleBurst>0);
  assert.equal(busy.radius,idle.radius);assert.ok(busy.info.drawnByNode['Tokyo Edge']>0);assert.equal(busy.info.admitted,661);
  timeline.burst=(Date.now()-timeline.startedAt)/1000;await page.screenshot({path:artifact+'/native-live-burst.png'});
  await page.waitForTimeout(5000);const cool=await page.evaluate(()=>captureActivity());
  assert.ok(cool.source.radius<busy.source.radius);assert.equal(cool.burst,0);assert.equal(cool.info.activePackets,0);assert.ok(cool.bubbleLevel<busy.bubbleLevel);
  console.log('NATIVE_ACTIVITY',{single:{radius:single.source.radius,node:single.node},burst:{radius:busy.source.radius,node:busy.node,bubble:busy.bubbleLevel},cool:{radius:cool.source.radius,node:cool.node,bubble:cool.bubbleLevel}});
  await page.screenshot({path:artifact+'/native-live-cool.png'});timeline.cool=(Date.now()-timeline.startedAt)/1000;await page.waitForTimeout(700);
  await page.evaluate(()=>map.fire('movestart'));await page.waitForTimeout(150);
  await page.evaluate(()=>dynamicVisit(5));await page.waitForTimeout(150);await page.evaluate(()=>map.fire('moveend'));await page.waitForTimeout(120);
  assert.ok(await page.evaluate(()=>captureActivity().burst<=1));
  // Active origin lights remain visible even when the quiet-afterglow cache is full.
  await page.evaluate(()=>{TrajectoryPool.clear();for(let i=0;i<1600;i++)TrajectoryPool.fireLine([20+i*.005,90+i*.01],getTruePos('Direct Access'),'#2be5ff',1,'Direct Access');});
  await page.waitForFunction(()=>TrajectoryPool.inspect().drawnVisitors===1600);
  const dense=await page.evaluate(()=>TrajectoryPool.inspect());assert.equal(dense.sources,1200);assert.equal(dense.lightInstances,1600);console.log('ALL_ACTIVE_ORIGINS',dense.lightInstances,'cached',dense.sources);
  await page.evaluate(()=>{TrajectoryPool.clear();TrajectoryPool.fireLine([31,121],getTruePos('Direct Access'),'#2be5ff',1,'Direct Access');});
  await page.waitForFunction(()=>TrajectoryPool.inspect().sources===0,{},{timeout:15000});
  await page.waitForFunction(()=>Object.keys(TrajectoryPool.inspect().activity).length===0);
  const frames=await page.evaluate(()=>TrajectoryPool.inspect().frameCount);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().frameCount),frames);
  await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle'});await page.waitForTimeout(800);
  await page.evaluate(()=>baseTileLayer.setOpacity(.2));
  const mapSize=await page.evaluate(()=>({world:map.options.crs.scale(map.getZoom()),height:map.getSize().y,locked:!map.dragging.enabled()}));assert.ok(mapSize.world>=mapSize.height);assert.equal(mapSize.locked,false);
  await page.waitForTimeout(600);
  await page.evaluate(()=>{for(let i=0;i<60;i++)queueLiveEvent({ip:'198.51.100.'+i%4,server_name:i%2?'Tokyo Edge':'Direct Access',target_domain:'preview.example',location:'中国 · 上海',lat:30+i%4*3,lon:108+i%4*5,count:1,time:new Date().toISOString(),lang:'zh'});});
  await page.waitForTimeout(350);await page.screenshot({path:artifact+'/native-live-mobile.png'});
  assert.deepEqual(errors,[]);console.log('Native dynamic behavior regressions passed');
  if(record){fs.writeFileSync(artifact+'/native-live-timing.json',JSON.stringify(timeline));const video=page.video();await page.close();await video.saveAs(artifact+'/native-live-session.webm');}
 }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
