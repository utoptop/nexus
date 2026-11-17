// Run after DASHBOARD_FIXTURE_PATH=/tmp/observatory-preview.html cargo test render_dashboard_fixture.
// Requires Playwright and Chrome; API responses use synthetic data only.
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000}, locale:'zh-CN'});
    const errors=[]; page.on('console', m=>{if(m.type()==='warning')console.log('BROWSER_WARNING',m.text());}); page.on('pageerror', e=>{ errors.push(e.message); console.error('PAGE ERROR',e.message); });
    const fixture = fs.readFileSync(process.env.DASHBOARD_FIXTURE_PATH || '/tmp/observatory-preview.html','utf8');
    const hist = Array.from({length:30000},(_,i)=>[30+i%15,100+i%60,'中国 · 上海',i%2?'Tokyo Edge':'Direct Access',`198.51.${Math.floor(i/250)%250}.${i%250}`,new Date(Date.UTC(2026,10,14)+i*1000).toISOString(),'api.example.test']);
    await page.route('http://127.0.0.1:4173/**', async route=>{
        const url=route.request().url();
        if(url.includes('/api/playback')) return route.fulfill({json:hist});
        if(url.includes('/api/data')) return route.fulfill({json:{stats:[],history:[],heatmap:[]}});
        if(url.includes('/api/')) return route.fulfill({json:{days:30}});
        return route.fulfill({contentType:'text/html',body:fixture});
    });
    await page.routeWebSocket('**/ws', socket=>{});
    await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});
    await page.waitForFunction(()=>typeof window.TrajectoryPool!=='undefined');
    await page.waitForTimeout(1300);
    await page.screenshot({path:'/tmp/observatory-desktop.png'});
    console.log('INITIAL', await page.evaluate(()=>({stats:statsMap.size,markers:markerLRU.size,canvases:document.querySelectorAll('.traffic-canvas').length,svg:document.querySelectorAll('.conn-channel-flow').length})));
    await page.evaluate(open=>{ switchDashMode(open?'dashboard':'map'); },Boolean(process.env.OVERVIEW_LOAD||process.env.FULLSCREEN_LOAD));
    if(process.env.FULLSCREEN_LOAD)await page.evaluate(()=>TrafficGlobe.setExpanded(true));
    await page.waitForTimeout(300);
    await page.evaluate(()=>{
        for(let i=0;i<100000;i++) queueLiveEvent({ip:`192.0.${i>>8}.${i%256}`,location:'中国 · 上海',lat:25+i%20,lon:100+i%60,server_name:'Direct Access',target_domain:'site',time:'2026-11-14 08:00:00+08',count:1,lang:'zh'});
    });
    for(let retry=0;retry<60;retry++){
        const state=await page.evaluate(()=>({pending:liveQueue.size,ready:liveQueue.readySize,disk:liveQueue.disk,error:liveQueue.error,admitted:window.TrajectoryPool.inspect().admitted,active:window.TrajectoryPool.inspect().activePackets,engine:window.TrajectoryPool.inspect().engine}));
        if(!state.pending)break;
        if(retry%5===0)console.log('DRAIN',state);
        await page.waitForTimeout(2000);
    }
    assert.equal(await page.evaluate(()=>liveQueue.size),0);
    await page.waitForTimeout(1200);
    const bounds=await page.evaluate(()=>({stats:statsMap.size,markers:markerLRU.size,cluster:cluster.getLayers().length,queue:liveQueue.size,rejected:liveQueue.rejected,received:liveQueue.received,dequeued:liveQueue.dequeued,heat:heatBuckets.bins.size,...window.TrajectoryPool.inspect()}));
    console.log('BURST',bounds);
    if(process.env.OVERVIEW_LOAD||process.env.FULLSCREEN_LOAD){const globe=await page.evaluate(()=>TrafficGlobe.inspect());console.log('CONCURRENT_GLOBE',globe);assert.ok(globe.active&&globe.frames>10);assert.ok(globe.routes<=globe.routeLimit&&globe.pixels<=(process.env.FULLSCREEN_LOAD?1800000:500000)&&globe.bufferBytes<8e6);}
    assert.ok(bounds.stats<=6000); assert.ok(bounds.markers<=1200); assert.ok(bounds.cluster<=1200); assert.ok(bounds.routes<=480); assert.ok(bounds.heat<=1440); assert.equal(bounds.rejected,0); assert.equal(bounds.received,100000); assert.equal(bounds.dequeued,100000); assert.equal(bounds.admitted,100000); assert.equal(bounds.represented,100000);
    if(process.env.FULLSCREEN_LOAD){assert.equal(bounds.occluded,true);await page.evaluate(()=>TrafficGlobe.returnMap());await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().occluded),false);}
    await page.screenshot({path:'/tmp/observatory-map.png'});
    const routeBounds = await page.evaluate(()=>{
        for(let i=0;i<10000;i++) { const from=[-60+(i%120),-170+i/30]; window.TrajectoryPool.fireLine(from,[35,139],'#72ddc3',1,'Tokyo'); window.TrajectoryPool.addHistory(from,[35,139],'Tokyo'); }
        return window.TrajectoryPool.inspect();
    });
    assert.ok(routeBounds.routes<=480); assert.equal(routeBounds.history,1600);
    console.log('ROUTE_CAPS',routeBounds);
    await page.evaluate(()=>startPlayback());
    await page.waitForFunction(()=>pbState.active);
    await page.evaluate(()=>{togglePlayPause(); seekPlayback(29999);});
    await page.waitForFunction(()=>pbState.seekTarget==null && pbState.index===30000,{},{timeout:30000});
    const seek = await page.evaluate(()=>({index:pbState.index,hits:Object.values(nodeHits).reduce((a,b)=>a+b,0),heat:Array.from(heatBuckets.bins.values()).reduce((a,b)=>a+b,0),stats:statsMap.size}));
    console.log('SEEK',seek); assert.equal(seek.hits,30000); assert.equal(seek.heat,30000);
    await page.evaluate(()=>{seekPlayback(99);});
    await page.waitForFunction(()=>pbState.seekTarget==null&&pbState.index===100);
    assert.equal(await page.evaluate(()=>Object.values(nodeHits).reduce((a,b)=>a+b,0)),100);
    await page.evaluate(()=>{document.getElementById('pb-speed').value='2'; togglePlayPause();});
    await page.waitForTimeout(2000);
    const fast = await page.evaluate(()=>pbState.index); console.log('100X_POSITION',fast); assert.ok(fast>500);
    await page.evaluate(()=>stopPlayback());
    assert.equal(await page.evaluate(()=>pbState.hist.length),0);
    await page.setViewportSize({width:390,height:844});
    await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800);
    await page.evaluate(()=>toggleMobileDrawer(true)); await page.waitForTimeout(500);
    await page.screenshot({path:'/tmp/observatory-mobile.png'});
    await page.evaluate(()=>setDrawerY(getDrawerSnaps().full,true)); await page.waitForTimeout(400);
    await page.screenshot({path:'/tmp/observatory-mobile-expanded.png'});
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:680}]});
    for(let y=660;y>=360;y-=30) { await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y}]}); await page.waitForTimeout(20); }
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(200);
    const scrolled = await page.locator('#scroll-container').evaluate(el=>el.scrollTop);
    console.log('MOBILE_TOUCH_SCROLL',scrolled); assert.ok(scrolled>100);
    assert.ok(await page.locator('#scroll-container').evaluate(el=>el.clientHeight)>250);
    await page.evaluate(()=>startPlayback()); await page.waitForFunction(()=>pbState.active);
    await page.waitForTimeout(500);
    await page.screenshot({path:'/tmp/observatory-mobile-playback.png'});
    const playbackBox = await page.locator('#playback-ctrl').boundingBox();
    assert.ok(playbackBox.x>=0 && playbackBox.x+playbackBox.width<=390);
    await page.evaluate(()=>stopPlayback());
    assert.equal(await page.evaluate(()=>isMobile),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    await browser.close();
    console.log('Browser smoke and load checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
