// Requires disposable QA service on 4188, QA API key, and fixtures/node-faults.sql loaded ONLY in the QA database; no mocked WebSocket.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const origin='http://127.0.0.1:4188',base='/qa/console';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('qa-admin-password-2026');await page.locator('#login-form button').click();await page.waitForURL(origin+base);await page.waitForFunction(()=>typeof ws!=='undefined'&&ws.readyState===1);
 const ip='203.0.113.'+(100+Date.now()%100),headers={Authorization:'Bearer qa-node-api-key','X-Node-IP':ip,'Content-Type':'application/msgpack'};
 const pack=async value=>Buffer.from(await page.evaluate(value=>Array.from(MessagePack.encode(value)),value));
 const post=async(path,value,h=headers)=>page.request.post(origin+path,{data:await pack(value),headers:h});
 assert.equal((await post('/api/track_batch',[],{...headers,Authorization:'Bearer invalid'})).status(),401);
 assert.equal((await page.request.get(origin+'/api/nodes')).status(),404);
 const failed=await post('/api/track_batch',[],{...headers,'X-Node-IP':'198.18.0.250'});assert.equal(failed.status(),503);assert.equal(failed.headers()['retry-after'],'2');
 const registration=await post('/api/track_batch',[]);assert.equal(registration.status(),200);
 const snap=async()=>{const r=await page.request.get(origin+base+'/api/nodes');assert.equal(r.status(),200);return (await r.json()).nodes;};
 assert.ok((await snap()).some(n=>n.ip===ip),'registration must exist before returning 200');
 await page.waitForFunction(ip=>!!trueNodesMap[ip],ip);assert.equal(await page.evaluate(ip=>suspendedNodesMap.has(ip),ip),false);
 const payload={rx_bytes_total:100000,tx_bytes_total:200000,rx_speed_bps:1000,tx_speed_bps:2000};assert.equal((await post('/api/node/metrics',payload)).status(),200);
 await page.waitForFunction(ip=>nodeQuotaData[ip]?.rx_speed===1000,ip);
 const initial=(await snap()).find(n=>n.ip===ip);assert.equal(initial.rx_bytes,2000);assert.equal(initial.tx_bytes,4000);
 const bytes=await pack(payload);await Promise.all(Array.from({length:12},async()=>{const r=await page.request.post(origin+'/api/node/metrics',{headers,data:bytes});assert.equal(r.status(),200);}));
 const summed=(await snap()).find(n=>n.ip===ip);assert.equal(summed.rx_bytes,26000);assert.equal(summed.tx_bytes,52000);
 assert.equal((await post('/api/node/metrics',{...payload,rx_speed_bps:7777})).status(),503);assert.equal((await snap()).find(n=>n.ip===ip).rx_bytes,26000);
 const received=await page.evaluate(()=>TrajectoryPool.inspect().admitted);assert.equal((await post('/api/track_batch',[{ip:'198.51.100.20',domain:'qa.example'}])).status(),200);
 await page.waitForFunction(before=>TrajectoryPool.inspect().admitted>before,received);
 assert.ok(await page.evaluate(ip=>nodeHits[ip]>=1,ip));
 // A metrics-only agent must also be able to register, without a handshake race.
 const second=ip.replace('203.0.113.','203.0.114.');assert.equal((await post('/api/node/metrics',payload,{...headers,'X-Node-IP':second})).status(),200);assert.ok((await snap()).some(n=>n.ip===second));
 await page.evaluate(()=>toggleNetMenu());assert.match(await page.locator('#net-nodes-container').innerText(),/KB\/s/);
 await page.evaluate(()=>ws.close());await page.waitForSelector('#stream-diagnostic:not([hidden])');assert.match(await page.locator('#stream-diagnostic').innerText(),/\/qa\/console\/ws/);
 await page.waitForFunction(()=>ws.readyState===1&&document.getElementById('stream-diagnostic').hidden,{},{timeout:15000});
 assert.deepEqual(errors,[]);console.log('Node ingestion PASS: real session/WebSocket, root agent APIs, synchronous registration, new-node discovery, metrics-only registration, concurrent counters, live visitors, reconnect diagnostics');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
