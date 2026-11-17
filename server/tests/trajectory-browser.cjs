// Real Leaflet + canvas + MessagePack regression tests for multi-node rendering.
const {chromium}=require('playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    try {
        const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        const html=fs.readFileSync('/tmp/observatory-preview.html','utf8');
        await page.route('http://127.0.0.1:4173/**',route=>route.fulfill({contentType:route.request().url().includes('/api/')?'application/json':'text/html',body:route.request().url().includes('/api/')?'{}':html}));
        await page.routeWebSocket('**/ws',()=>{});
        await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded',timeout:60000});
        await page.waitForFunction(()=>window.TrajectoryPool?.inspect().history>0);
        await page.waitForTimeout(800);
        const initial=await page.evaluate(()=>window.TrajectoryPool.inspect());
        assert.equal(initial.historyVisible,true);assert.ok(initial.history>0);assert.ok(initial.drawnHistoryNodes.length>=2);
        console.log('DEFAULT_HISTORY',initial.history,initial.drawnHistoryNodes);
        await page.evaluate(()=>{
            trueNodesMap['Tokyo Backup']=[35.68,139.69];trueNodesMap['West Coast']=[37.77,-122.42];
            nodeAliases['192.0.2.10']='Tokyo Edge';refreshNodeLayout();
            window.sendTestBatch=events=>{const bytes=MessagePack.encode(events);ws.onmessage({data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});};
            window.testEvent=(node,i=0)=>({server_name:node,ip:'198.51.100.'+i,location:'中国 · 上海',lat:25+i%20,lon:100+i%60,target_domain:'test.example',lang:'zh',time:new Date().toISOString(),count:1});
            sendTestBatch([testEvent('192.0.2.10'),testEvent('Direct Access',1),testEvent('Tokyo Backup',2),testEvent('West Coast',3)]);
        });
        await page.waitForFunction(()=>liveQueue.size===0&&window.TrajectoryPool.inspect().drawnNodes.length===4);
        const overview=await page.evaluate(()=>window.TrajectoryPool.inspect());
        console.log('OVERVIEW_NODES',overview.drawnNodes);assert.ok(overview.byNode['Tokyo Edge']);
        assert.equal(await page.evaluate(()=>suspendedNodesMap.has('192.0.2.10')),false);
        const endpoints=await page.evaluate(()=>['Tokyo Edge','Tokyo Backup'].map(n=>window.TrajectoryPool.inspectGeometry(n)[0].b));
        assert.ok(Math.hypot(endpoints[0].x-endpoints[1].x,endpoints[0].y-endpoints[1].y)<1);
        const trueEnd=await page.evaluate(()=>map.latLngToContainerPoint(getTruePos("Tokyo Edge")));
        assert.deepEqual(endpoints[0],trueEnd);
        const toggled=await page.evaluate(()=>{
            const before=window.TrajectoryPool.inspect();toggleHistPath();const off=window.TrajectoryPool.inspect();toggleHistPath();const on=window.TrajectoryPool.inspect();return{before,off,on};
        });
        assert.equal(toggled.off.history,toggled.before.history);assert.equal(toggled.on.routes,toggled.before.routes);assert.equal(toggled.off.historyVisible,false);
        await page.evaluate(()=>switchDashMode('map'));await page.waitForTimeout(350);
        await page.evaluate(()=>{
            const quiet=[testEvent('Tokyo Edge'),testEvent('Tokyo Backup',2),testEvent('West Coast',3)];
            const hot=Array.from({length:15000},(_,i)=>({...testEvent('Direct Access',i),lat:20+(i%400)*0.05,lon:95+(i%1000)*0.05}));
            sendTestBatch([...quiet,...hot]);
        });
        await page.waitForFunction(()=>liveQueue.size===0,{},{timeout:30000});
        await page.waitForTimeout(100);
        const fair=await page.evaluate(()=>window.TrajectoryPool.inspect());
        console.log('MIXED_LOAD',fair.byNode,fair.historyByNode);
        for(const name of ['Tokyo Edge','Tokyo Backup','West Coast','Direct Access']){assert.ok(fair.drawnByNode[name]>0);assert.ok(fair.historyByNode[name]>0);}
        assert.ok(fair.routes<=480);assert.ok(fair.history<=1600);
        // Inspect exact Leaflet coordinates, not just the presence of pool entries.
        await page.evaluate(()=>map.setView([20,170],2,{animate:false}));await page.waitForTimeout(100);
        const wrapped=await page.evaluate(()=>{
            window.TrajectoryPool.fireLine([36,179],[-20,-179],'#2be5ff',1,'Dateline');
            return window.TrajectoryPool.inspectGeometry('Dateline');
        });
        assert.equal(wrapped.length,1);
        const actual=await page.evaluate(()=>({a:map.latLngToContainerPoint([36,179]),b:map.latLngToContainerPoint([-20,-179])}));
        assert.deepEqual(wrapped[0],actual);
        // Show an illustrative mixed-node scene using real map tiles and the production renderer.
        await page.evaluate(()=>{
            map.setView([25,50],2,{animate:false});window.TrajectoryPool.clear();
            const origins=[[51,-0.1],[48,2],[31,121],[34,-118],[-33,151],[55,37],[19,73],[40,-74]];
            origins.forEach((from,i)=>['Direct Access','Tokyo Edge','Tokyo Backup','West Coast'].forEach((node,j)=>{
                const color=getNodeBaseColor(node,1);window.TrajectoryPool.fireLine(from,getTruePos(node),color,1.3,node);window.TrajectoryPool.addHistory(from,getTruePos(node),node,color);
            }));
            baseTileLayer.setOpacity(0.2);
        });
        await page.waitForTimeout(700);
        const light=await page.evaluate(()=>({level:nodeMarkers['Direct Access'].getElement().dataset.activity,shadow:getComputedStyle(nodeMarkers['Direct Access'].getTooltip().getElement()).boxShadow,engine:window.TrajectoryPool.inspect().engine}));
        assert.ok(Number(light.level)>0);assert.notEqual(light.shadow,'none');assert.equal(light.engine,'WebGL2');console.log('NODE_LIGHT',light);
        await page.screenshot({path:'/tmp/straight-trajectories.png'});
        await page.waitForTimeout(3500);
        const idle=await page.evaluate(()=>{
            const pixels=(()=>{const c=document.querySelector('.traffic-history');return c.getContext('2d').getImageData(0,0,c.width,c.height).data;})();
            let drawn=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)drawn++;
            return {...window.TrajectoryPool.inspect(),drawn};
        });
        console.log('IDLE_HISTORY',idle.routes,idle.history,idle.drawn);
        assert.equal(idle.routes,0);assert.ok(idle.history>0);assert.ok(idle.drawn>100);
        await page.waitForTimeout(14000);
        const frames=await page.evaluate(()=>window.TrajectoryPool.inspect().frameCount);await page.waitForTimeout(300);
        assert.equal(await page.evaluate(()=>window.TrajectoryPool.inspect().frameCount),frames);
        // Node selection excludes other nodes, including payloads using an IP alias.
        await page.evaluate(()=>{currentFilters.splice(0,currentFilters.length,'Tokyo Edge');window.TrajectoryPool.clear();sendTestBatch([testEvent('Direct Access'),testEvent('192.0.2.10')]);});
        await page.waitForFunction(()=>liveQueue.size===0&&window.TrajectoryPool.inspect().drawnNodes.includes('Tokyo Edge'));
        assert.deepEqual(await page.evaluate(()=>Object.keys(window.TrajectoryPool.inspect().byNode)),['Tokyo Edge']);
        await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(800);
        await page.evaluate(()=>{map.setView([25,90],1,{animate:false});baseTileLayer.setOpacity(0.2);});
        await page.waitForFunction(()=>!baseTileLayer.isLoading(),{},{timeout:15000});
        await page.evaluate(()=>{
            const events=['Direct Access','Tokyo Edge'].map((node,i)=>({server_name:node,ip:'198.51.100.'+i,location:'Shanghai',lat:31,lon:121,time:new Date().toISOString(),lang:'en',target_domain:'test',count:1}));
            const bytes=MessagePack.encode(events);ws.onmessage({data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
        });
        await page.waitForFunction(()=>window.TrajectoryPool.inspect().drawnNodes.length===2);
        const mobile=await page.evaluate(()=>window.TrajectoryPool.inspect());
        assert.equal(mobile.historyVisible,true);assert.ok(mobile.historyByNode['Tokyo Edge']);
        console.log('MOBILE_NODES',mobile.drawnNodes);
        await page.waitForTimeout(400);
        const nodeBox=await page.evaluate(()=>{const r=nodeMarkers['Tokyo Edge'].getTooltip().getElement().getBoundingClientRect();return{left:r.left,right:r.right};});
        assert.ok(nodeBox.left>=0 && nodeBox.right<=390);
        await page.screenshot({path:'/tmp/straight-trajectories-mobile.png'});
        await page.setViewportSize({width:3840,height:2160});await page.waitForTimeout(250);
        const pixels=await page.evaluate(()=>({pixels:window.TrajectoryPool.inspect().canvasPixels,budget:renderLimits.pixelBudget}));
        assert.ok(pixels.pixels<=pixels.budget+10000);console.log('CANVAS_PIXEL_BUDGET',pixels);
        assert.deepEqual(errors,[]);console.log('Multi-node and persistent-history regressions passed');
    } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
