// Hide only this Nexus deployment's hosts, never similarly named business domains.
window.VisitorFilter=(()=>{
    const host=value=>{try{const text=String(value||'').trim(),u=new URL(text.includes('://')?text:'http://'+text);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.hostname.toLowerCase().replace(/\.$/,''):'';}catch{return '';}};
    const domains=new Set([...nexusDomains,location.hostname].map(host).filter(Boolean));
    let enabled=localStorage.getItem('hideNexusVisitors')==='true';
    const accepts=domain=>!enabled||!domains.has(host(domain));
    function sync(){document.querySelectorAll('[data-hide-nexus]').forEach(el=>{el.checked=enabled;el.title=[...domains].join(', ');});}
    function set(value){
        enabled=Boolean(value);localStorage.setItem('hideNexusVisitors',String(enabled));sync();
        // Remove existing activity immediately while the matching aggregate is fetched.
        currentStats=Array.from(statsMap.values()).filter(s=>accepts(s[8]));rebuildStatsMap();
        globalHistory=globalHistory.filter(h=>accepts(h[6]));calculateNodeHits();resetHeat();clearActiveLines();seedHistoricalRoutes();
        window.TrafficGlobe?.refreshDetails();
        renderTable();refreshNodeLayout();scheduleUiUpdate();
        return applyFilters(true);
    }
    return {accepts,set,sync,get enabled(){return enabled;},query:()=>enabled?'&hide_nexus=true&nexus_host='+encodeURIComponent(location.hostname):'',domains:[...domains]};
})();

