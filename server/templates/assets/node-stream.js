// Reconcile authenticated server node metadata before admitting its visitor events.
window.NodeStream = (() => {
    let request=null,lastSync=-10000,pending=[],lastPoll=0;
    const registrations=new Map();
    const presence=new Map(),byName=new Map(),dirtyPresence=new Set();
    let presenceQueued=false,needsSort=false;
    const rowId=ip=>'row-'+ip.replace(/[^a-zA-Z0-9]/g,'-');
    function isOffline(name){return name!=='Direct Access'&&byName.get(nodeAliases[name]||name)?.online===false;}
    function sortRows(){
        if(!needsSort)return;
        const body=document.getElementById('nodes-tbody');if(!body||body.contains(document.activeElement))return;
        needsSort=false;
        const rows=[...body.rows],ordered=rows.slice().sort((a,b)=>
            Number(b.dataset.online==='true')-Number(a.dataset.online==='true')||
            Number(b.id==='row-Direct-Access')-Number(a.id==='row-Direct-Access')||
            (a.cells[2].textContent||a.id).localeCompare(b.cells[2].textContent||b.id)||a.id.localeCompare(b.id));
        // Heartbeats update text in place; only a status/name change moves a row.
        ordered.forEach((row,i)=>{if(body.rows[i]!==row)body.insertBefore(row,body.rows[i]||null);});
    }
    function renderPresence(){
        presenceQueued=false;
        for(const ip of dirtyPresence){
            const p=presence.get(ip),row=document.getElementById(rowId(ip));if(!p||!row)continue;
            row.dataset.online=String(p.online);const cell=row.cells[4];cell.classList.remove('utc');delete cell.dataset.u;
            const signature=p.online+':'+p.lastReport;
            if(cell.dataset.presence!==signature){
                cell.dataset.presence=signature;
                const badge=document.createElement('span');badge.className='node-status-badge';badge.dataset.online=String(p.online);badge.textContent=p.online?(isZh?'在线':'Online'):(isZh?'离线':'Offline');
                const seen=document.createElement('small');seen.className='node-last-seen';seen.textContent=p.lastReport===null?(isZh?'尚未收到上报':'No report received'):(isZh?'最近上报 ':'Last report ')+new Date(p.lastReport).toLocaleString();
                cell.replaceChildren(badge,seen);
            }
        }
        dirtyPresence.clear();
        const direct=document.getElementById('row-Direct-Access');if(direct){direct.dataset.online='true';const cell=direct.cells[4];if(!cell.querySelector('.node-status-badge')){cell.innerHTML='<span class="node-status-badge" data-online="true"></span><small class="node-last-seen"></small>';cell.firstChild.textContent=isZh?'在线':'Online';cell.lastChild.textContent=isZh?'主服务节点':'Main service';}}
        const summary=document.getElementById('node-presence-summary');if(summary){const online=[...presence.values()].filter(p=>p.online).length+(direct?1:0),offline=presence.size-online+(direct?1:0);const text=isZh?`${online} 个在线 · ${offline} 个离线 · 30 秒未上报视为离线`:`${online} online · ${offline} offline · Offline after 30s without a report`;if(summary.textContent!==text)summary.textContent=text;}
        sortRows();
    }
    function schedulePresence(ip){if(ip)dirtyPresence.add(ip);if(!presenceQueued){presenceQueued=true;queueMicrotask(renderPresence);}}
    function refreshVisual(name){
        updateSingleNodeBubble(name);const m=nodeMarkers[name];if(m)updateNodeActivity(name,m._activityLevel||0,m._activityEnergy||0,m._activityBurst||0);
    }
    function acceptPresence(n,latency=0){
        if(typeof n.online!=='boolean')return;
        const old=presence.get(n.ip),lastReport=Number.isFinite(n.last_report_ms)?n.last_report_ms:null;
        if(old&&old.lastReport!==null&&(lastReport===null||lastReport<old.lastReport))return;
        let deadline=performance.now()+Math.max(0,(n.offline_after_ms||30000)-(n.report_age_ms||0)-latency);
        if(old&&old.lastReport===lastReport)deadline=Math.min(deadline,old.deadline);
        const online=n.online&&lastReport!==null&&deadline>performance.now();
        const p={name:n.name,lastReport,deadline,online};presence.set(n.ip,p);byName.set(n.name,p);
        if(old&&old.name!==n.name)byName.delete(old.name);
        schedulePresence(n.ip);
        if(!old||old.online!==online||old.name!==n.name){needsSort=true;overviewRevision++;refreshVisual(n.name);}
    }
    function expirePresence(){
        const now=performance.now();for(const [ip,p] of presence)if(p.online&&now>=p.deadline){p.online=false;needsSort=true;schedulePresence(ip);overviewRevision++;refreshVisual(p.name);}
    }
    function remove(ip){const p=presence.get(ip);if(p)byName.delete(p.name);presence.delete(ip);registrations.delete(ip);needsSort=true;schedulePresence();}
    function rename(ip,name){const p=presence.get(ip);if(!p)return;byName.delete(p.name);p.name=name;byName.set(name,p);needsSort=true;schedulePresence(ip);}
    function nodeRow(n){
        const id=n.ip.replace(/[^a-zA-Z0-9]/g,'-'),body=document.getElementById('nodes-tbody');
        let row=document.getElementById('row-'+id);
        if(!row&&body){
            row=document.createElement('tr');row.id='row-'+id;
            for(let i=0;i<5;i++)row.appendChild(document.createElement('td'));
            const code=document.createElement('code');code.textContent=n.ip;row.cells[0].append(code);
            const label=document.createElement('span');label.id='display-name-'+id;row.cells[2].append(label);
            const name=document.createElement('input');name.type='text';name.id='name-'+id;name.value=n.name;name.placeholder='Rename';name.style.width='100px';
            const location=document.createElement('input');location.type='text';location.id='locip-'+id;location.placeholder='Real Public IP';location.style.width='140px';
            const save=document.createElement('button');save.type='button';save.id='btn-'+id;save.className='primary-btn';save.textContent=isZh?'修改并定位':'Save & Locate';save.onclick=e=>renameNode(n.ip,id,nodeAliases[n.ip]||n.ip,e);
            const remove=document.createElement('button');remove.type='button';remove.className='danger-btn';remove.textContent=isZh?'移除':'Remove';remove.onclick=e=>deleteNode(n.ip,nodeAliases[n.ip]||n.ip,remove,e);
            const actions=document.createElement('div');actions.style.cssText='display:flex;gap:5px;flex-wrap:wrap';actions.append(name,location,save,remove);row.cells[3].append(actions);body.prepend(row);
        }
        if(row){row.cells[1].textContent=n.location;const label=document.getElementById('display-name-'+id);if(label)label.textContent=n.name;}
    }
    function apply(n,latency=0){
        if(!n||typeof n.ip!=='string'||typeof n.name!=='string'||rejectedNodes.has(n.ip)||rejectedNodes.has(n.name))return;
        const previousReport=presence.get(n.ip)?.lastReport;
        if(previousReport!==null&&previousReport!==undefined&&(n.last_report_ms===null||n.last_report_ms<previousReport))return;
        const previous=nodeAliases[n.ip],existed=!!trueNodesMap[n.name];
        nodeAliases[n.ip]=n.name;nodeAliases[n.name]=n.name;
        if(previous&&previous!==n.name){nodeAliases[previous]=n.name;delete trueNodesMap[previous];nodeHits[n.name]=(nodeHits[n.name]||0)+(nodeHits[previous]||0);delete nodeHits[previous];}
        const valid=Number.isFinite(n.lat)&&Number.isFinite(n.lon)&&(n.lat!==0||n.lon!==0);
        const pos=valid?[n.lat,n.lon]:(trueNodesMap[n.name]||getTruePos('Direct Access'));
        const moved=!existed||trueNodesMap[n.name][0]!==pos[0]||trueNodesMap[n.name][1]!==pos[1]||previous&&previous!==n.name;
        trueNodesMap[n.name]=pos;nodeQuotaData[n.ip]={...n};
        const signature=n.name+'|'+n.location+'|'+pos.join(',');
        if(registrations.get(n.ip)!==signature){registrations.set(n.ip,signature);nodeRow(n);needsSort=true;
            for(const menu of document.querySelectorAll('.multi-sel-menu')){
                if([...menu.querySelectorAll('.node-cb')].some(e=>e.value===n.name))continue;
                const label=document.createElement('label'),input=document.createElement('input'),span=document.createElement('span');input.type='checkbox';input.className='node-cb';input.value=n.name;input.checked=currentFilters.includes('All');input.onchange=updateAllCb;span.textContent=' 📌 '+n.name;label.append(input,span);menu.insertBefore(label,menu.querySelector('.apply-btn'));
            }
        }
        acceptPresence(n,latency);
        if(suspendedNodesMap.delete(n.name)||suspendedNodesMap.delete(n.ip))renderSuspendedList();
        document.getElementById('toast-'+n.name)?.remove();
        if(moved){overviewRevision++;scheduleNodeLayout();}
        if(document.getElementById('left-net-menu').classList.contains('open')){
            if(!existed)renderNetNodes();updateRealtimeMetrics(n.ip,n.rx_speed,n.tx_speed);
        }
        if(pending.length){const saved=pending;pending=[];for(const e of saved){const name=canonicalNode(e.server_name);if(trueNodesMap[name])visit(e);else pending.push(e);}}
    }
    async function sync(force=false){
        if(request)return request;if(!force&&performance.now()-lastSync<1000)return;lastSync=performance.now();
        request=(async()=>{try{
            const sent=performance.now(),response=await fetch('__ADMIN_BASE__/api/nodes',{cache:'no-store',signal:AbortSignal.timeout(10000)});
            if(response.status===401){diagnostic('登录已过期，请重新登录。');return;}
            if(!response.ok)return;const data=await response.json();if(!Array.isArray(data.nodes))return;
            for(const node of data.nodes)apply(node,performance.now()-sent);
            if(document.getElementById('left-net-menu').classList.contains('open'))renderNetNodes();
        }catch(_){}finally{request=null;}})();return request;
    }
    function visit(data){
        if(pbState.active||pbState.loading||!VisitorFilter.accepts(data.target_domain))return;
        const name=canonicalNode(data.server_name);data.server_name=name;
        if(rejectedNodes.has(name))return;
        if(!trueNodesMap[name]&&name!=='Direct Access'&&name!=='-'){
            if(pending.length<4096)pending.push(data);else streamGap=true;
            sync();return;
        }
        if(!currentFilters.includes('All')&&!currentFilters.some(n=>canonicalNode(n)===name))return;
        queueLiveEvent(data);
    }
    function diagnostic(message){
        let element=document.getElementById('stream-diagnostic');
        if(!element){element=document.createElement('aside');element.id='stream-diagnostic';element.setAttribute('role','status');document.body.append(element);}
        element.textContent=message;element.hidden=!message;
    }
    function connected(){diagnostic('');sync(true);}
    function disconnected(){
        diagnostic('实时通道未连接，访客轨迹暂停；正在同步节点状态。请检查登录会话、auth.public_base_url / auth.allowed_origins 与访问域名是否匹配，以及 __ADMIN_BASE__/ws 的 WebSocket 转发。');sync(true);
    }
    setInterval(()=>{if(document.hidden)return;const now=performance.now(),connected=typeof ws!=='undefined'&&ws?.readyState===1;if(now-lastPoll>=(connected?30000:10000)){lastPoll=now;sync();}},5000);
    queueMicrotask(()=>{for(const n of Object.values(nodeQuotaData))acceptPresence(n);});
    setInterval(()=>{if(!document.hidden)expirePresence();},1000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){expirePresence();sync(true);}});
    document.addEventListener('DOMContentLoaded',()=>{needsSort=true;for(const ip of presence.keys())dirtyPresence.add(ip);schedulePresence();});
    document.getElementById('nodes-tbody')?.addEventListener('focusout',()=>queueMicrotask(sortRows));
    return {apply,sync,visit,connected,disconnected,diagnostic,isOffline,remove,rename,inspect:()=>({pending:pending.length,registrations:registrations.size})};
})();
