// Fresh-install regression using locally built TOML-capable Docker images.
// Creates/removes only its own Compose project, named volume and containers.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os');
const path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process'),{once}=require('node:events');
const root=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-config-compose-'));
const project='nexus-config-compose-'+process.pid,source=project+'-source',agent=project+'-agent';
const serverImage=process.env.NEXUS_IMAGE||'nexus:config-test';
const agentImage=process.env.AGENT_IMAGE||'nexus-agent:config-test';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:120000}).trim();
const compose=(...args)=>docker('compose','--project-directory',temp,'-p',project,...args);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let browser,started=false;
(async()=>{try{
    const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
    const port=listener.address().port;await new Promise(r=>listener.close(r));
    const origin=`http://localhost:${port}`,alias=`http://127.0.0.1:${port}`;
    const yaml=fs.readFileSync(root+'/docker-compose.yaml','utf8')
        .replace('utoptop/nexus:1.0',serverImage).replace('context: ./server','context: '+root+'/server')
        .replace('127.0.0.1:3001:3000',`127.0.0.1:${port}:3000`)
        .replace('./pgdata:/var/lib/postgresql/data','test-pgdata:/var/lib/postgresql/data');
    fs.writeFileSync(temp+'/docker-compose.yaml',yaml+'\nvolumes:\n  test-pgdata:\n');
    fs.mkdirSync(temp+'/config',{mode:0o700});
    const config=fs.readFileSync(root+'/config/nexus.toml.example','utf8')
        .replace('https://nexus.example.com',origin).replace('allowed_origins = []',`allowed_origins = ["${alias}"]`)
        .replace('initial_password = ""','initial_password = "config-compose-password"');
    fs.writeFileSync(temp+'/config/nexus.toml',config,{mode:0o644});
    fs.writeFileSync(temp+'/config/postgres-password','config-compose-db-password\n',{mode:0o644});
    fs.copyFileSync(root+'/config/postgresql.conf',temp+'/config/postgresql.conf');
    assert.equal(fs.existsSync(temp+'/.env'),false);
    started=true;
    assert.match(compose('run','--rm','--no-deps','nexus','--config','/etc/nexus/nexus.toml','--check-config'),/configuration is valid/);
    compose('up','-d','--no-build');
    let ready=false;
    for(let i=0;i<150;i++){try{if((await fetch(origin+'/admin/login')).status===200){ready=true;break;}}catch{}await sleep(200);}
    assert.ok(ready,'Nexus server must become ready');
    execFileSync('docker',['compose','--project-directory',temp,'-p',project,'exec','-T','db','psql','-U','nexus','-d','nexus','-v','ON_ERROR_STOP=1'],{
        encoding:'utf8',input:"INSERT INTO api_keys(token) VALUES('config-compose-key');\nINSERT INTO api_nodes(node_ip,custom_name,location,lat,lon) VALUES('198.18.20.10','Config QA','Tokyo',35.68,139.69);\nINSERT INTO ip_dimensions(ip_address,location,lat,lon) VALUES('8.8.8.8','QA Shanghai',31,121);\n"
    });
    docker('run','-d','--name',source,'--log-driver','json-file','--entrypoint','python3','nexus-agent-bench-fixture','-u','-c','import time;time.sleep(600)');
    fs.writeFileSync(temp+'/agent.toml',`server_url="http://nexus:3000/api/track_batch"\nauth_token="config-compose-key"\nnode_ip="198.18.20.10"\nmonitor_containers=["${source}"]\n`);
    docker('run','-d','--name',agent,'--network',project+'_nexus','-v','/var/run/docker.sock:/var/run/docker.sock:ro',
        '-v',temp+'/agent.toml:/etc/nexus-agent/nexus-agent.toml:ro',agentImage);
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const errors=[],pages=[];
    for(const base of [origin,alias]){
        const page=await browser.newPage({locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));
        await page.goto(base+'/admin/login');
        assert.equal(await page.locator('script[src*="challenges.cloudflare.com"]').count(),0);
        await page.locator('#username').fill('admin');await page.locator('#password').fill('config-compose-password');
        await page.locator('#login-form button').click();await page.waitForURL(base+'/admin');
        await page.waitForFunction(()=>ws.readyState===1&&document.getElementById('stream-diagnostic').hidden);
        await page.waitForFunction(()=>nodeQuotaData['198.18.20.10']?.online===true);
        assert.match(await page.title(),/NEXUS/i);pages.push(page);
    }
    const before=await Promise.all(pages.map(p=>p.evaluate(()=>({hits:nodeHits['Config QA']||0,admitted:TrajectoryPool.inspect().admitted}))));
    const records=[
        'TRACK_L7|8.8.8.8|{config.example}|',
        '8.8.8.8 - - [17/Nov/2026:12:00:00 +0800] "GET /config HTTP/1.1" 200 100 "-" "config-test"',
        'haproxy[42]: 8.8.8.8:1234 [17/Nov/2026:12:00:00.000] front back/srv 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 "GET /config HTTP/1.1"'
    ];
    docker('exec',source,'python3','-c',`import os;fd=os.open('/proc/1/fd/1',os.O_WRONLY);os.write(fd,${JSON.stringify(records.join('\n')+'\n')}.encode());os.close(fd)`);
    for(let i=0;i<pages.length;i++){
        await pages[i].waitForFunction(n=>TrajectoryPool.inspect().admitted===n,before[i].admitted+3);
        assert.equal(await pages[i].evaluate(()=>nodeHits['Config QA']),before[i].hits+3);
        await pages[i].waitForFunction(()=>TrajectoryPool.inspect().drawnByNode['Config QA']>=3);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: fresh Compose without .env, shared password file, config validation, login, agent Docker logs, online metrics and trajectories on both origins.');
}catch(error){
    if(started)try{console.error(compose('logs','--tail=60','nexus','db'));}catch{}
    try{console.error(docker('logs','--tail','60',agent));}catch{}
    throw error;
}finally{
    if(browser)await browser.close();
    try{docker('rm','-f',agent,source);}catch{}
    if(started)try{compose('down','-v','--remove-orphans');}catch{}
    fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
