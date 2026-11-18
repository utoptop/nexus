/* Visitor appearance controls and an isolated, bounded 3D overview. No new CDN dependency. */
(() => {
    const button=document.getElementById('visitor-options-button'),menu=document.getElementById('visitor-options');
    const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');};
    button.addEventListener('click',e=>{e.stopPropagation();menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden){menu.dataset.placement='below';const r=menu.getBoundingClientRect();if(r.bottom>innerHeight-(isMobile?(window.mobileChromeInsets?.bottom??90):20)&&button.getBoundingClientRect().top-r.height-12>=12)menu.dataset.placement='above';}});
    document.addEventListener('click',e=>{if(!e.target.closest('.visitor-preferences'))close();});
    const opacity=document.getElementById('visitor-opacity');
    function setVisitorOpacity(value){
        const n=Number(value);window.currentVisitorOpacity=Number.isFinite(n)?Math.max(0,Math.min(1,n)):1;
        opacity.value=window.currentVisitorOpacity;document.documentElement.style.setProperty('--visitor-opacity',opacity.value);
        document.getElementById('visitor-opacity-value').textContent=Math.round(opacity.value*100)+'%';
        localStorage.setItem('visitorOpacity',opacity.value);window.TrajectoryPool?.wake();
    }
    VisitorFilter.sync();
    setVisitorOpacity(localStorage.getItem('visitorOpacity')??1);opacity.addEventListener('input',()=>setVisitorOpacity(opacity.value));
    document.getElementById('settings-backdrop').addEventListener('click',closeSettings);
    document.addEventListener('keydown',e=>{
        const dialog=document.getElementById('settings-modal');
        if(e.key==='Escape'){close();if(dialog.style.display==='flex')closeSettings(e);}
        if(e.key!=='Tab'||dialog.style.display!=='flex')return;
        const focusable=Array.from(dialog.querySelectorAll('button,input,select,a[href],[tabindex="0"]')).filter(el=>el.getClientRects().length&&!el.disabled);
        const first=focusable[0],last=focusable.at(-1);
        if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    });
})();

