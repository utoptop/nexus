// Isolated two-origin regression. Requires cargo build, Playwright/Chrome, and
// an existing disposable PostgreSQL Docker container (never a production DB).
// Creates and removes only a uniquely named database and its own server process.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os');
const path=require('node:path'),http=require('node:http'),https=require('node:https'),net=require('node:net');
const {execFileSync,spawn}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
const dbContainer=process.env.QA_POSTGRES_CONTAINER||'nexus-qa-db';
const dbName='iplogger_origin_qa_'+process.pid;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'iplogger-origin-'));
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let service,proxy,browser,created=false,logFd;
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function stopService(){if(service&&service.exitCode===null){const done=once(service,'exit');service.kill('SIGTERM');await done;}service=null;}
async function waitServer(port){for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${port}/admin/login`);if(r.status===200)return;}catch{}await sleep(100);}throw new Error('QA server did not start');}
async function handshake(port,origin,cookie,host){return new Promise((resolve,reject)=>{
    const r=http.request({hostname:'127.0.0.1',port,path:'/admin/ws',headers:{Host:host,Origin:origin,Cookie:cookie,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}},res=>{res.resume();resolve(res.statusCode);});
    r.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode);});r.on('error',reject);r.end();
});}
(async()=>{try{
    const info=JSON.parse(docker('inspect',dbContainer))[0];
    const env=Object.fromEntries(info.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
    const pgPort=info.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort;
    assert.ok(pgPort,'QA PostgreSQL must publish a local port');
    const pgUser=env.POSTGRES_USER||'postgres';
    docker('exec',dbContainer,'createdb','-U',pgUser,dbName);created=true;
    const dbUrl=`postgres://${encodeURIComponent(pgUser)}:${encodeURIComponent(env.POSTGRES_PASSWORD||'')}@127.0.0.1:${pgPort}/${dbName}`;
    const servicePort=await freePort();
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key.pem','-out',temp+'/cert.pem','-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
    let primary;
    // Model an alias proxy that keeps the browser's Origin but sends the source
    // site's Host upstream. Both HTTP and WebSocket use this identical proxy.
    const options=req=>({hostname:'127.0.0.1',port:servicePort,path:req.url,method:req.method,headers:{...req.headers,host:new URL(primary).host}});
    proxy=https.createServer({key:fs.readFileSync(temp+'/key.pem'),cert:fs.readFileSync(temp+'/cert.pem')},(req,res)=>{
        const upstream=http.request(options(req),r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
        upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
    });
    proxy.on('upgrade',(req,socket,head)=>{
        const upstream=http.request(options(req));
        upstream.on('upgrade',(r,remote,remoteHead)=>{
            socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n`+Object.entries(r.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
            if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
            socket.pipe(remote);remote.pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
            socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());
        });
        upstream.on('response',r=>{r.resume();socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});
        upstream.on('error',()=>socket.destroy());upstream.end();
    });
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
    const port=proxy.address().port;primary=`https://localhost:${port}`;const alias=`https://127.0.0.1:${port}`;
    logFd=fs.openSync(temp+'/server.log','a');
    async function start(allowed){
        service=spawn(process.env.NEXUS_BIN||path.join(root,'target/debug/nexus'),{cwd:root,env:{...process.env,DATABASE_URL:dbUrl,LISTEN_ADDR:`127.0.0.1:${servicePort}`,ADMIN_PATH:'/admin',PUBLIC_BASE_URL:primary,ALLOWED_ORIGINS:allowed,ADMIN_INITIAL_USERNAME:'admin',ADMIN_INITIAL_PASSWORD:'origin-qa-password-2026',OIDC_CLIENT_ID:'',OIDC_CLIENT_SECRET:'',FRONTEND_ASSET_DIR:path.join(root,'templates/assets'),RUST_LOG:'warn'},stdio:['ignore',logFd,logFd]});
        await waitServer(servicePort);
    }
    await start('');
    execFileSync('docker',['exec','-i',dbContainer,'psql','-U',pgUser,'-d',dbName,'-v','ON_ERROR_STOP=1'],{input:`
INSERT INTO api_keys(token) VALUES('origin-qa-key');
INSERT INTO api_nodes(node_ip,custom_name,location,lat,lon) VALUES('198.18.20.10','Origin QA','Tokyo',35.68,139.69);
INSERT INTO ip_dimensions(ip_address,location,lat,lon) VALUES('8.8.8.8','QA Shanghai',31,121);
`,stdio:['pipe','pipe','pipe']});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const errors=[];
    async function login(origin){const page=await browser.newPage({ignoreHTTPSErrors:true,locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/admin/login');await page.locator('#username').fill('admin');await page.locator('#password').fill('origin-qa-password-2026');await page.locator('#login-form button').click();await page.waitForURL(origin+'/admin');return page;}
    const source=await login(primary),proxied=await login(alias);
    await source.waitForFunction(()=>ws.readyState===1);
    await proxied.waitForSelector('#stream-diagnostic:not([hidden])');
    const cookie=(await proxied.context().cookies()).filter(c=>c.name==='iplogger_session').map(c=>`${c.name}=${c.value}`).join(';');
    assert.equal(await handshake(servicePort,alias,cookie,new URL(primary).host),403);
    const post=async(endpoint,value)=>source.request.post(primary+endpoint,{headers:{Authorization:'Bearer origin-qa-key','X-Node-IP':'198.18.20.10','Content-Type':'application/msgpack'},data:Buffer.from(await source.evaluate(v=>Array.from(MessagePack.encode(v)),value))});
    assert.equal((await post('/api/node/metrics',{rx_bytes_total:0,tx_bytes_total:0,rx_speed_bps:1234,tx_speed_bps:5678})).status(),200);
    await proxied.evaluate(()=>NodeStream.sync(true));
    assert.equal(await proxied.evaluate(()=>nodeQuotaData['198.18.20.10'].online),true);
    assert.equal(await proxied.evaluate(()=>nodeQuotaData['198.18.20.10'].rx_speed),1234);
    assert.equal((await post('/api/track_batch',[{ip:'8.8.8.8',domain:'before.origin.test'}])).status(),200);
    await source.waitForFunction(()=>TrajectoryPool.inspect().admitted===1);
    assert.equal(await proxied.evaluate(()=>TrajectoryPool.inspect().admitted),0);
    console.log('REPRODUCED: source WS connected; alias WS 403; alias online and speed 1234, but no live trajectory.');
    // Change only the server allowlist; the proxy, domains, cookies and database stay the same.
    await stopService();await start(alias);
    await Promise.all([source.reload(),proxied.reload()]);
    for(const page of [source,proxied])await page.waitForFunction(()=>ws.readyState===1&&document.getElementById('stream-diagnostic').hidden);
    const before=await Promise.all([source,proxied].map(p=>p.evaluate(()=>({hits:nodeHits['Origin QA']||0,admitted:TrajectoryPool.inspect().admitted}))));
    assert.equal((await post('/api/track_batch',Array.from({length:7},()=>({ip:'8.8.8.8',domain:'after.origin.test'})))).status(),200);
    for(let i=0;i<2;i++){
        const page=[source,proxied][i];
        await page.waitForFunction(n=>TrajectoryPool.inspect().admitted===n,before[i].admitted+7);
        assert.equal(await page.evaluate(()=>nodeHits['Origin QA']),before[i].hits+7);
        await page.waitForFunction(()=>TrajectoryPool.inspect().drawnByNode['Origin QA']>=7);
    }
    assert.equal(await handshake(servicePort,'https://evil.example',cookie,new URL(primary).host),403);
    assert.equal(await handshake(servicePort,alias,'',new URL(primary).host),401);
    const me=await(await proxied.request.get(alias+'/admin/api/me')).json();
    const change=origin=>proxied.request.post(alias+'/admin/nodes/rename?ip=198.18.20.10&name=Origin%20QA',{headers:{Origin:origin,'X-CSRF-Token':me.user.csrf_token}});
    assert.equal((await change(alias)).status(),200);
    assert.equal((await change('https://evil.example')).status(),403);
    assert.deepEqual(errors,[]);
    console.log('PASS: both origins draw 7 actual visitor trajectories; alias CSRF operation accepted; unlisted origin 403; unauthenticated WS 401.');
}catch(error){if(fs.existsSync(temp+'/server.log'))console.error(fs.readFileSync(temp+'/server.log','utf8').slice(-6000));throw error;}
finally{
    if(browser)await browser.close();await stopService();if(proxy)await new Promise(r=>proxy.close(r));
    if(logFd!==undefined)fs.closeSync(logFd);
    if(created){const info=JSON.parse(docker('inspect',dbContainer))[0];const user=info.Config.Env.find(v=>v.startsWith('POSTGRES_USER='))?.slice(14)||'postgres';docker('exec',dbContainer,'dropdb','-U',user,'--force',dbName);}
    fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
