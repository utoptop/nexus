// Generate the dashboard fixture first (see DEVELOPMENT.md).
// Exercises actual WebGL allocations on Retina desktop, 4K, mobile and fallback.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const fixture=process.env.DASHBOARD_FIXTURE_PATH||'/tmp/observatory-preview.html';
const out=process.env.GLOBE_ARTIFACT_DIR||'/tmp/nexus-artifacts';fs.mkdirSync(out,{recursive:true});
(async()=>{
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const errors=[];
    async function open(viewport,dpr,memory=8,file=fixture){
        const context=await browser.newContext({viewport,deviceScaleFactor:dpr,locale:'zh-CN'});
        await context.addInitScript(value=>Object.defineProperty(navigator,'deviceMemory',{get:()=>value}),memory);
        const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
        await page.route('http://127.0.0.1:4173/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8')}));
        await page.routeWebSocket('**/ws',()=>{});
        await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle',timeout:60000});
        await page.waitForFunction(()=>window.TrafficGlobe);
        await page.evaluate(()=>switchDashMode('dashboard'));
        await page.waitForFunction(()=>TrafficGlobe.inspect().engine==='WebGL2'&&TrafficGlobe.inspect().frames>=2);
        return {page,context};
    }
    async function expand(page){return page.evaluate(()=>{TrafficGlobe.setExpanded(true);return TrafficGlobe.inspect();});}
    async function screenshot(page,name){
        await page.evaluate(()=>{if(TrafficGlobe.inspect().rotating)document.getElementById('globe-rotate').click();document.getElementById('globe-reset').click();});
        await page.waitForTimeout(120);await page.screenshot({path:out+'/'+name+'.png'});
    }
    try{
        if(process.env.GLOBE_BEFORE_FIXTURE){
            const before=await open({width:1440,height:900},2,8,process.env.GLOBE_BEFORE_FIXTURE);
            console.log('BEFORE_RETINA',await expand(before.page));await screenshot(before.page,'globe-resolution-before');await before.context.close();
        }
        const desktop=await open({width:1440,height:900},2),page=desktop.page;
        const overview=await page.evaluate(()=>TrafficGlobe.inspect());
        assert.ok(overview.pixelRatio>1.9&&overview.pixelRatio<=2);
        assert.ok(overview.pixels<=2073600);assert.deepEqual(overview.textureSize,[4096,2048]);
        assert.equal(overview.sphereVertices,97200);assert.ok(overview.bufferBytes<64*1024*1024);
        const full=await expand(page);
        assert.ok(full.pixelRatio>1.99&&full.pixelRatio<=2);
        assert.ok(full.pixels>1800000*2&&full.pixels<=8294400);
        await screenshot(page,'globe-resolution-after');
        // Moving between monitors changes DPR without changing CSS dimensions.
        const cdp=await desktop.context.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
        await page.waitForFunction(()=>TrafficGlobe.inspect().pixelRatio<=1.01);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
        await page.waitForFunction(()=>TrafficGlobe.inspect().pixelRatio>1.5);
        await page.evaluate(()=>{const gl=document.getElementById('traffic-globe').getContext('webgl2');window.globeLoss=gl.getExtension('WEBGL_lose_context');globeLoss.loseContext();});
        await page.waitForFunction(()=>TrafficGlobe.inspect().engine==='Canvas');
        assert.ok((await page.evaluate(()=>TrafficGlobe.inspect().pixels))<=1800000);
        await page.evaluate(()=>globeLoss.restoreContext());await page.waitForFunction(()=>TrafficGlobe.inspect().engine==='WebGL2');
        assert.deepEqual(await page.evaluate(()=>TrafficGlobe.inspect().textureSize),[4096,2048]);
        await page.evaluate(()=>TrafficGlobe.returnMap());
        const frames=await page.evaluate(()=>TrafficGlobe.inspect().frames);await page.waitForTimeout(150);
        assert.equal(await page.evaluate(()=>TrafficGlobe.inspect().frames),frames);
        console.log('RETINA_OVERVIEW',overview);console.log('RETINA_FULLSCREEN',full);
        await desktop.context.close();
        const large=await open({width:3840,height:2160},1),largeState=await expand(large.page);
        assert.ok(largeState.pixelRatio>.99&&largeState.pixelRatio<=1);
        assert.ok(largeState.pixels>7000000&&largeState.pixels<=8294400);
        console.log('NATIVE_4K',largeState);await large.context.close();
        const mobile=await open({width:390,height:844},3,4),mobileState=await expand(mobile.page);
        assert.ok(mobileState.pixelRatio>1.99&&mobileState.pixelRatio<=2);
        assert.ok(mobileState.pixels<=2000000);assert.deepEqual(mobileState.textureSize,[2048,1024]);
        assert.equal(mobileState.sphereVertices,43200);assert.ok(mobileState.bufferBytes<16*1024*1024);
        await screenshot(mobile.page,'globe-resolution-mobile');
        assert.ok(await mobile.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        console.log('MOBILE_HIGH_DPI',mobileState);await mobile.context.close();
        assert.deepEqual(errors,[]);
        console.log('PASS: Retina/4K/mobile resolution, texture and geometry, DPR changes, bounded fallback, restoration and hidden-view sleep');
    }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