const lowMemory = isMobile || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const renderLimits = { particles: lowMemory ? 8000 : 24000, routes: lowMemory ? 180 : 480, history: lowMemory ? 600 : 1600, pings: lowMemory ? 24 : 64, sources: lowMemory ? 400 : 1200, dpr: (navigator.deviceMemory && navigator.deviceMemory <= 2) ? 1 : 1.5, pixelBudget: lowMemory ? 1500000 : 3000000, markers: lowMemory ? 350 : 1200, stats: lowMemory ? 2000 : 6000 };
const liveQueue = new TrafficRuntime.EventQueue(lowMemory ? 1024 : 4096, { onReady: scheduleLiveDrain, maxPending: lowMemory ? 200000 : 1000000 });
const pendingVisitorUpdates = new Map();
let streamGap = false, rowFlashUntil = 0;
const markerLRU = new Map(), dirtyNodes = new Set();
let liveFrame = 0, uiTimer = 0, lastChartUpdate = 0, tableDirty = true;
let heatBuckets = null, dataRequest = null, playbackRequest = null, requestVersion = 0, hiddenNeedsRefresh = false;
let overviewRevision = 0, statsEvicted = 0, lastDashboardUpdate = -1000, chartDirty = true;
function statKey(row) { return TrafficRuntime.statKey(row); }
function heatStep() { const days = Number(document.getElementById('time-sel').value); return days <= 0.05 ? 60000 : days <= 1 ? 3600000 : 86400000; }
function resetHeat(rows = []) { heatBuckets = new TrafficRuntime.HeatBuckets(heatStep(), 1440); for (const row of rows) heatBuckets.add(row[0], Number(row[1])); currentHeatmap = heatBuckets.rows(); }
function canonicalNode(name) { return TrafficRuntime.resolveNode(name, trueNodesMap, nodeAliases); }
function addHistoryLine(from, to, node = '') {
    const name = canonicalNode(node);
    window.TrajectoryPool.addHistory(from, to, name, getNodeBaseColor(name, 1));
}
function seedHistoricalRoutes() {
    window.TrajectoryPool.clearHistory();
    // Statistics cover nodes that may be absent from the most recent event page.
    for (const row of currentStats) addHistoryLine(fixZeroPos(row[5],row[6]),getTruePos(row[7]),row[7]);
    for (let i=globalHistory.length-1;i>=0;i--) {
        const h=globalHistory[i]; addHistoryLine(fixZeroPos(h[0],h[1]),getTruePos(h[3]),h[3]);
    }
}
function resetVisitorLayer() {
    pendingMarkers = []; pendingRefreshMarkers.clear(); pendingHeatmapPoints = []; markerQueue = [];
    pendingVisitorUpdates.clear();
    markerLRU.clear(); window.visitorMarkers = Object.create(null);
    if (typeof cluster !== 'undefined') { if (isSpiderfied) cluster.unspiderfy(); cluster.clearLayers(); }
}
function retainMarker(key, marker) {
    markerLRU.delete(key); markerLRU.set(key, marker);
    if (markerLRU.size <= renderLimits.markers) return;
    const oldest = markerLRU.keys().next().value, stale = markerLRU.get(oldest);
    markerLRU.delete(oldest); delete window.visitorMarkers[oldest];
    pendingMarkers = pendingMarkers.filter(m => m !== stale);
    markerQueue = markerQueue.filter(m => m !== stale); pendingRefreshMarkers.delete(stale);
    cluster.removeLayer(stale); stale.unbindTooltip(); stale.unbindPopup();
}
function ingestVisitor(data, visual = true) {
    if (!VisitorFilter.accepts(data.target_domain)) return;
    const node = canonicalNode(data.server_name), count = Number(data.count) || 1;
    const row = [data.ip, data.location, count, data.time, data.lang, data.lat, data.lon, node, data.target_domain];
    const key = statKey(row), old = statsMap.get(key);
    if (old) { old[2] += count; if (TrafficRuntime.timestamp(data.time) >= TrafficRuntime.timestamp(old[3])) old[3] = data.time; }
    statsMap.delete(key); statsMap.set(key, old || row); overviewRevision++;
    if (statsMap.size > renderLimits.stats) { statsMap.delete(statsMap.keys().next().value); statsEvicted++; }
    nodeHits[node] = (nodeHits[node] || 0) + count; dirtyNodes.add(node); tableDirty = true;
    if (!heatBuckets) resetHeat(currentHeatmap);
    heatBuckets.add(data.time, count); chartDirty = true;
    const from = fixZeroPos(data.lat, data.lon), to = getTruePos(node), color = getNodeBaseColor(node, count);
    addHistoryLine(from, to, node);
    if (!visual) return;
    window.TrajectoryPool.fireLine(from, to, color, 1 + Math.min(1, Math.log10(count) / 3), node, count);

    const markerKey = JSON.stringify([data.ip, node, data.target_domain, from]);
    pendingVisitorUpdates.delete(markerKey);
    pendingVisitorUpdates.set(markerKey, [markerKey, from, data.ip, data.target_domain, data.location, (old || row)[2], color]);
    if (pendingVisitorUpdates.size > renderLimits.markers) pendingVisitorUpdates.delete(pendingVisitorUpdates.keys().next().value);
    const now = performance.now();
    rowFlashUntil = now + 600;
}
function drainLiveQueue() {
    liveFrame = 0;
    if (document.hidden || pbState.active || pbState.loading) return;
    const deadline = performance.now() + 4;
    let consumed = 0;
    while (liveQueue.readySize && window.TrajectoryPool.availableSlots() && performance.now() < deadline && consumed < 500) {
        ingestVisitor(liveQueue.shift()); consumed++;
    }
    scheduleUiUpdate();
    scheduleLiveDrain();
}
function scheduleLiveDrain() {
    if (!liveFrame && !document.hidden && !pbState.active && !pbState.loading && liveQueue.readySize && window.TrajectoryPool?.availableSlots()) liveFrame = requestAnimationFrame(drainLiveQueue);
    scheduleUiUpdate();
}
function queueLiveEvent(event) {
    if (!VisitorFilter.accepts(event.target_domain)) return;
    if (!liveQueue.push(event)) streamGap = true;
    scheduleLiveDrain();
}
function flushVisitorUpdates() {
    const deadline=performance.now()+3;
    let done=0;
    for (const [key,args] of pendingVisitorUpdates) {
        spawnOrUpdateVisitorMarker(...args); pendingVisitorUpdates.delete(key);
        if (++done >= 64 || performance.now()>=deadline) break;
    }
}
function updateNodeActivity(name, level, energy, burst=0) {
    const marker=nodeMarkers[name]; if(!marker)return;
    marker._activityLevel=level;marker._activityEnergy=energy;marker._activityBurst=burst;
    const offline=window.NodeStream?.isOffline(name)||false;
    if(offline){level=0;energy=0;burst=0;}
    const color=getNodeDisplayColor(name),rounded=level.toFixed(3);
    if(document.body.classList.contains('show-dashboard'))return;
    const elements=[marker.getElement(),marker.getTooltip()?.getElement(),nodeOverflowCards.get(name)];
    for(const el of elements) if(el){
        if(el.dataset.activity!==rounded){el.dataset.activity=rounded;el.style.setProperty('--activity',rounded);}
        el.dataset.offline=String(offline);el.dataset.active=String(energy>=0.03);el.style.setProperty('--node-color',color);el.style.setProperty('--burst',burst.toFixed(3));
    }
    for(const el of elements){const rate=el?.querySelector('.bubble-activity');
    if(rate){rate.textContent=offline?(isZh?'离线':'OFFLINE'):energy<0.03?'':(isZh?'实时':'LIVE');rate.title=offline?(isZh?'30 秒未收到节点上报':'No node report for 30 seconds'):(isZh?'近期活跃度 ':'Recent activity ')+Math.round(level*100)+'%';}}
    window.nodeTrueDots?.[name]?.setStyle({radius:4+Math.sqrt(level)*7+burst*1.5,fillOpacity:.55+level*.35+burst*.1,weight:1.5+level});
}
function playbackEvent(h) { return { ip: h[4], location: h[2], lat: h[0], lon: h[1], server_name: h[3], target_domain: h[6], time: h[5], lang: 'Historical', count: 1 }; }
function resetPlaybackData() {
    overviewRevision++;
    clearActiveLines(); resetVisitorLayer(); window.historyLines.clearLayers();
    currentStats = []; statsMap.clear(); statsEvicted = 0; resetHeat();
    for (const key in nodeHits) delete nodeHits[key];
    Object.keys(nodeMarkers).forEach(name => dirtyNodes.add(name));
    vsData = []; tableDirty = true; pbState.index = 0; pbState.lastTime = performance.now();
    if (fogLayer) fogLayer.setLatLngs([]);
    document.getElementById('pb-slider').value=0;updatePlaybackPosition();
    window.TrafficGlobe?.refreshDetails();
    scheduleUiUpdate();
}
function updatePlaybackPosition() {
    const h = pbState.hist[Math.max(0, pbState.index - 1)];
    if (!h) return;
    document.getElementById('pb-slider').value = pbState.index - 1;
    document.getElementById('pb-current').textContent = new Date(TrafficRuntime.timestamp(h[5])).toLocaleString();
    document.getElementById('pb-current-node').textContent = h[3];
}
function seekPlayback(index) {
    if (!pbState.active) return;
    const resume = pbState.seekTarget != null ? pbState.resumeAfterSeek : pbState.playing;
    cancelAnimationFrame(pbState.rAF); resetPlaybackData();
    pbState.resumeAfterSeek = resume; pbState.seekTarget = Math.min(pbState.hist.length, Math.max(0, index + 1));
    pbState.rAF = requestAnimationFrame(pbLoop);
}
function updatePerformanceStatus() {
    const el = document.getElementById('render-status'); if (!el) return;
    const info = window.TrajectoryPool?.inspect();
    el.textContent = (info?.engine || 'Canvas') + ' · ' + (isZh ? '动态 ' : 'LIVE ') + (info?.activePackets || 0).toLocaleString() + (liveQueue.size ? (isZh ? ' · 待绘制 ' : ' · Pending ') + liveQueue.size.toLocaleString() : '');
    const note = document.getElementById('data-scope-note');
    if (note) {
        note.dataset.warning=String(Boolean(streamGap||liveQueue.error));
        note.textContent=liveQueue.error || (streamGap ? (isZh?'连接中断期间存在实时缺口，可查询历史记录':'Live connection had a gap; query stored history') : (isZh?'实时逐条绘制 · 表格 / 可点击标记保留最近记录':'Every received visit animated · table / clickable markers retain recent entries'));
    }
}

