require('node:fs').mkdirSync('/tmp/nexus-artifacts',{recursive:true});
// Disposable QA service/database only. Exercises real API + WebSocket + both renderers.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const origin='http://127.0.0.1:4188',base='/qa/console',container='iplogger-presence-qa-20261117';
const sql=text=>execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','iplogger_qa','-v','ON_ERROR_STOP=1'],{input:text,stdio:['pipe','pipe','pipe']});
const out='/tmp/nexus-artifacts';
(async()=>{
 sql(`DELETE FROM visitor_logs; DELETE FROM api_nodes;
 INSERT INTO api_keys(token) VALUES('qa-node-api-key') ON CONFLICT DO NOTHING;
 INSERT INTO api_nodes(node_ip,custom_name,location,lat,lon,last_report_at,last_metrics_at) VALUES
 ('198.18.10.11','A Offline','Shanghai',31.23,121.47,CURRENT_TIMESTAMP-INTERVAL '1 hour',NULL),
 ('198.18.10.12','Z Online','Tokyo',35.68,139.69,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('198.18.10.13','B Never reported','Singapore',1.35,103.82,NULL,NULL);
 INSERT INTO ip_dimensions(ip_address,location,lat,lon) VALUES('198.51.100.20','QA visitor',27,90) ON CONFLICT DO NOTHING;`);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
  await page.goto(origin+base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('qa-admin-password-2026');await page.locator('#login-form button').click();await page.waitForURL(origin+base);
  await page.waitForFunction(()=>window.NodeStream&&typeof ws!=='undefined'&&ws.readyState===1);
  const snapshot=async()=>{const r=await page.request.get(origin+base+'/api/nodes');assert.equal(r.status(),200);return(await r.json()).nodes;};
  const post=async(ip,path,payload)=>page.request.post(origin+path,{headers:{Authorization:'Bearer qa-node-api-key','X-Node-IP':ip,'Content-Type':'application/msgpack'},data:Buffer.from(await page.evaluate(v=>Array.from(MessagePack.encode(v)),payload))});
  const metric=ip=>post(ip,'/api/node/metrics',{rx_bytes_total:0,tx_bytes_total:0,rx_speed_bps:0,tx_speed_bps:0});
  let nodes=await snapshot(),stale=nodes.find(n=>n.ip==='198.18.10.11');assert.equal(stale.online,false);assert.equal(nodes.find(n=>n.ip==='198.18.10.13').last_report_ms,null);assert.equal(nodes.find(n=>n.ip==='198.18.10.13').online,false);assert.equal(nodes[0].name,'Z Online');
  await page.waitForFunction(()=>document.querySelectorAll('#nodes-tbody .node-status-badge').length===4);
  const order=()=>page.locator('#nodes-tbody tr').evaluateAll(rows=>rows.map(r=>({name:r.cells[0].textContent,online:r.dataset.online})));
  assert.deepEqual((await order()).map(r=>r.online),['true','true','false','false']);
  await page.evaluate(()=>{openSettings();switchTab('nodes');});
  await page.screenshot({path:out+'/nodes-online-offline-settings.png'});
  await page.evaluate(()=>closeSettings());
  await page.waitForFunction(()=>nodeMarkers['A Offline']?.getElement()?.dataset.offline==='true');
  const mapState=()=>page.evaluate(()=>{const m=nodeMarkers['A Offline'];return {offline:m.getTooltip().getElement()?.dataset.offline,color:m._nativeColor,dot:nodeTrueDots['A Offline'].options.fillColor,pulse:getComputedStyle(m.getElement().querySelector('.node-pulse')).display};});
  assert.deepEqual(await mapState(),{offline:'true',color:'#8793a3',dot:'#8793a3',pulse:'none'});
  // Playback/visitor activity cannot revive a disconnected agent.
  await page.evaluate(()=>{for(const name of ['A Offline','Z Online'])queueLiveEvent({ip:'198.51.100.20',server_name:name,location:'QA',lat:27,lon:90,time:new Date().toISOString(),count:400,lang:'Historical',target_domain:'qa.example'});});
  await page.waitForFunction(()=>nodeHits['A Offline']===400);assert.equal((await mapState()).color,'#8793a3');
  await page.screenshot({path:out+'/nodes-online-offline-map.png'});
  await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});
  await page.waitForFunction(()=>TrafficGlobe.inspectLight('A Offline')?.offline===true);
  let light=await page.evaluate(()=>TrafficGlobe.inspectLight('A Offline'));assert.equal(light.color,'#8793a3');assert.equal(light.energy,0);
  await page.waitForFunction(()=>document.querySelector('.globe-node-label[data-node="A Offline"]')?.dataset.offline==='true');
  assert.ok((await page.evaluate(()=>TrafficGlobe.inspectLight('Z Online').energy))>0);
  await page.screenshot({path:out+'/nodes-online-offline-globe.png'});
  // Idle nodes stay online through metrics, even with zero speed and zero visitors.
  assert.equal((await metric('198.18.10.12')).status(),200);assert.equal((await snapshot()).find(n=>n.ip==='198.18.10.12').online,true);
  // Updates do not destroy edits or move the focused row. Sort after leaving it.
  await page.evaluate(()=>{TrafficGlobe.returnMap();openSettings();switchTab('nodes');});
  await page.locator('#name-198-18-10-12').fill('Unsaved draft');const before=await order();
  assert.equal((await post('198.18.10.11','/api/track_batch',[])).status(),200);
  await page.waitForFunction(()=>!NodeStream.isOffline('A Offline'));
  assert.equal(await page.locator('#name-198-18-10-12').inputValue(),'Unsaved draft');assert.ok(await page.locator('#name-198-18-10-12').evaluate(e=>e===document.activeElement));assert.deepEqual((await order()).map(r=>r.name),before.map(r=>r.name));
  await page.locator('#name-198-18-10-12').evaluate(e=>e.blur());
  await page.waitForFunction(()=>document.querySelector('#nodes-tbody').rows[1].cells[0].textContent==='198.18.10.11');
  await page.evaluate(()=>closeSettings());assert.notEqual((await mapState()).color,'#8793a3');
  await page.evaluate(stale=>NodeStream.apply(stale),stale);assert.equal(await page.evaluate(()=>NodeStream.isOffline('A Offline')),false,'stale HTTP metadata cannot undo a fresh WS report');
  // Server time determines status; arbitrary browser clock changes cannot expire it.
  await page.evaluate(()=>{window.originalDateNow=Date.now;Date.now=()=>originalDateNow()+864000000;});assert.equal((await metric('198.18.10.11')).status(),200);await page.evaluate(()=>Date.now=originalDateNow);
  // Stop near the real timeout, without faking the browser deadline or the API result.
  sql("INSERT INTO api_nodes(node_ip,custom_name,location,lat,lon,last_report_at) VALUES('198.18.10.14','C Expiring','London',51.5,-.1,CURRENT_TIMESTAMP-INTERVAL '28 seconds')");
  assert.equal((await snapshot()).find(n=>n.ip==='198.18.10.14').online,true);await page.evaluate(()=>NodeStream.sync(true));
  await page.waitForFunction(()=>NodeStream.isOffline('C Expiring'),{},{timeout:6000});assert.equal((await snapshot()).find(n=>n.ip==='198.18.10.14').online,false);
  assert.equal(await page.locator('#row-198-18-10-14 .node-status-badge').textContent(),'离线');
  await page.evaluate(()=>{switchDashMode('dashboard');TrafficGlobe.setExpanded(true);});await page.waitForFunction(()=>TrafficGlobe.inspectLight('C Expiring')?.offline);
  // Canvas fallback consumes exactly the same offline lights and labels.
  await page.evaluate(()=>document.getElementById('traffic-globe').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());await page.waitForFunction(()=>TrafficGlobe.inspect().engine==='Canvas');
  assert.equal(await page.evaluate(()=>TrafficGlobe.inspectLight('C Expiring').color),'#8793a3');
  assert.equal((await metric('198.18.10.14')).status(),200);await page.waitForFunction(()=>TrafficGlobe.inspectLight('C Expiring')?.offline===false);
  assert.notEqual(await page.evaluate(()=>TrafficGlobe.inspectLight('C Expiring').color),'#8793a3');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{TrafficGlobe.returnMap();openSettings();switchTab('nodes');});await page.screenshot({path:out+'/nodes-online-offline-mobile.png'});
  const mobile=await page.locator('#nodes-tbody .node-status-badge').evaluateAll(els=>els.map(e=>({x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right})));assert.ok(mobile.every(r=>r.x>=0&&r.right<=390),'every status must be visible without horizontal scrolling');
  assert.ok(await page.locator('#nodes').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  assert.deepEqual(errors,[]);console.log('PASS: actual report-based state, never-reported nodes, sorted settings, edit retention, gray map/WebGL/Canvas, playback isolation, expiry/recovery, stale snapshots, clock skew and mobile');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