window.TrafficGlobe=(() => {
    const canvas=document.getElementById('traffic-globe'),card=document.getElementById('globe-card');
    const rotateButton=document.getElementById('globe-rotate'),summary=document.getElementById('globe-summary');
    const expandButton=document.getElementById('globe-expand'),backButton=document.getElementById('globe-back-map');
    const plus=document.getElementById('globe-zoom-in'),minus=document.getElementById('globe-zoom-out');
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MAX_ROUTES=lowMemory?180:480,MAX_LIGHTS=renderLimits.particles+256,STEPS=32,STRIDE=8;
    const pointers=new Map(),placeholder=document.createComment('globe overview position'),fullscreenPlaceholder=document.createComment('global fullscreen position'),playbackPlaceholder=document.createComment('playback controls position');
    let expanded=false,zoom=1,inertElements=[],savedScroll=0,lastInput=-10000,canvasDpr=0;
    let fallbackSurface=null,engine=null,raf=0,last=0,lastSample=-1000,frames=0,active=false,intersects=false,rotating=!reduced,yaw=-1.6,pitch=.2;
    let snapshot=[],lights=[],frameCost=0,slowFrames=0,quality=1,lastQualityChange=0,fpsTarget=30,lastRevision=-1,lastLabels=-1000,lastData=-1000;
    const point=([lat,lon])=>{const a=lat*Math.PI/180,b=lon*Math.PI/180;return [Math.cos(a)*Math.sin(b),Math.sin(a),Math.cos(a)*Math.cos(b)];};
    const normalize=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const rgb=color=>(/^#[\da-f]{6}$/i.test(color)?color:'#22d3ee').match(/[\da-f]{2}/gi).map(v=>parseInt(v,16)/255);
    function arc(from,to){
        const a=point(from),b=point(to),dot=Math.max(-1,Math.min(1,a.reduce((s,v,i)=>s+v*b[i],0))),angle=Math.acos(dot),sin=Math.sin(angle),result=[];
        const orth=normalize(cross(a,Math.abs(a[1])<.9?[0,1,0]:[1,0,0]));
        for(let i=0;i<=STEPS;i++){
            const t=i/STEPS,r=1.008+Math.sin(t*Math.PI)*Math.min(.32,.07+angle*.12);
            const v=dot<-.999?a.map((v,k)=>v*Math.cos(t*Math.PI)+orth[k]*Math.sin(t*Math.PI)):sin<.001?a:a.map((v,k)=>(v*Math.sin((1-t)*angle)+b[k]*Math.sin(t*angle))/sin);
            result.push(normalize(v).map(x=>x*r));
        }
        return result;
    }
    const labelLayer=document.createElement('div');labelLayer.className='globe-label-layer';canvas.after(labelLayer);
    const leaderSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');leaderSvg.classList.add('globe-label-leaders');labelLayer.appendChild(leaderSvg);
    const nodeRail=document.createElement('div');nodeRail.className='globe-node-rail';nodeRail.hidden=true;nodeRail.setAttribute('aria-label',isZh?'其他节点':'Other nodes');card.insertBefore(nodeRail,card.querySelector('.globe-footer'));
    const globeMask=new TrafficRuntime.RectMask();let lastMask=-1000;
    const nodeLabels=new Map(),visitorLabels=new Map();let labelWidth=0,labelHeight=0,lastLabelFrame=-1000;
    const dataButton=document.createElement('button');dataButton.id='globe-data-toggle';dataButton.type='button';dataButton.hidden=true;dataButton.textContent=isZh?'◫ 数据 · 访客':'◫ Data';dataButton.setAttribute('aria-controls','globe-data-panel');dataButton.setAttribute('aria-expanded','true');card.querySelector('.globe-view-controls').prepend(dataButton);
    const dataPanel=document.createElement('aside');dataPanel.id='globe-data-panel';dataPanel.className='globe-data-panel';dataPanel.hidden=true;dataPanel.setAttribute('aria-label',isZh?'实时流量数据':'Live traffic data');
    dataPanel.innerHTML=`<nav class="globe-data-tabs" role="tablist"><button type="button" id="globe-tab-traffic" role="tab" aria-selected="true" aria-controls="globe-pane-traffic">${isZh?'实时流量':'Traffic'}</button><button type="button" id="globe-tab-nodes" role="tab" aria-selected="false" aria-controls="globe-pane-nodes" tabindex="-1">${isZh?'节点热度':'Nodes'}</button><button type="button" id="globe-tab-visitors" role="tab" aria-selected="false" aria-controls="globe-pane-visitors" tabindex="-1">${isZh?'访客':'Visitors'}</button><span class="globe-data-mode">LIVE</span></nav>
        <div class="globe-replay-tools"><select id="globe-replay-range" aria-label="${isZh?'回放时间范围':'Replay time range'}"><option value="0">${isZh?'最近 10 分钟':'Last 10 minutes'}</option><option value="0.0417">${isZh?'最近 1 小时':'Last hour'}</option><option value="1" selected>${isZh?'最近 24 小时':'Last 24 hours'}</option><option value="7">${isZh?'最近 7 天':'Last 7 days'}</option><option value="30">${isZh?'最近 30 天':'Last 30 days'}</option></select><button id="globe-replay-start" type="button" class="main-play-btn">${isZh?'▶ 轨迹回放':'▶ Replay'}</button></div>
        <section id="globe-pane-traffic" role="tabpanel" aria-labelledby="globe-tab-traffic"><div class="globe-metrics">
        <div><span>${isZh?'访问 / 秒':'Visits / s'}</span><strong data-metric="rate">0</strong><small>${isZh?'近 5 秒均值':'5-second average'}</small></div>
        <div><span>${isZh?'累计访问':'Total visits'}</span><strong data-metric="total">0</strong><small>${isZh?'当前数据范围':'Current data range'}</small></div>
        <div><span>${isZh?'位置亮点':'Location lights'}</span><strong data-metric="origins">0</strong></div><div><span>${isZh?'活跃节点':'Active nodes'}</span><strong data-metric="nodes">0</strong></div></div>
        <div class="globe-trend"><span>${isZh?'最近 60 秒':'Last 60 seconds'}</span><svg viewBox="0 0 200 38" role="img" aria-label="${isZh?'访问频率趋势':'Visit frequency trend'}"><path class="globe-trend-grid" d="M0 37H200 M0 19H200"/><path class="globe-trend-line"/></svg></div></section>
        <section id="globe-pane-nodes" role="tabpanel" aria-labelledby="globe-tab-nodes" hidden><div class="globe-hot-nodes"></div><small class="globe-node-note">${isZh?'光条表示近期访问热度':'Bars show recent visit activity'}</small></section>
        <section id="globe-pane-visitors" role="tabpanel" aria-labelledby="globe-tab-visitors" hidden>
            <label class="nexus-filter-option"><input id="globe-hide-nexus" type="checkbox" data-hide-nexus><span>${isZh?'隐藏 Nexus 域名访问':'Hide visits to Nexus'}</span></label>
            <div id="globe-visitor-list" tabindex="0" aria-label="${isZh?'访客详情，滚动查看更多':'Visitor details, scroll for more'}"><div class="globe-visitor-space"></div><div class="globe-visitor-content"></div></div>
            <small id="globe-visitor-count"></small>
        </section>`;
    card.appendChild(dataPanel);
    const metricEls=Object.fromEntries(Array.from(dataPanel.querySelectorAll('[data-metric]'),el=>[el.dataset.metric,el])),trendLine=dataPanel.querySelector('.globe-trend-line'),dataMode=dataPanel.querySelector('.globe-data-mode');
    const hotRows=Array.from({length:5},()=>{const el=document.createElement('div');el.className='globe-hot-node';el.innerHTML='<span></span><b></b><i></i>';dataPanel.querySelector('.globe-hot-nodes').appendChild(el);return {el,name:el.querySelector('span'),count:el.querySelector('b'),bar:el.querySelector('i')};});
    let dataVisible=true,hudRect=null,hudUpdates=0,liveMetrics={rate:0,total:0,origins:0,nodes:0};
    function dataBounds(){
        if(!expanded||dataPanel.hidden){hudRect=null;card.style.removeProperty('--globe-rail-top');return;}
        const p=dataPanel.getBoundingClientRect(),c=card.getBoundingClientRect();hudRect={x:p.x-c.x,y:p.y-c.y,w:p.width,h:p.height};
        card.style.setProperty('--globe-rail-top',(hudRect.y+hudRect.h+12)+'px');lastLabelFrame=-1000;
    }
    new ResizeObserver(dataBounds).observe(dataPanel);
    dataButton.addEventListener('click',()=>{dataVisible=!dataVisible;dataPanel.hidden=!dataVisible;dataButton.setAttribute('aria-expanded',String(dataVisible));lastData=-1000;dataBounds();});
    // One virtual list shared by live and replay data. Preserve a scrolled row as new visits arrive.
    const visitorList=dataPanel.querySelector('#globe-visitor-list'),visitorSpace=dataPanel.querySelector('.globe-visitor-space'),visitorContent=dataPanel.querySelector('.globe-visitor-content'),visitorCount=dataPanel.querySelector('#globe-visitor-count');
    const VISITOR_ROW=88;let visitorRows=[],visitorRevision=-1,visitorFrame=0;
    function renderVisitors(){
        if(!expanded||dataPanel.hidden||document.getElementById('globe-pane-visitors').hidden)return;
        if(visitorRevision!==overviewRevision){
            const top=visitorList.scrollTop,anchor=top>0?visitorRows[Math.floor(top/VISITOR_ROW)]:null;
            visitorRows=Array.from(statsMap.values()).filter(s=>VisitorFilter.accepts(s[8])).sort((a,b)=>TrafficRuntime.timestamp(b[3])-TrafficRuntime.timestamp(a[3]));
            visitorRevision=overviewRevision;visitorSpace.style.height=visitorRows.length*VISITOR_ROW+'px';
            if(anchor){const at=visitorRows.findIndex(s=>statKey(s)===statKey(anchor));if(at>=0)visitorList.scrollTop=at*VISITOR_ROW+top%VISITOR_ROW;}
            visitorCount.textContent=(isZh?'最近访客条目 · ':'Recent entries · ')+visitorRows.length.toLocaleString();
        }
        const start=Math.max(0,Math.floor(visitorList.scrollTop/VISITOR_ROW)-1),end=Math.min(visitorRows.length,Math.ceil((visitorList.scrollTop+visitorList.clientHeight)/VISITOR_ROW)+1);
        let html='';
        for(let i=start;i<end;i++){
            const s=visitorRows[i],time=new Date(TrafficRuntime.timestamp(s[3])).toLocaleString();
            html+=`<button type="button" class="globe-visitor-row" data-index="${i}" style="top:${i*VISITOR_ROW}px" aria-label="${escHtml(s[0]+' · '+s[7])}"><span class="globe-visitor-ip">${escHtml(s[0])}</span><b>×${Number(s[2]).toLocaleString()}</b><span class="globe-visitor-destination" title="${escHtml(s[8]||'-')}">${escHtml(s[8]||'-')}</span><span class="globe-visitor-location" title="${escHtml(s[1]+' → '+s[7])}">${escHtml(s[1])} → ${escHtml(s[7])}</span><time>${escHtml(time)}</time></button>`;
        }
        if(!visitorRows.length)html=`<p class="globe-visitors-empty">${isZh?'当前范围暂无访客':'No visitors in this range'}</p>`;
        if(visitorContent._html!==html){visitorContent.innerHTML=html;visitorContent._html=html;}
    }
    visitorList.addEventListener('scroll',()=>{if(!visitorFrame)visitorFrame=requestAnimationFrame(()=>{visitorFrame=0;renderVisitors();});},{passive:true});
    new ResizeObserver(renderVisitors).observe(visitorList);
    visitorContent.addEventListener('click',event=>{
        const row=event.target.closest('[data-index]'),s=row&&visitorRows[Number(row.dataset.index)];if(!s)return;
        const pos=fixZeroPos(s[5],s[6]);yaw=-pos[1]*Math.PI/180;pitch=Math.max(-1.2,Math.min(1.2,pos[0]*Math.PI/180));setZoom(1.25);rotating=false;rotationLabel();
    });
    const replayRange=document.getElementById('globe-replay-range');
    replayRange.value=document.getElementById('time-sel').value;
    replayRange.addEventListener('change',()=>{document.getElementById('time-sel').value=replayRange.value;if(pbState.active||pbState.loading)startPlayback(true);});
    document.getElementById('time-sel').addEventListener('change',()=>{replayRange.value=document.getElementById('time-sel').value;});
    document.getElementById('globe-replay-start').addEventListener('click',()=>startPlayback());
    document.getElementById('globe-hide-nexus').addEventListener('change',e=>VisitorFilter.set(e.target.checked));
    VisitorFilter.sync();

    const tabs=Array.from(dataPanel.querySelectorAll('[role="tab"]'));
    function selectTab(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;document.getElementById(tab.getAttribute('aria-controls')).hidden=i!==index;});dataBounds();renderVisitors();}
    tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectTab(i));tab.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(next);tabs[next].focus();});});
    selectTab(2);
    function updateData(now){
        if(!expanded||dataPanel.hidden)return;
        renderVisitors();
        const meter=TrajectoryPool.trafficMetrics(),nodes=lights.filter(l=>l.node),total=Object.values(nodeHits).reduce((s,n)=>s+n,0);
        liveMetrics={rate:meter.rate,total,origins:lights.length-nodes.length,nodes:nodes.filter(l=>now-l.at<5000&&l.energy>.03).length};
        for(const [key,el] of Object.entries(metricEls)){const value=liveMetrics[key],text=value.toLocaleString(undefined,{maximumFractionDigits:key==='rate'?1:0});if(el.textContent!==text)el.textContent=text;el.dataset.value=String(value);el.title=text;el.style.fontSize=Math.max(isMobile?10:12,(isMobile?17:22)*Math.min(1,8/text.length))+'px';}
        const peak=Math.max(1,...meter.series);trendLine.setAttribute('d',meter.series.map((v,i)=>(i?'L':'M')+(i*200/119).toFixed(1)+','+(37-v/peak*33).toFixed(1)).join(' '));
        const ranked=nodes.sort((a,b)=>b.energy-a.energy||b.hits-a.hits);
        hotRows.forEach((r,i)=>{const n=ranked[i];r.el.hidden=!n;if(!n)return;if(r.name.textContent!==n.node)r.name.textContent=n.node;r.name.title=n.node;const count=n.hits.toLocaleString();if(r.count.textContent!==count)r.count.textContent=count;r.el.style.setProperty('--node-color',n.color);r.bar.style.transform=`scaleX(${TrafficRuntime.activityLevel(n.energy).toFixed(3)})`;});
        const mode=pbState.active?'REPLAY':'LIVE';if(dataMode.textContent!==mode)dataMode.textContent=mode;card.querySelector('.globe-live').textContent='● '+mode;hudUpdates++;
    }
    function projectPoint(pos){
        const p=point(pos),c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),x=c*p[0]+s*p[2],z=-s*p[0]+c*p[2];
        const r=Math.min(labelWidth,labelHeight)*.385*zoom;
        return {x:labelWidth/2+x*r,y:labelHeight/2-(cp*p[1]-sp*z)*r,z:sp*p[1]+cp*z};
    }
    function syncLabels(){
        const keep=new Set();
        for(const l of lights){if(!l.node)break;keep.add(l.node);
            let entry=nodeLabels.get(l.node);
            if(!entry){
                const el=document.createElement('div');el.className='globe-node-label';el.hidden=true;el.dataset.node=l.node;
                const name=document.createElement('strong');name.className='globe-node-name';name.textContent=l.node;name.title=l.node;
                const caption=document.createElement('span');caption.className='globe-node-caption';caption.textContent=isZh?'访问 ':'Hits ';
                const count=document.createElement('b');count.className='globe-node-count';caption.appendChild(count);el.append(name,caption);
                const leader=document.createElementNS('http://www.w3.org/2000/svg','path');leaderSvg.appendChild(leader);labelLayer.appendChild(el);
                entry={el,name,count,leader,light:l,dx:0,dy:0};nodeLabels.set(l.node,entry);
            }
            entry.light=l;entry.el.dataset.offline=String(l.offline);entry.el.title=l.node+(l.offline?(isZh?' · 离线':' · Offline'):'');
            const hits=String(l.hits);if(entry.el.dataset.hits!==hits){entry.el.dataset.hits=hits;entry.count.textContent=l.hits.toLocaleString();}
            entry.el.style.setProperty('--node-color',l.color);entry.leader.setAttribute('stroke',l.color);
        }
        for(const [key,e] of nodeLabels)if(!keep.has(key)){e.el.remove();e.leader.remove();nodeLabels.delete(key);}
        // All active origins stay on the GPU. Only a small selection receives text.
        const candidates=[];
        for(let i=lights.length-1;i>=0&&candidates.length<72;i--){const l=lights[i];if(!l.node&&l.energy>.08)candidates.push(l);}
        candidates.sort((a,b)=>b.energy-a.energy);const shown=new Set();
        for(const l of candidates.slice(0,expanded?24:8)){
            const key=l.pos.join(',');shown.add(key);let e=visitorLabels.get(key);
            if(!e){const el=document.createElement('span');el.className='globe-visitor-number';el.hidden=true;labelLayer.appendChild(el);e={el,light:l};visitorLabels.set(key,e);}
            e.light=l;const text='+'+l.hits.toLocaleString();if(e.el.textContent!==text)e.el.textContent=text;
            e.el.title=isZh?'本轮活跃访问 '+l.hits+' 次':l.hits+' visits in this active burst';
        }
        for(const [key,e] of visitorLabels)if(!shown.has(key)){e.el.remove();visitorLabels.delete(key);}
    }
    function layoutLabels(now){
        const interval=pointers.size?1000/30:1000/20;if(now-lastLabelFrame<interval)return;lastLabelFrame=now;
        const w=labelWidth,h=labelHeight,bw=expanded?(isMobile?118:138):114,bh=expanded?46:42,gap=10,placed=[];
        const top=expanded?(isMobile?112:80):48,bottom=h-(expanded?(pbState.active?180:96):12),left=12,right=w-(expanded?64:44);
        if(hudRect)placed.push(hudRect);
        if(expanded&&!nodeRail.hidden){const y=isMobile?h-170:hudRect?hudRect.y+hudRect.h+12:95,x=isMobile?(w>h?240:12):16;placed.push({x,y,w:isMobile?w-x-12:162,h:isMobile?66:Math.min(350,h-y-85,nodeRail.children.length*56+20)});}
        const overlap=(a,b)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;
        // Keep recent visitor origins visible when adjacent node cards need room.
        const sourceExclusions=[];
        for(const e of visitorLabels.values()){
            const p=projectPoint(e.light.pos);
            if(p.z>.08&&p.x>30&&p.x<w-45&&p.y>top&&p.y<bottom)sourceExclusions.push({x:p.x-24,y:p.y-24,w:48,h:48});
        }
        let floating=0,overflow=0;
        for(const e of nodeLabels.values()){
            e.el.hidden=false;
            const l=e.light,p=projectPoint(l.pos),level=TrafficRuntime.activityLevel(l.energy*Math.pow(.5,Math.max(0,now-lastSample)/1800));
            const burst=reduced?0:Math.pow(Math.max(0,1-(now-l.at)/650),2);
            e.el.style.setProperty('--activity',level.toFixed(2));e.el.style.setProperty('--burst',burst.toFixed(2));
            let spot=null;
            if(p.z>.04&&p.x>=0&&p.x<=w&&p.y>=0&&p.y<=h&&floating<(expanded?(isMobile?8:24):3)){
                const side=p.x<w/2?-1:1,options=[];
                if(e.floating)options.push([p.x+e.dx,p.y+e.dy]);
                for(const dy of [0,-(bh+gap),bh+gap,-2*(bh+gap),2*(bh+gap)])for(const s of [side,-side])options.push([s>0?p.x+18:p.x-bw-18,p.y-bh/2+dy]);
                for(const [x,y] of options){const rect={x:Math.max(left,Math.min(right-bw,x)),y:Math.max(top,Math.min(bottom-bh,y)),w:bw,h:bh};
                    if(rect.y<top||Math.hypot(rect.x+bw/2-p.x,rect.y+bh/2-p.y)>bw/2+(expanded?135:85)||placed.some(q=>overlap(rect,q))||sourceExclusions.some(q=>overlap(rect,q)))continue;
                    if(Math.abs(rect.x+bw/2-p.x)<bw/2+6&&Math.abs(rect.y+bh/2-p.y)<bh/2+6)continue;
                    spot=rect;break;
                }
            }
            if(spot){
                if(e.el.parentElement!==labelLayer)labelLayer.appendChild(e.el);
                e.el.classList.remove('in-rail');e.el.style.transform=`translate3d(${spot.x.toFixed(1)}px,${spot.y.toFixed(1)}px,0)`;e.dx=spot.x-p.x;e.dy=spot.y-p.y;e.floating=true;
                const ex=Math.max(spot.x,Math.min(spot.x+bw,p.x)),ey=Math.max(spot.y,Math.min(spot.y+bh,p.y));
                e.leader.setAttribute('d',`M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`);e.leader.style.display='';placed.push(spot);floating++;
            }else{
                if(e.el.parentElement!==nodeRail)nodeRail.appendChild(e.el);e.el.classList.add('in-rail');e.el.style.transform='';e.leader.style.display='none';e.floating=false;overflow++;
            }
        }
        nodeRail.hidden=overflow===0;
        if(now-lastMask>=100){lastMask=now;const rects=[];
            for(const e of nodeLabels.values()){const p=projectPoint(e.light.pos);if(p.z>.04){const r=14+Math.sqrt(TrafficRuntime.activityLevel(e.light.energy))*14;rects.push({x:p.x-r,y:p.y-r,w:r*2,h:r*2});}if(e.floating){const q=projectPoint(e.light.pos);rects.push({x:q.x+e.dx-5,y:q.y+e.dy-5,w:bw+10,h:bh+10});}}
            if(!nodeRail.hidden){const r=nodeRail.getBoundingClientRect(),c=card.getBoundingClientRect();rects.push({x:r.x-c.x,y:r.y-c.y,w:r.width,h:r.height});}globeMask.reset(rects);engine?.updateMask?.(rects,w,h);
        }
        const visitorSpots=[];let count=0;
        for(const e of visitorLabels.values()){
            const p=projectPoint(e.light.pos),rect={x:p.x-18,y:p.y-7,w:36,h:14};
            const show=p.z>.08&&p.x>30&&p.x<w-45&&p.y>top&&p.y<bottom&&count<(expanded?12:3)&&!placed.some(q=>overlap(rect,q))&&!visitorSpots.some(q=>overlap(rect,q));
            e.el.hidden=!show;if(!show)continue;count++;visitorSpots.push(rect);e.el.style.transform=`translate3d(${rect.x.toFixed(1)}px,${rect.y.toFixed(1)}px,0)`;e.el.style.opacity=String(window.currentVisitorOpacity??1);
        }
    }

    // One instanced draw for all curved flowing dashes, with soft rounded ends.
    function createRouteGPU(gl){
        const vertex=`#version 300 es
        precision highp float;
        layout(location=0) in vec2 corner;
        layout(location=1) in vec4 start;layout(location=2) in vec4 end;
        layout(location=3) in vec4 tint;layout(location=4) in vec4 timing;
        uniform vec2 rotation;uniform vec2 viewport;uniform float scale;uniform float time;uniform float motion;
        out vec3 color;out float along;out float across;out float power;out float age;out float seed;
        vec3 rotate(vec3 p){float c=cos(rotation.x),s=sin(rotation.x),cp=cos(rotation.y),sp=sin(rotation.y);vec3 v=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);return vec3(v.x,cp*v.y-sp*v.z,sp*v.y+cp*v.z);}
        void main(){
            vec3 a=rotate(start.xyz),b=rotate(end.xyz);float radius=viewport.y*scale*.5;
            vec2 pa=vec2(a.x,-a.y)*radius,pb=vec2(b.x,-b.y)*radius;
            vec2 delta=pb-pa,dir=delta/max(.01,length(delta));
            vec2 p=mix(pa,pb,corner.x)+vec2(-dir.y,dir.x)*corner.y*7.0;
            gl_Position=vec4(p.x/viewport.x*2.0,-p.y/viewport.y*2.0,-mix(a.z,b.z,corner.x)*.5,1.0);
            color=tint.rgb;power=tint.a;age=max(0.,time-timing.x);seed=timing.y;
            along=mix(start.w,end.w,corner.x)*radius;across=corner.y*7.0;
        }`;
        const fragment=`#version 300 es
        precision highp float;
        uniform sampler2D nodeMask;uniform vec2 maskViewport;
        uniform float time;uniform float motion;uniform float brightness;uniform float flowSpeed;uniform vec2 dashStyle;
        in vec3 color;in float along;in float across;in float power;in float age;in float seed;out vec4 outColor;
        void main(){
            float d=abs(across),live=1.0-smoothstep(1.5,3.2,age),flash=pow(max(0.,1.-age/.42),1.5);
            float dash=max(1.,dashStyle.x),spacing=dash+max(0.,dashStyle.y);
            float x=abs(mod(along-time*flowSpeed*motion-seed+spacing*.5,spacing)-spacing*.5);
            float width=.65+power*.4+flash*.2;
            float distance=length(vec2(max(0.,x-max(0.,dash*.5-width)),d));
            float packet=1.-smoothstep(width*.45,width+.6,distance);
            float halo=exp(-distance*distance/(width*width*4.+2.))*.18;
            float carrier=exp(-d*d/1.1)*mix(.08,.12,flash);
            float a=carrier+(packet+halo)*live;
            float gain=mix(.2,.16+power*.5+flash*(.45+power*.25),live)*brightness;
            vec3 ink=mix(vec3(.44,.5,.57),color,live);
            outColor=vec4(mix(ink,vec3(.8,1.,1.),clamp(packet,0.,1.)*.28*live),min(1.,a*gain));
        }`;
        const shader=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
        const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment),program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
        const vao=gl.createVertexArray();gl.bindVertexArray(vao);
        const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,-1,1,-1,0,1,0,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
        const data=new Float32Array(MAX_ROUTES*STEPS*16),buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data.byteLength,gl.DYNAMIC_DRAW);
        for(let i=1;i<=4;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,(i-1)*16);gl.vertexAttribDivisor(i,1);}
        const u=Object.fromEntries(['rotation','viewport','scale','time','motion','brightness','flowSpeed','dashStyle'].map(n=>[n,gl.getUniformLocation(program,n)]));let used=0,cache=new Map();
        return {bytes:data.byteLength*2,update(routes,now){
            used=0;const keep=new Map();
            for(const r of routes){
                let geo=cache.get(r.key);if(!geo){const path=arc(r.from,r.to),lengths=[0];for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+Math.hypot(...path[i].map((v,k)=>v-path[i-1][k])));geo={path,lengths,seed:TrafficRuntime.hash(r.key)%54};}keep.set(r.key,geo);
                const color=rgb(r.color),level=TrafficRuntime.activityLevel(r.energy),at=(now-r.age)/1000;
                for(let j=0;j<STEPS;j++){
                    let k=used++*16;const a=geo.path[j],b=geo.path[j+1];
                    data[k++]=a[0];data[k++]=a[1];data[k++]=a[2];data[k++]=geo.lengths[j];data[k++]=b[0];data[k++]=b[1];data[k++]=b[2];data[k++]=geo.lengths[j+1];
                    data[k++]=color[0];data[k++]=color[1];data[k++]=color[2];data[k++]=level;data[k++]=at;data[k++]=geo.seed;data[k++]=0;data[k]=0;
                }
            }
            cache=keep;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,data.subarray(0,used*16));
        },draw(now,scale){
            gl.useProgram(program);gl.bindVertexArray(vao);gl.uniform2f(u.rotation,yaw,pitch);gl.uniform2f(u.viewport,canvas.clientWidth,canvas.clientHeight);gl.uniform1f(u.scale,scale);gl.uniform1f(u.time,now/1000);gl.uniform1f(u.flowSpeed,TrafficRuntime.flowSpeed(window.currentInitSpeed));gl.uniform1f(u.motion,reduced?0:1);gl.uniform1f(u.brightness,Math.min(1.5,(window.currentDynBright??4)/4));
            gl.uniform2f(u.dashStyle,window.currentDashLength??8,window.currentDashGap??6);
            gl.drawArraysInstanced(gl.TRIANGLES,0,6,used);
        }};
    }

    function createGPU(){
        const gl=canvas.getContext('webgl2',{alpha:true,antialias:true,powerPreference:'low-power'});if(!gl)return null;
        const vertex=`#version 300 es
        precision highp float;
        layout(location=0) in vec3 position;layout(location=1) in vec4 tint;layout(location=2) in float along;
        uniform vec2 rotation;uniform float aspect;uniform float mode;uniform float dpr;uniform float scale;
        uniform float time;uniform float sampledAt;uniform float visitorOpacity;uniform float motion;
        out vec3 world;out vec3 view;out vec4 color;out float t;out float burst;out float level;
        void main(){
            float c=cos(rotation.x),s=sin(rotation.x),cp=cos(rotation.y),sp=sin(rotation.y);
            vec3 p=vec3(c*position.x+s*position.z,position.y,-s*position.x+c*position.z);
            p=vec3(p.x,cp*p.y-sp*p.z,sp*p.y+cp*p.z);
            world=position;view=p;color=tint;t=along;burst=0.0;level=0.0;
            gl_Position=vec4(p.x*scale/aspect,p.y*scale,-p.z*.5,1.0);
            if(mode>1.5&&mode<2.5){
                float node=along<0.0?1.0:0.0;
                float energy=tint.a*exp2(-max(0.0,time-sampledAt)/1.8);
                level=clamp(log(1.0+energy)/log(1001.0),0.0,1.0);
                burst=pow(max(0.0,1.0-(time-(abs(along)-1.0))/.65),2.0)*motion;
                color.a=(.4+sqrt(level)*.65+burst*.75)*mix(min(1.0,energy)*visitorOpacity,1.0,node);
                gl_PointSize=(18.0+node*4.0+sqrt(level)*42.0+burst*10.0)*dpr;
            }else gl_PointSize=1.0;
        }`;
        const fragment=`#version 300 es
        precision highp float;
        uniform sampler2D nodeMask;uniform vec2 maskViewport;
        uniform sampler2D earth;uniform float mode;uniform float time;uniform float motion;uniform float brightness;
        in vec3 world;in vec3 view;in vec4 color;in float t;in float burst;in float level;out vec4 outColor;
        void main(){
            if(mode<.5){
                vec3 n=normalize(world),v=normalize(view);
                vec2 uv=vec2(atan(n.x,n.z)/6.2831853+.5,asin(clamp(n.y,-1.0,1.0))/3.14159265+.5);
                vec3 base=texture(earth,uv).rgb;
                float light=.55+.75*max(0.0,dot(v,normalize(vec3(-.5,.6,1.0))));
                float rim=pow(1.0-max(0.0,v.z),3.0);
                outColor=vec4(base*light+vec3(.04,.28,.35)*rim,1.0);
            }else if(mode<1.5){
                float sheen=pow(.5+.5*cos((t-time*.18*motion)*6.2831853),5.0);
                outColor=vec4(mix(color.rgb,vec3(.65,1.,1.),sheen*.22),color.a*(.65+.35*sheen)*brightness);
            }else if(mode<2.5){
                float d=length(gl_PointCoord-.5)*2.0;if(d>1.0)discard;
                float ring=exp(-pow((d-(.35+(1.0-burst)*.5))*24.0,2.0))*burst;
                float disc=(1.0-smoothstep(.38,.48,d))*.5;
                float rim=exp(-pow((d-.46)*65.0,2.0))*.85;
                float a=disc+rim+exp(-d*d*4.5)*.4+exp(-d*d*70.0)*.4+ring*.7;
                float fade=t<0.0?1.0:mix(1.0,.12,texture(nodeMask,vec2(gl_FragCoord.x/maskViewport.x,1.0-gl_FragCoord.y/maskViewport.y)).r);
                outColor=vec4(mix(color.rgb,vec3(.85,1.,1.),exp(-d*d*90.0)),min(1.,a*color.a)*brightness*fade);
            }else outColor=vec4(color.rgb,color.a*(.5+.5*max(0.,normalize(view).z)));
        }`;
        const compile=(type,src)=>{const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(sh));return sh;};
        const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment),program=gl.createProgram();
        gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);const mainVAO=gl.createVertexArray();gl.bindVertexArray(mainVAO);
        const uniforms=Object.fromEntries(['rotation','aspect','mode','dpr','scale','time','sampledAt','earth','visitorOpacity','motion','brightness','nodeMask','maskViewport'].map(n=>[n,gl.getUniformLocation(program,n)]));
        const mesh=[];const v=(lat,lon)=>mesh.push(...point([lat,lon]),1,1,1,1,0);
        const meshStep=lowMemory?3:2;
        for(let lat=-90;lat<90;lat+=meshStep)for(let lon=-180;lon<180;lon+=meshStep){v(lat,lon);v(lat+meshStep,lon);v(lat,lon+meshStep);v(lat,lon+meshStep);v(lat+meshStep,lon);v(lat+meshStep,lon+meshStep);}
        const sphereCount=mesh.length/STRIDE,sphereBytes=mesh.length*4;
        function staticBuffer(values){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);return b;}
        const sphere=staticBuffer(mesh);mesh.length=0;
        // Geographic boundaries stay vector-sharp at every zoom and share one draw.
        const borderData=[];
        for(const [rings,color] of [[Coastline.globeBorders(),[.36,.65,.69,.86]],[Coastline.globeRings(),[.23,.53,.60,.6]]]){
            for(const ring of rings)for(let i=1;i<ring.length;i++)for(const p of [ring[i-1],ring[i]])borderData.push(...point([p[1],p[0]]).map(v=>v*1.002),...color,0);
        }
        const borderCount=borderData.length/STRIDE,borderBytes=borderData.length*4,borders=staticBuffer(borderData);borderData.length=0;
        const routeGPU=createRouteGPU(gl);gl.useProgram(program);gl.bindVertexArray(mainVAO);
        const lightBuffer=gl.createBuffer(),lightData=new Float32Array(MAX_LIGHTS*STRIDE);
        gl.bindBuffer(gl.ARRAY_BUFFER,lightBuffer);gl.bufferData(gl.ARRAY_BUFFER,lightData.byteLength,gl.DYNAMIC_DRAW);
        const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        const textureWidth=Math.min(lowMemory?2048:4096,gl.getParameter(gl.MAX_TEXTURE_SIZE)),textureHeight=textureWidth/2;
        const land=Coastline.globeTexture(textureWidth);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,land);land.width=land.height=0;
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        let textureBytes=0;
        for(let w=textureWidth,h=textureHeight;;w=Math.max(1,w>>1),h=Math.max(1,h>>1)){textureBytes+=w*h*4;if(w===1&&h===1)break;}
        const maxRenderbuffer=gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),maxCanvasSize=Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS),v=>Math.min(v,maxRenderbuffer));
        gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        const maskCanvas=document.createElement('canvas');maskCanvas.width=maskCanvas.height=256;const maskContext=maskCanvas.getContext('2d'),maskTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,maskTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,256,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.activeTexture(gl.TEXTURE0);
        let lightCount=0,sampledAt=0;
        const lightPositions=new WeakMap(),lightColors=new Map();
        function bind(buffer){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);for(const [i,size,offset] of [[0,3,0],[1,4,12],[2,1,28]]){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,size,gl.FLOAT,false,32,offset);}}
        function write(data,index,pos,color,alpha,along){let k=index*STRIDE;data[k++]=pos[0];data[k++]=pos[1];data[k++]=pos[2];data[k++]=color[0];data[k++]=color[1];data[k++]=color[2];data[k++]=alpha;data[k]=along;}
        return {
            name:'WebGL2',borderVertices:borderCount,sphereVertices:sphereCount,textureSize:[textureWidth,textureHeight],maxCanvasSize,bytes:routeGPU.bytes+2*lightData.byteLength+sphereBytes+borderBytes+textureBytes+256*256*4,
            updateMask(rects,w,h){maskContext.clearRect(0,0,256,256);maskContext.fillStyle='#fff';for(const r of rects)maskContext.fillRect(r.x*256/w,r.y*256/h,r.w*256/w,r.h*256/h);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,maskTexture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,maskCanvas);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.activeTexture(gl.TEXTURE0);},
            update(routes,points,now){
                sampledAt=now/1000;lightCount=0;routeGPU.update(routes,now);
                for(const light of points){
                    if(lightCount>=MAX_LIGHTS)break;
                    let xyz=lightPositions.get(light.pos);if(!xyz){xyz=point(light.pos).map(v=>v*1.012);lightPositions.set(light.pos,xyz);}
                    let color=lightColors.get(light.color);if(!color){color=rgb(light.color);if(lightColors.size>=256)lightColors.delete(lightColors.keys().next().value);lightColors.set(light.color,color);}
                    write(lightData,lightCount++,xyz,color,light.energy,(light.node?-1:1)*(Math.max(-999,light.at)/1000+1));
                }
                gl.bindBuffer(gl.ARRAY_BUFFER,lightBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,lightData.subarray(0,lightCount*STRIDE));
            },
            draw(now){
                const aspect=canvas.width/canvas.height;
                gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(program);gl.bindVertexArray(mainVAO);
                gl.uniform2f(uniforms.rotation,yaw,pitch);gl.uniform1f(uniforms.aspect,aspect);gl.uniform1f(uniforms.dpr,canvas.width/canvas.clientWidth);gl.uniform1f(uniforms.scale,.77*zoom*Math.min(1,aspect));
                gl.uniform1f(uniforms.time,now/1000);gl.uniform1f(uniforms.sampledAt,sampledAt);gl.uniform1f(uniforms.visitorOpacity,window.currentVisitorOpacity??1);gl.uniform1f(uniforms.motion,reduced?0:1);gl.uniform1f(uniforms.brightness,Math.min(1.5,(window.currentDynBright??4)/4));
                gl.depthMask(true);gl.uniform1f(uniforms.mode,0);bind(sphere);gl.drawArrays(gl.TRIANGLES,0,sphereCount);
                gl.depthMask(false);gl.uniform1f(uniforms.mode,3);bind(borders);gl.drawArrays(gl.LINES,0,borderCount);
                routeGPU.draw(now,.77*zoom*Math.min(1,aspect));gl.useProgram(program);gl.bindVertexArray(mainVAO);
                gl.uniform1i(uniforms.nodeMask,1);gl.uniform2f(uniforms.maskViewport,canvas.width,canvas.height);gl.uniform1f(uniforms.mode,2);bind(lightBuffer);gl.drawArrays(gl.POINTS,0,lightCount);gl.depthMask(true);
            }
        };
    }
    function createFallback(){
        fallbackSurface?.remove();fallbackSurface=document.createElement('canvas');fallbackSurface.className='globe-fallback';fallbackSurface.style.cssText='position:absolute;top:0;left:0;width:100%;pointer-events:none';canvas.after(fallbackSurface);
        const c=fallbackSurface.getContext('2d'),coasts=Coastline.globeRings().map(r=>r.map(([lon,lat])=>point([lat,lon]))),borders=Coastline.globeBorders().map(r=>r.map(([lon,lat])=>point([lat,lon])));
        let paths=[],points=[],sampledAt=0,cache=new Map();
        const project=p=>{const x=Math.cos(yaw)*p[0]+Math.sin(yaw)*p[2],z=-Math.sin(yaw)*p[0]+Math.cos(yaw)*p[2];return [x,Math.cos(pitch)*p[1]-Math.sin(pitch)*z,Math.sin(pitch)*p[1]+Math.cos(pitch)*z];};
        return {name:'Canvas',borderVertices:borders.reduce((n,r)=>n+r.length,0),bytes:0,update(routes,lights,now){
            const keep=new Map();paths=routes.map(r=>{const path=cache.get(r.key)||arc(r.from,r.to);keep.set(r.key,path);return {...r,path};});cache=keep;
            points=lights.map(l=>({...l,xyz:point(l.pos)}));sampledAt=now;
        },draw(now){
            const w=canvas.width,h=canvas.height,r=Math.min(w,h)*.385*zoom,dpr=w/canvas.clientWidth;c.clearRect(0,0,w,h);c.save();c.translate(w/2,h/2);
            const g=c.createRadialGradient(-r*.3,-r*.3,0,0,0,r);g.addColorStop(0,'#153e50');g.addColorStop(1,'#061420');c.fillStyle=g;c.beginPath();c.arc(0,0,r,0,Math.PI*2);c.fill();
            const stroke=(vertices,color,alpha)=>{c.strokeStyle=color;c.globalAlpha=alpha;c.beginPath();let started=false;for(const p of vertices){const v=project(p);if(v[2]<0){started=false;continue;}if(started)c.lineTo(v[0]*r,-v[1]*r);else c.moveTo(v[0]*r,-v[1]*r);started=true;}c.stroke();};
            c.lineWidth=.8*dpr;for(const ring of coasts)stroke(ring,'#41909d',.6);for(const ring of borders)stroke(ring,'#85b9c2',.8);
            for(const route of paths){
                const age=route.age+now-sampledAt,live=Math.max(0,1-age/3200),level=TrafficRuntime.activityLevel(route.energy),flash=TrafficRuntime.flashEnvelope(age);
                c.setLineDash([]);c.lineWidth=.75*dpr;stroke(route.path,live>0?route.color:'#73808f',.12+flash*.15);
                if(!live)continue;
                const speed=TrafficRuntime.flowSpeed(window.currentInitSpeed),phase=reduced?0:now/1000*speed;
                const dash=Math.max(1,window.currentDashLength??8),gap=Math.max(0,window.currentDashGap??6),alpha=(.16+level*.5+flash*(.45+level*.25))*live;
                c.setLineDash([dash*dpr,gap*dpr]);c.lineDashOffset=-phase*dpr;c.lineCap='round';
                c.lineWidth=(4+level*.8)*dpr;stroke(route.path,route.color,alpha*.14);
                c.lineWidth=(1+level*.8)*dpr;stroke(route.path,route.color,alpha);
                c.setLineDash([]);c.lineDashOffset=0;
            }
            for(const light of points){
                const p=project(light.xyz);if(p[2]<0)continue;
                const energy=light.energy*Math.pow(2,-(now-sampledAt)/1800),level=TrafficRuntime.activityLevel(energy),burst=reduced?0:Math.pow(Math.max(0,1-(now-light.at)/650),2);
                const size=(9+(light.node?2:0)+Math.sqrt(level)*21+burst*5)*dpr,x=p[0]*r,y=-p[1]*r;
                const glow=c.createRadialGradient(x,y,0,x,y,size);glow.addColorStop(0,'#efffff');glow.addColorStop(.12,light.color);glow.addColorStop(1,light.color+'00');
                const opacity=Math.min(1,.4+Math.sqrt(level)*.65+burst*.75)*(light.node?1:Math.min(1,energy)*(window.currentVisitorOpacity??1)*globeMask.opacity(x/dpr+labelWidth/2,y/dpr+labelHeight/2,size/dpr*.4));
                c.globalAlpha=opacity;c.fillStyle=glow;c.beginPath();c.arc(x,y,size,0,Math.PI*2);c.fill();
                c.fillStyle=light.color;c.beginPath();c.arc(x,y,size*.46,0,Math.PI*2);c.globalAlpha*=.5;c.fill();c.globalAlpha=opacity;c.strokeStyle=light.color;c.lineWidth=1.2*dpr;c.stroke();
            }
            c.restore();
        }};
    }
    function ensure(){if(engine)return;try{engine=createGPU();}catch(error){console.warn('Globe GPU unavailable',error);}if(!engine)engine=createFallback();resize();}
    function pixelBudget(){
        // Fullscreen WebGL retains native 4K pixels; software rendering stays bounded.
        if(engine?.name==='Canvas')return (expanded?(lowMemory?1200000:1800000):500000)*quality;
        return (expanded?(lowMemory?2000000:8294400):(lowMemory?1000000:2073600))*quality;
    }
    function resize(){
        if(!engine)return;const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
        const [maxWidth,maxHeight]=engine.maxCanvasSize||[8192,8192];
        canvasDpr=devicePixelRatio||1;
        const dpr=Math.min(canvasDpr,engine.name==='Canvas'?1.5:2,Math.sqrt(pixelBudget()/(r.width*r.height)),maxWidth/r.width,maxHeight/r.height);
        labelWidth=r.width;labelHeight=r.height;labelLayer.style.height=r.height+'px';leaderSvg.setAttribute('viewBox',`0 0 ${r.width} ${r.height}`);lastLabelFrame=-1000;
        const w=Math.max(1,Math.floor(r.width*dpr)),h=Math.max(1,Math.floor(r.height*dpr));
        if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
        if(fallbackSurface){fallbackSurface.width=w;fallbackSurface.height=h;fallbackSurface.style.height=r.height+'px';}
        dataBounds();renderVisitors();
    }
    function sample(now){
        snapshot=window.TrajectoryPool?.snapshotTraffic(expanded?MAX_ROUTES:lowMemory?80:120)||[];
        // Node energy is summed from every accepted access, independent of sampled routes.
        lights=Object.entries(trueNodesMap).slice(0,256).map(([node,pos])=>{const offline=window.NodeStream?.isOffline(node)||false;return {node,pos,offline,color:getNodeDisplayColor(node),hits:nodeHits[node]||0,...(offline?{energy:0,at:-1000}:TrajectoryPool.nodeVisual(node))};});
        lights.push(...TrajectoryPool.snapshotLights(expanded?renderLimits.particles:renderLimits.sources));
        engine.update(snapshot,lights,now);
        const text=isZh?`${Object.keys(trueNodesMap).length} 节点 · 访客 → 节点`:`${Object.keys(trueNodesMap).length} nodes · VISITOR → NODE`;
        if(summary.textContent!==text)summary.textContent=text;
    }
    function frame(now){
        raf=0;if(!active)return;
        // Browser zoom or moving monitors can change DPR without resizing the element.
        if(canvasDpr!==(devicePixelRatio||1))resize();
        fpsTarget=reduced?10:engine.name==='Canvas'?20:expanded&&!lowMemory&&quality===1?60:30;
        if(now-last<1000/fpsTarget-.5){raf=requestAnimationFrame(frame);return;}
        const delta=last?now-last:1000/fpsTarget,start=performance.now();
        if(rotating&&!pointers.size&&now-lastInput>1200)yaw+=Math.min(80,delta)*.000085;last=now;
        // New visits reach the next frame under normal load. Large batches share bounded GPU uploads.
        const revision=TrajectoryPool.revision,interval=lights.length>2000||snapshot.length>180?80:1000/60;
        if(now-lastSample>=125||revision!==lastRevision&&now-lastSample>=interval-.5){lastSample=now;sample(now);lastRevision=revision;}
        if(now-lastLabels>=125){lastLabels=now;syncLabels();}
        if(now-lastData>=250){lastData=now;updateData(now);}
        engine.draw(now);layoutLabels(now);frames++;frameCost=performance.now()-start;
        slowFrames=frameCost>12||delta>1000/fpsTarget*2?Math.min(20,slowFrames+1):Math.max(0,slowFrames-1);
        if(expanded&&slowFrames>=12&&quality===1&&now-lastQualityChange>2000){quality=.72;lastQualityChange=now;resize();}
        raf=requestAnimationFrame(frame);
    }
    function sync(){
        if(expanded&&!document.body.classList.contains('show-dashboard'))setExpanded(false);
        active=(expanded||document.body.classList.contains('show-dashboard')&&intersects)&&!document.hidden;
        const overview=document.body.classList.contains('show-dashboard');
        document.getElementById('cyber-dashboard').inert=expanded||!overview;document.getElementById('cyber-dashboard').setAttribute('aria-hidden',String(!overview));
        document.getElementById('map-container').inert=overview;
        window.TrajectoryPool?.setOccluded(overview);
        if(active){ensure();if(!raf){last=0;lastSample=-1000;raf=requestAnimationFrame(frame);}}else {cancelAnimationFrame(raf);raf=0;}
    }
    function setExpanded(value){
        if(expanded===value)return;expanded=value;quality=1;slowFrames=0;pointers.clear();
        if(value){
            savedScroll=document.getElementById('cyber-dashboard').scrollTop;card.before(placeholder);document.body.appendChild(card);const fullscreen=document.getElementById('immersive-toggle');fullscreen.before(fullscreenPlaceholder);card.appendChild(fullscreen);
            const playback=document.getElementById('playback-ctrl');playback.before(playbackPlaceholder);card.appendChild(playback);
            inertElements=Array.from(document.body.children).filter(el=>el!==card&&el.id!=='immersive-toggle'&&!['SCRIPT','STYLE'].includes(el.tagName)).map(el=>[el,el.inert]);
            for(const [el] of inertElements)el.inert=true;
            card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');card.setAttribute('aria-label',isZh?'全屏流量地球':'Fullscreen traffic globe');
        }else{
            fullscreenPlaceholder.replaceWith(document.getElementById('immersive-toggle'));playbackPlaceholder.replaceWith(document.getElementById('playback-ctrl'));placeholder.replaceWith(card);for(const [el,wasInert] of inertElements)el.inert=wasInert;inertElements=[];
            card.removeAttribute('role');card.removeAttribute('aria-modal');card.removeAttribute('aria-label');document.getElementById('cyber-dashboard').scrollTop=savedScroll;
        }
        card.classList.toggle('globe-expanded',value);document.body.classList.toggle('globe-fullscreen',value);
        dataButton.hidden=!value;dataPanel.hidden=!value||!dataVisible;lastData=-1000;dataBounds();
        backButton.hidden=!value;expandButton.setAttribute('aria-expanded',String(value));
        expandButton.setAttribute('aria-label',value?'Exit fullscreen globe':'Fullscreen globe');expandButton.textContent=value?(isZh?'↙ 返回总览':'↙ Overview'):(isZh?'⛶ 聚焦地球':'⛶ Focus globe');
        resize();lastSample=-1000;sync();if(!value){scheduleUiUpdate();scheduleNodeLayout();}(value?canvas:expandButton).focus({preventScroll:true});
    }
    function returnMap(){setExpanded(false);switchDashMode('map');document.querySelector(isMobile?'.mobile-fab [aria-label="Map"]':'#nav-btn-map')?.focus({preventScroll:true});}
    function setZoom(value){zoom=Math.max(.65,Math.min(3.2,value));lastInput=performance.now();plus.disabled=zoom>=3.2;minus.disabled=zoom<=.65;}
    expandButton.addEventListener('click',()=>setExpanded(!expanded));backButton.addEventListener('click',returnMap);
    plus.addEventListener('click',()=>setZoom(zoom*1.2));minus.addEventListener('click',()=>setZoom(zoom/1.2));
    document.getElementById('globe-reset').addEventListener('click',()=>{yaw=-1.6;pitch=.2;setZoom(1);});
    new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['class']});
    new IntersectionObserver(entries=>{intersects=entries[0].isIntersecting;sync();}).observe(canvas);
    new ResizeObserver(resize).observe(canvas);document.addEventListener('visibilitychange',sync);
    canvas.addEventListener('wheel',e=>{e.preventDefault();const units=e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1;setZoom(zoom*Math.exp(-Math.max(-400,Math.min(400,e.deltaY*units))*.002));},{passive:false});
    canvas.addEventListener('pointerdown',e=>{pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});canvas.setPointerCapture(e.pointerId);lastInput=performance.now();});
    const distance=()=>{const a=Array.from(pointers.values());return a.length>=2?Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y):0;};
    canvas.addEventListener('pointermove',e=>{
        const old=pointers.get(e.pointerId);if(!old)return;const before=distance();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
        if(pointers.size>=2){const after=distance();if(before>4&&after>4)setZoom(zoom*after/before);}
        else{yaw+=(e.clientX-old.x)*.008/Math.sqrt(zoom);pitch=Math.max(-1.4,Math.min(1.4,pitch+(e.clientY-old.y)*.008/Math.sqrt(zoom)));}
        lastInput=performance.now();
    });
    const release=e=>{pointers.delete(e.pointerId);lastInput=performance.now();};for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,release);
    canvas.addEventListener('keydown',e=>{
        if(['+','=','-','_'].includes(e.key)){e.preventDefault();setZoom(zoom*(e.key==='-'||e.key==='_'?1/1.2:1.2));return;}
        if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();yaw+=(e.key==='ArrowLeft'?-.1:e.key==='ArrowRight'?.1:0);pitch=Math.max(-1.4,Math.min(1.4,pitch+(e.key==='ArrowUp'?-.1:e.key==='ArrowDown'?.1:0)));lastInput=performance.now();
    });
    document.addEventListener('keydown',e=>{
        if(!expanded)return;
        if(e.key==='Escape'){e.preventDefault();setExpanded(false);return;}
        if(e.key==='Tab'){
            const items=Array.from(card.querySelectorAll('button,input,select,[tabindex]')).filter(el=>!el.hidden&&!el.disabled&&el.tabIndex>=0&&el.getClientRects().length),first=items[0],last=items.at(-1);
            if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
        }
    });
    function rotationLabel(){rotateButton.setAttribute('aria-pressed',String(rotating));rotateButton.textContent=rotating?(isZh?'Ⅱ 暂停旋转':'Ⅱ Pause rotation'):(isZh?'▷ 自动旋转':'▷ Auto rotate');}
    rotateButton.addEventListener('click',()=>{rotating=!rotating;rotationLabel();});rotationLabel();
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;engine=createFallback();resize();sync();});
    canvas.addEventListener('webglcontextrestored',()=>{fallbackSurface?.remove();fallbackSurface=null;engine=null;sync();});
    return {setExpanded,returnMap,refreshDetails(){visitorRevision=-1;lastData=-1000;lastSample=-1000;renderVisitors();},inspectLabels:()=>Array.from(nodeLabels,([node,e])=>({node,hits:e.light.hits,floating:e.floating,position:projectPoint(e.light.pos)})),inspect:()=>({engine:engine?.name||'idle',active,expanded,zoom,frames,frameCost,fpsTarget,quality,rotating,yaw,pitch,routes:snapshot.length,routeLimit:expanded?MAX_ROUTES:lowMemory?80:120,lights:lights.length,lightLimit:MAX_LIGHTS,borderVertices:engine?.borderVertices||0,sphereVertices:engine?.sphereVertices||0,textureSize:engine?.textureSize||[0,0],bufferBytes:engine?.bytes||0,pixelBudget:pixelBudget(),pixelRatio:engine&&canvas.clientWidth?canvas.width/canvas.clientWidth:0,pixels:engine?canvas.width*canvas.height:0,revision:lastRevision,hudUpdates,metrics:liveMetrics}),inspectOverlap:pos=>{const p=projectPoint(pos);return globeMask.opacity(p.x,p.y,8);},inspectLight:nodeOrPos=>lights.find(l=>l.node===nodeOrPos||Array.isArray(nodeOrPos)&&l.pos.join(',')===nodeOrPos.join(',')),arc};
})();