// Update each visible visitor bubble once, even when it represents many IPs or nodes.
function updateVisitorActivity(readActivity) {
    const visible=new Map(),now=performance.now();window.VisitorOcclusion?.refresh();
    for(const marker of markerLRU.values()){
        const parent=cluster.getVisibleParent(marker);if(!parent)continue;
        const el=parent.getElement();if(!el)continue;
        const pos=marker.getLatLng(),state=readActivity([pos.lat,pos.lng]);
        const v=state?TrafficRuntime.activityVisual(state,now):{level:0,burst:0};
        const prior=visible.get(el);
        if(!prior){v.point=map.latLngToContainerPoint(parent.getLatLng());visible.set(el,v);}else{prior.level=Math.max(prior.level,v.level);prior.burst=Math.max(prior.burst,v.burst);}
    }
    for(const [el,v] of visible){
        const overlap=window.VisitorOcclusion?.opacity(v.point,18+Math.sqrt(v.level)*15)??1;el.style.setProperty('--visitor-overlap',String(overlap));el.dataset.nodeOverlap=String(overlap<1);
        el.style.setProperty('--visitor-activity',v.level.toFixed(3));el.style.setProperty('--visitor-burst',v.burst.toFixed(3));
        el.dataset.visitorActive=String(v.level>.004);
    }
}

// One shared node mask for DOM bubbles and the flat-map light layer; refreshed at most 8 Hz.
window.VisitorOcclusion=(()=>{
 const mask=new TrafficRuntime.RectMask();let sampled=-1000;
 function refresh(force=false){const now=performance.now();if(!force&&now-sampled<125)return;sampled=now;const rects=[],origin=map.getContainer().getBoundingClientRect();
  for(const marker of Object.values(nodeMarkers)){const tooltip=marker.getTooltip()?.getElement();if(tooltip&&tooltip.getClientRects().length){const r=tooltip.getBoundingClientRect();rects.push({x:r.x-origin.x-3,y:r.y-origin.y-3,w:r.width+6,h:r.height+6});}
   const p=map.latLngToContainerPoint(marker.getLatLng()),radius=12+Math.sqrt(marker._activityLevel||0)*12;rects.push({x:p.x-radius,y:p.y-radius,w:radius*2,h:radius*2});}
  const rail=document.getElementById('node-overflow');if(rail&&!rail.hidden){const r=rail.getBoundingClientRect();rects.push({x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height});}mask.reset(rects);
 }
 return {refresh,opacity:(p,r=0)=>mask.opacity(p.x,p.y,r),inspect:()=>({rects:mask.rects.length,cells:mask.grid.size})};
})();
