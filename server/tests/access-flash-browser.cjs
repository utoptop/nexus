// Real-browser invariants for fixed maps, true endpoints, collision-free labels and unidirectional flashes.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
  const html=fs.readFileSync('/tmp/observatory-preview.html','utf8');
  await page.route('http://127.0.0.1:4173/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.routeWebSocket('**/ws',()=>{});
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForTimeout(700);
  const fixed=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),drag:map.dragging.enabled(),wheel:map.scrollWheelZoom.enabled(),wrap:baseTileLayer.options.noWrap}));
  assert.equal(fixed.drag,true);assert.equal(fixed.wheel,true);assert.equal(fixed.wrap,true);
  await page.evaluate(()=>{
   focusPath(31,121,'test','Shanghai','Direct Access');switchDashMode('map');
   for(let i=0;i<30;i++)queueLiveEvent({ip:'test'+i,server_name:'Direct Access',location:'Shanghai',lat:31,lon:121,time:new Date().toISOString(),count:1,lang:'zh',target_domain:'test'});
  });
  await page.waitForTimeout(800);
  let camera=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),admitted:TrajectoryPool.inspect().admitted}));
  assert.ok(Math.abs(camera.center.lat-fixed.center.lat)<1 && Math.abs(camera.center.lng-fixed.center.lng)<1);assert.equal(camera.zoom,fixed.zoom);assert.equal(camera.admitted,30);
  await page.mouse.move(750,400);await page.mouse.wheel(0,-800);await page.mouse.down();await page.mouse.move(900,450,{steps:8});await page.mouse.up();await page.waitForTimeout(250);
  camera=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom()}));assert.ok(camera.zoom>fixed.zoom);await page.evaluate(()=>map.setView([20,15],2.5,{animate:false}));
  console.log('INTERACTIVE_CAMERA',camera);
  await page.evaluate(()=>{
   window.TrajectoryPool.clear();window.TrajectoryPool.clearHistory();
   window.trueNodesMapTestNames=[];
   for(let i=0;i<120;i++){const n='Node '+i+(i===0?' long long long label':'');trueNodesMap[n]=[35.68,139.69];trueNodesMapTestNames.push(n);nodeHits[n]=i%2?999999999:1;}
   refreshNodeLayout();
  });
  async function checkLabels(){
   const labels=await page.evaluate(()=>{
    const nodes=Object.entries(nodeMarkers).filter(([name,m])=>map.hasLayer(m.getTooltip())).map(([name,m])=>{const r=m.getTooltip().getElement().getBoundingClientRect();return{name,expected:map.latLngToContainerPoint(displayNodesMap[name]),latlng:m.getTooltip().getLatLng(),x:r.x,y:r.y,w:r.width,h:r.height};});
    return{nodes,overflow:nodeOverflowCards.size,total:Object.keys(trueNodesMap).length,map:map.getContainer().getBoundingClientRect().toJSON()};
   });
   assert.equal(labels.nodes.length+labels.overflow,labels.total);assert.ok(labels.overflow>0);
   for(let i=0;i<labels.nodes.length;i++){
    const a=labels.nodes[i];assert.equal(a.w,labels.map.width<=768?118:138);assert.equal(a.h,46);assert.ok(a.x>=labels.map.x&&a.x+a.w<=labels.map.right);
    for(const b of labels.nodes.slice(i+1))assert.ok(a.x+a.w+10<=b.x||b.x+b.w+10<=a.x||a.y+a.h+10<=b.y||b.y+b.h+10<=a.y,JSON.stringify({a,b}));
   }
   console.log('LABEL_LAYOUT',labels.nodes.length,labels.overflow,labels.map.width);return labels;
  }
  await checkLabels();
  assert.equal(await page.locator('.node-overflow-card').count(),await page.evaluate(()=>nodeOverflowCards.size));
  const endpoints=await page.evaluate(()=>{
   const node='Node 0 long long long label';TrajectoryPool.fireLine([30,110],getTruePos(node),'#2be5ff',1,node);
   return{segment:TrajectoryPool.inspectGeometry(node),real:map.latLngToContainerPoint(getTruePos(node)),label:map.latLngToContainerPoint(displayNodesMap[node])};
  });
  assert.equal(endpoints.segment.length,1);assert.deepEqual(endpoints.segment[0].b,endpoints.real);
  // Capture GPU output during the draw itself, before the browser discards its back buffer.
  await page.evaluate(()=>{
   TrajectoryPool.clear();TrajectoryPool.clearHistory();map.setView([0,0],1.25,{animate:false});
   applyVisualStyles(4,0,3,.5,.5,1.5,.5,8,6);
   const gl=document.querySelector('.traffic-packets').getContext('webgl2'),draw=gl.drawArraysInstanced.bind(gl);
   window.flashFrames=[];window.flashStart=performance.now();
   gl.drawArraysInstanced=function(...args){
    draw(...args);const program=gl.getParameter(gl.CURRENT_PROGRAM);
    if(gl.getUniform(program,gl.getUniformLocation(program,'mode'))!==0)return;
    const c=gl.canvas,s=TrajectoryPool.inspectGeometry('Flash Test')[0];if(!s)return;
    const ratio=c.width/map.getSize().x,row=Math.round(c.height-s.a.y*ratio),pixels=new Uint8Array(c.width*4);
    gl.readPixels(0,row,c.width,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const samples=[];for(let x=s.a.x+56;x<s.b.x-56;x+=1){const px=Math.round(x*ratio);samples.push(pixels[px*4+3]);}
    const instance=new Float32Array(12);gl.getBufferSubData(gl.ARRAY_BUFFER,0,instance);flashFrames.push({age:performance.now()-flashStart,samples,phase:instance[5]});
   };
   TrajectoryPool.fireLine([0,-120],[0,120],'#2be5ff',1,'Flash Test');
  });
  await page.waitForFunction(()=>TrajectoryPool.inspect().completed===1);
  const frames=await page.evaluate(()=>flashFrames),info=await page.evaluate(()=>TrajectoryPool.inspect());
  assert.ok(frames.length>=3);const first=frames[0];assert.ok(first);
  const third=Math.floor(first.samples.length/3);
  for(let i=0;i<3;i++)assert.ok(first.samples.slice(i*third,(i+1)*third).some(v=>v>15),'entire path must light together');
  const max=Math.max(...first.samples),min=Math.min(...first.samples);
  assert.ok(max>min*3&&max-min>50,'new packets must stand out clearly above the quiet carrier');
  const later=frames.find(f=>f.age>first.age+90&&f.age<first.age+350);assert.ok(later);
  for(let i=1;i<frames.length;i++)assert.ok(frames[i].phase>=frames[i-1].phase,'packets must never reverse');
  let a,b;for(const f of frames){b=frames.find(g=>g.phase-f.phase>1&&g.phase-f.phase<5);if(b){a=f;break;}}
  assert.ok(a&&b);const maxA=Math.max(...a.samples),maxB=Math.max(...b.samples);let best=0,score=-Infinity;
  for(let shift=-6;shift<=6;shift++){let sum=0;for(let i=15;i<a.samples.length-15;i++)sum+=(a.samples[i]/maxA-.5)*(b.samples[i+shift]/maxB-.5);if(sum>score){score=sum;best=shift;}}
  assert.ok(best>0,'visible packet peaks must move visitor → node');assert.ok(Math.abs(best-(b.phase-a.phase))<2.5);
  assert.ok(later.samples.reduce((a,b)=>a+b,0)<first.samples.reduce((a,b)=>a+b,0));
  assert.equal(info.admitted,1);assert.equal(info.completed,1);assert.equal(info.activePackets,0);assert.equal(info.instances,0);assert.equal(info.bufferBytes,24000*12*4);
  console.log('FLOWING_DASHES',{frames:frames.length,firstAge:first.age,lastAge:frames.at(-1).age,bufferBytes:info.bufferBytes});
  await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'networkidle'});await page.waitForTimeout(700);
  await page.evaluate(()=>{for(let i=0;i<16;i++)trueNodesMap['Mobile '+i]=[35.68,139.69];refreshNodeLayout();});await checkLabels();
  const mobilePanel=await page.locator('.node-overflow-cards').boundingBox();assert.ok(mobilePanel.x>=0 && mobilePanel.x+mobilePanel.width<=390);
  assert.deepEqual(errors,[]);console.log('Access-flash regressions passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