// Bounded overview aggregation; chart construction and refresh happen only while visible.
window.OverviewDashboard=(() => {
    const el=id=>document.getElementById(id),number=n=>n.toLocaleString(undefined,{maximumFractionDigits:1});
    const put=(id,value)=>{const e=el(id),text=String(value);if(e.textContent!==text)e.textContent=text;};
    const colors=['#22d3ee','#a78bfa','#34d399','#fbbf24','#f472b6','#426078'];
    let lastRevision=-1,lastHeatSignature='',updates=0,aggregations=0,cached=null;
    const rowPools=new Map();
    function rank(id,items,total,activity=false){
        let pool=rowPools.get(id);
        if(!pool){const host=el(id),empty=document.createElement('span');empty.className='overview-rank-empty';empty.textContent=isZh?'等待访问数据':'Waiting for visits';host.appendChild(empty);
            const rows=Array.from({length:5},(_,i)=>{const row=document.createElement('div');row.className='overview-rank-row';row.innerHTML='<span class="overview-rank-index"></span><span class="overview-rank-name"></span><b class="overview-rank-count"></b><span class="overview-rank-track"><i></i></span>';row.firstChild.textContent=String(i+1).padStart(2,'0');host.appendChild(row);return {row,name:row.children[1],count:row.children[2],bar:row.lastChild.firstChild};});pool={empty,rows};rowPools.set(id,pool);}
        pool.empty.hidden=items.length>0;
        pool.rows.forEach((r,i)=>{const entry=items[i];r.row.hidden=!entry;if(!entry)return;const [name,count]=entry,share=total?count/total:0;
            if(r.name.textContent!==name)r.name.textContent=name;r.name.title=name;
            const text=number(count);if(r.count.textContent!==text)r.count.textContent=text;
            r.count.title=number(share*100)+'%';r.bar.style.transform=`scaleX(${share.toFixed(4)})`;
            r.name.dataset.active=String(activity&&performance.now()-TrajectoryPool.nodeVisual(name).at<5000);
        });
    }
    function charts(){
        if(typeof Chart==='undefined')return false;
        if(!dashPieChart)dashPieChart=new Chart(el('dash-pie-chart'),{type:'doughnut',data:{labels:[],datasets:[{data:[],backgroundColor:colors,borderWidth:0,hoverOffset:3}]},options:{responsive:true,maintainAspectRatio:false,devicePixelRatio:Math.min(devicePixelRatio||1,1.5),cutout:'76%',animation:false,plugins:{legend:{position:'right',labels:{color:'#8ba8bc',usePointStyle:true,pointStyle:'circle',boxWidth:6,boxHeight:6,padding:12,font:{size:10}}}}}});
        if(!dashBarChart)dashBarChart=new Chart(el('dash-bar-chart'),{type:'bar',data:{labels:[],datasets:[{label:isZh?'访问次数':'Visits',data:[],backgroundColor:'#22d3ee90',hoverBackgroundColor:'#a5f3fc',borderRadius:3,maxBarThickness:18}]},options:{responsive:true,maintainAspectRatio:false,devicePixelRatio:Math.min(devicePixelRatio||1,1.5),animation:false,scales:{x:{grid:{display:false},border:{display:false},ticks:{color:'#638096',font:{size:9},maxTicksLimit:5,maxRotation:0}},y:{beginAtZero:true,border:{display:false},grid:{color:'#ffffff08'},ticks:{color:'#638096',font:{size:9},maxTicksLimit:4,precision:0}}},plugins:{legend:{display:false},tooltip:{backgroundColor:'#0b1929',titleColor:'#c7e4f1',bodyColor:'#67e8f9'}}}});
        return true;
    }
    function aggregate(){
        const regions=new Map(),targets=new Map();let total=0;
        for(const row of statsMap.values()){
            const hits=Math.max(0,Number(row[2])||0),region=String(row[1]||'').split(/[·,]/)[0].trim()||(isZh?'未知来源':'Unknown'),target=String(row[8]||'').trim()||(isZh?'直接访问':'Direct access');
            total+=hits;regions.set(region,(regions.get(region)||0)+hits);targets.set(target,(targets.get(target)||0)+hits);
        }
        const sorted=Array.from(regions).sort((a,b)=>b[1]-a[1]),top=sorted.slice(0,5),rest=sorted.slice(5).reduce((s,p)=>s+p[1],0);
        if(rest)top.push([isZh?'其他':'Other',rest]);
        cached={total,regions:top,targets:Array.from(targets).sort((a,b)=>b[1]-a[1]).slice(0,5)};lastRevision=overviewRevision;aggregations++;
    }
    function render(){
        const now=performance.now(),meter=TrajectoryPool.trafficMetrics(),nodes=Object.entries(nodeHits).sort((a,b)=>b[1]-a[1]),total=nodes.reduce((s,n)=>s+n[1],0),all=Object.keys(trueNodesMap);
        const active=all.filter(name=>{const n=TrajectoryPool.nodeVisual(name);return now-n.at<5000&&n.energy>.03;}).length;
        put('kpi-total',number(total));put('kpi-rate',number(meter.rate));put('kpi-hubs',active+' / '+all.length);put('kpi-conn',number(statsMap.size));
        for(const id of ['kpi-total','kpi-rate','kpi-conn']){const e=el(id);e.title=e.textContent;e.style.fontSize=e.textContent.length>10?'22px':'';}
        const status=pbState.active?'REPLAY':ws?.readyState===1?'LIVE':(isZh?'连接中':'CONNECTING');put('overview-status',status);el('overview-status').dataset.state=ws?.readyState===1&&!pbState.active?'live':'waiting';
        const peak=Math.max(0,...meter.series),scale=Math.max(1,peak),path=meter.series.map((v,i)=>(i?'L':'M')+(i*480/119).toFixed(1)+','+(88-v/scale*78).toFixed(1)).join(' ');
        el('overview-live-chart').querySelector('.overview-trend-stroke').setAttribute('d',path);el('overview-live-chart').querySelector('.overview-trend-area').setAttribute('d',path+' L480 92L0 92Z');
        el('overview-live-chart').setAttribute('aria-label',(isZh?'近 60 秒访问频率，峰值 ':'Last 60 seconds, peak ')+number(peak)+(isZh?' 次 / 秒':' visits/s'));
        put('overview-live-value',number(meter.rate)+' / s');put('overview-peak',(isZh?'峰值 ':'PEAK ')+number(peak)+' / s');
        rank('overview-node-list',nodes.filter(n=>n[1]>0).slice(0,5),total,true);
        const available=charts(),changed=!cached||lastRevision!==overviewRevision;
        if(changed)aggregate();
        if(changed||available&&!dashPieChart.data.labels.length){
            rank('overview-target-list',cached.targets,cached.total);el('overview-origins-empty').hidden=cached.total>0;
            put('overview-cache-note',number(statsMap.size)+(isZh?' 条缓存 · ':' cached entries · ')+number(cached.total)+(isZh?' 次访问':' visits'));
            if(available){dashPieChart.data.labels=cached.regions.map(p=>p[0]);dashPieChart.data.datasets[0].data=cached.regions.map(p=>p[1]);dashPieChart.update('none');}
        }
        // Keep empty intervals, and use the bucket's actual duration in both labels and explanation.
        if(!heatBuckets)resetHeat(currentHeatmap);
        const bins=heatBuckets.bins,step=heatBuckets.step;
        const end=bins?.size?Math.max(...bins.keys()):Math.floor(Date.now()/step)*step;
        const values=Array.from({length:24},(_,i)=>bins?.get(end-(23-i)*step)||0),signature=end+':'+step+':'+values.join(',');
        if(available&&signature!==lastHeatSignature){lastHeatSignature=signature;
            dashBarChart.data.labels=values.map((_,i)=>new Date(end-(23-i)*step).toLocaleString([],step>=86400000?{month:'numeric',day:'numeric'}:{hour:'2-digit',minute:'2-digit'}));
            dashBarChart.data.datasets[0].data=values;dashBarChart.update('none');
        }
        put('overview-bin-size',step>=86400000?(isZh?'每日':'DAILY'):step>=3600000?(isZh?'每小时':'HOURLY'):(isZh?'每分钟':'MINUTELY'));
        const selected=el('time-sel').selectedOptions[0]?.textContent||'',filter=currentFilters.includes('All')?(isZh?'全部节点':'All nodes'):currentFilters.join(', ');
        put('overview-scope',(pbState.active?(isZh?'历史回放':'REPLAY'):(isZh?'数据范围':'DATA RANGE'))+' · '+selected+' · '+filter);
        const health=liveQueue.error||(streamGap?(isZh?'连接曾中断，请查询历史补齐':'Connection gap; query history'):liveQueue.size?(isZh?'待处理 ':'Pending ')+number(liveQueue.size):(isZh?'接收队列畅通':'Receive queue clear'));
        put('overview-health',health);el('overview-health').dataset.warning=String(Boolean(liveQueue.error||streamGap));
        updatePerformanceStatus();updates++;
    }
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&document.body.classList.contains('show-dashboard')&&!TrafficGlobe.inspect().expanded&&el('settings-modal').style.display!=='flex'){e.preventDefault();switchDashMode('map');}});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastDashboardUpdate=-1000;updateDashboard();}});
    return {render,inspect:()=>({updates,aggregations,cacheEntries:statsMap.size,cachedVisits:cached?.total||0,regionTotal:cached?.regions.reduce((s,p)=>s+p[1],0)||0,revision:lastRevision})};
})();

// One persistent fullscreen switch serves the map, overview and focused globe.
(()=>{
 const button=document.getElementById('immersive-toggle');let fallback=false;
 function sync(){const active=Boolean(document.fullscreenElement)||fallback;button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-label',active?'Exit immersive fullscreen':'Enter immersive fullscreen');button.title=active?(isZh?'退出沉浸式全屏':'Exit fullscreen'):(isZh?'沉浸式全屏':'Immersive fullscreen');button.querySelector('span').textContent=active?(isZh?'退出全屏':'Exit fullscreen'):(isZh?'沉浸全屏':'Fullscreen');document.body.classList.toggle('immersive-mode',active);}
 button.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else fallback=!fallback;}catch{fallback=!fallback;}sync();});
 document.addEventListener('fullscreenchange',sync);document.addEventListener('keydown',e=>{if(e.key==='Escape'&&fallback){fallback=false;sync();e.preventDefault();}},true);sync();
})();
