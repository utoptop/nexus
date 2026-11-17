// Baseline audit for the current 1.2 agent. Requires a disposable QA server at
// :4188 (/qa/console) and the named disposable PostgreSQL container below.
// Reads logs ONLY from its own fixture container, never from auto discovery.
const {chromium}=require('playwright'),{execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const prefix='visitor-audit-'+process.pid,source=prefix+'-source',agent=prefix+'-agent';
const origin='http://127.0.0.1:4188',base='/qa/console',ip='198.18.20.10';
const emit=line=>docker('exec',source,'python3','-c',"import sys;f=open('/proc/1/fd/1','w');print(sys.argv[1],file=f,flush=True)",line);
(async()=>{
 execFileSync('docker',['exec','-i','iplogger-visitor-qa-20261117','psql','-U','postgres','-d','iplogger_qa','-v','ON_ERROR_STOP=1'],{input:`
 INSERT INTO api_keys(token) VALUES('qa-agent-visitor-key') ON CONFLICT DO NOTHING;
 INSERT INTO api_nodes(node_ip,custom_name,location,lat,lon) VALUES('${ip}','Agent audit','Tokyo',35.68,139.69) ON CONFLICT DO NOTHING;
 INSERT INTO ip_dimensions(ip_address,location,lat,lon) VALUES('8.8.8.8','QA Shanghai',31,121),('8.8.4.4','QA Singapore',1,103),('9.9.9.9','QA London',51,-.1) ON CONFLICT DO NOTHING;
 `,stdio:['pipe','pipe','pipe']});
 let browser;
 try{
  docker('run','-d','--name',source,'--log-driver','json-file','--entrypoint','python3','logger-agent-bench-fixture','-u','-c','import time;time.sleep(600)');
  docker('run','-d','--name',agent,'-v','/var/run/docker.sock:/var/run/docker.sock:ro',
   '-e','SERVER_URL=http://host.docker.internal:4188/api/track_batch','-e','AUTH_TOKEN=qa-agent-visitor-key','-e','NODE_IP='+ip,'-e','MONITOR_CONTAINERS='+source,'logger-agent:performance-local');
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+base+'/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('qa-admin-password-2026');await page.locator('#login-form button').click();await page.waitForURL(origin+base);
  await page.waitForFunction(()=>typeof ws!=='undefined'&&ws.readyState===1);
  await page.waitForFunction(ip=>nodeQuotaData[ip]?.online&&nodeQuotaData[ip]?.rx_speed>0,ip);
  const baseline=await page.evaluate(()=>({visits:nodeHits['Agent audit']||0,admitted:TrajectoryPool.inspect().admitted}));
  const stamp=await page.evaluate(ip=>nodeQuotaData[ip].last_report_ms,ip);
  emit('{"ClientHost":"8.8.4.4","RequestHost":"qa.example","RequestMethod":"GET","RequestPath":"/","RequestProtocol":"HTTP/1.1","DownstreamStatus":200}');
  emit('{"remote_addr":"8.8.8.8","host":"qa.example","request":"GET / HTTP/1.1","status":200}');
  emit('haproxy[42]: 9.9.9.9:1234 [17/Nov/2026:12:00:00.000] front back/srv 0/1/10 123 -- 1/1/1/1/0 0/0');
  emit('172.18.0.5 - - [17/Nov/2026:12:00:00 +0800] "GET / HTTP/1.1" 200 123 "-" "test"');
  await page.waitForFunction(({ip,stamp})=>nodeQuotaData[ip].last_report_ms>stamp+4000,{ip,stamp});
  assert.equal(await page.evaluate(()=>nodeHits['Agent audit']||0),baseline.visits);
  const stuck=await page.evaluate(ip=>({online:nodeQuotaData[ip].online,rx:nodeQuotaData[ip].rx_speed,tx:nodeQuotaData[ip].tx_speed,visits:nodeHits['Agent audit']||0}),ip);
  console.log('REPRODUCED_METRICS_WITHOUT_VISITORS',stuck);
  emit('8.8.8.8 - - [17/Nov/2026:12:00:00 +0800] "GET / HTTP/1.1" 200 123 "-" "test"');
  emit('haproxy[42]: 9.9.9.9:1234 [17/Nov/2026:12:00:00.000] front back/srv 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 "GET / HTTP/1.1"');
  emit('8.8.4.4 - - [17/Nov/2026:12:00:00 +0800] "GET / HTTP/1.1" 200 123 "-" "test" 1 "router" "http://backend" 2ms');
  // User's full original HAProxy format, including Host capture and trailing protocol/ALPN.
  emit('TRACK_L7|8.8.8.8|{qa.example}| 8.8.8.8:45678 [17/Nov/2026:12:00:00.000] frontend~ backend/server 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 "GET / HTTP/1.1" HTTP/1.1 h2');
  await page.waitForFunction(n=>(nodeHits['Agent audit']||0)===n,baseline.visits+4);
  assert.equal(await page.evaluate(()=>TrajectoryPool.inspect().admitted),baseline.admitted+4);
  assert.ok(await page.evaluate(()=>Array.from(statsMap.values()).some(s=>s[7]==='Agent audit'&&s[8]==='qa.example')),'original HAProxy Host capture must survive parsing');
  await page.waitForFunction(()=>TrajectoryPool.inspect().drawnByNode['Agent audit']>0);
  assert.deepEqual(errors,[]);
  console.log('PASS: same running agent, same node, same API/WebSocket/map: supported access logs, including the user\'s full TRACK_L7 format, produce 4 actual trajectories; unsupported/filtered logs leave metrics online with zero visits.');
 }finally{
  if(browser)await browser.close();
  for(const name of [agent,source])try{docker('rm','-f',name);}catch(_){}
 }
})().catch(e=>{console.error(e);process.exit(1)});
