/* Offshore labels and native node counters. Loaded with the other frontend assets. */
    const displayNodesMap = {}; const elbowLines = {}; window.elbowLayer = L.layerGroup();
    
    const nodeOverflowCards = new Map();
    window.nodeElbowLines={};window.nodeTrueDots={};
    let nodeLayoutFrame=0,nodeMoveFrame=0;
    const nodeLabelAnchors=new Map();
    function scheduleNodeLayout(){if(!nodeLayoutFrame)nodeLayoutFrame=requestAnimationFrame(()=>{nodeLayoutFrame=0;refreshNodeLayout();});}
    function nodeBubbleHtml(name,isHub,hits) {
        const offline=window.NodeStream?.isOffline(name)||false;
        const icon=offline?'○':hits>=1000?'🔥':hits>=100?'⚡':hits>=10?'🟢':isHub?'👑':'🖥️';
        return `<div class="bubble-inner"><b class="bubble-title-b" title="${escHtml(name)}">${icon} ${escHtml(name)}</b><span class="bubble-count-line">Hits: <span class="bubble-hits-count" data-val="${hits}" data-current="${hits}">${hits.toLocaleString()}</span><span class="bubble-activity"></span></span></div>`;
    }
    function refreshNodeLayout() {
        if(!map) return;
        nodeLabelAnchors.clear();
        const size=map.getSize(),mapRect=map.getContainer().getBoundingClientRect();
        let top=isMobile?(window.mobileChromeInsets?.top||112):100,bottom=isMobile?(window.mobileChromeInsets?.bottom||96):114,left=16,right=isMobile?(window.mobileChromeInsets?.right||16):16;
        const controlBottom=bottom;
        top=Math.max(top,map.latLngToContainerPoint([85.051128,0]).y+14);
        bottom=Math.max(bottom,size.y-map.latLngToContainerPoint([-85.051128,0]).y+14);
        const coast=Coastline.mask(map);
        const points=Object.entries(trueNodesMap).map(([name,position])=>({name,...map.latLngToContainerPoint(position),side:Coastline.direction(position[0],position[1])}));
        const bounds={x:left,y:top,width:Math.max(0,size.x-left-right),height:Math.max(0,size.y-top-bottom)};
        const labels=TrafficRuntime.pinNodeLabels(TrafficRuntime.layoutNodeLabels(points,bounds,isMobile?118:138,46,16,isMobile?8:24,coast.isSeaBox,isMobile?96:112),bounds,isMobile?118:138);

        let overflow=document.getElementById('node-overflow');
        if(!overflow){
            overflow=document.createElement('aside');overflow.id='node-overflow';overflow.className='node-overflow';
            overflow.innerHTML='<div class="node-rail-title"></div><div class="node-overflow-cards"></div>';
            map.getContainer().appendChild(overflow);L.DomEvent.disableClickPropagation(overflow);L.DomEvent.disableScrollPropagation(overflow);
        }
        const cards=overflow.querySelector('.node-overflow-cards'),retained=new Set();
        for(const n of labels){
            const trueLatLng=L.latLng(trueNodesMap[n.name]);
            const labelLatLng=n.overflow?trueLatLng:map.containerPointToLatLng([n.labelX,n.labelY]);
            displayNodesMap[n.name]=labelLatLng;
            let leader=null;
            if(!n.overflow&&!n.pinned){
                const connection=TrafficRuntime.labelLeader(n);
                leader=connection.points.map(p=>map.containerPointToLatLng(p));
                leader[0]=trueLatLng;
            }
            elbowLines[n.name]=leader;
            updateMarkerDisplay(n.name,labelLatLng,leader,trueLatLng,n.overflow);
            if(!n.overflow)nodeLabelAnchors.set(n.name,{position:labelLatLng,pinned:!!n.pinned});
            const tooltip=nodeMarkers[n.name].getTooltip()?.getElement();
            if(tooltip){tooltip.classList.toggle('node-pinned',!!n.pinned);tooltip.dataset.edge=n.pinned?(isZh?'视野边缘':'EDGE'):'';}

            if(n.overflow){
                retained.add(n.name);
                if(!nodeOverflowCards.has(n.name)){const card=document.createElement('div');card.className='node-bubble node-overflow-card';
                card.innerHTML=nodeBubbleHtml(n.name,nodeMarkers[n.name]._isHub,nodeHits[n.name]||0);cards.appendChild(card);nodeOverflowCards.set(n.name,card);}
            }
            updateSingleNodeBubble(n.name);
            const marker=nodeMarkers[n.name];updateNodeActivity(n.name,marker._activityLevel||0,marker._activityEnergy||0,marker._activityBurst||0);
        }
        for(const [name,card] of nodeOverflowCards)if(!retained.has(name)){card.remove();nodeOverflowCards.delete(name);}
        for(const name of Object.keys(nodeMarkers))if(!Object.hasOwn(trueNodesMap,name)){nodeMarkers[name].remove();delete nodeMarkers[name];window.nodeTrueDots[name]?.remove();window.nodeElbowLines[name]?.remove();delete window.nodeTrueDots[name];delete window.nodeElbowLines[name];}
        overflow.hidden=nodeOverflowCards.size===0;
        overflow.querySelector('.node-rail-title').textContent=isZh?`其余 ${nodeOverflowCards.size} 个节点`:`${nodeOverflowCards.size} more nodes`;
        overflow.style.bottom=(controlBottom+4)+'px';overflow.style.right=(right+4)+'px';
        window.TrajectoryPool?.invalidateGeometry();
    }

    function updateMarkerDisplay(name,displayLatLng,lineLatLngs,trueLatLng,overflow=false) {
        let m=nodeMarkers[name];const isHub=name==='Direct Access';const hits=nodeHits[name]||0;
        const color=getNodeDisplayColor(name),tClass=`node-bubble ${isHub?'dc-tip':'edge-tip'}`;
        const tooltipHtml=nodeBubbleHtml(name,isHub,hits);
        if(!m){
            const icon=L.divIcon({className:'custom-icon',html:`<div style="color:${color}"><div class="node-pulse ${isHub?'hub-pulse':'edge-pulse'}"></div><div class="node-core ${isHub?'hub-core':'edge-core'}"></div></div>`,iconSize:[0,0]});
            m=L.marker(trueLatLng,{icon,zIndexOffset:isHub?1000:0,interactive:false}).addTo(map);nodeMarkers[name]=m;
            m.bindTooltip(tooltipHtml,{permanent:true,direction:'center',className:tClass,offset:[0,0],interactive:false});
        }else if(!m.getLatLng().equals(trueLatLng))m.setLatLng(trueLatLng);
        if(overflow)m.closeTooltip();else {m.openTooltip();m.getTooltip().setLatLng(displayLatLng);}
        // Real map position remains independent from the label and its leader.
        if(!window.nodeTrueDots[name])window.nodeTrueDots[name]=L.circleMarker(trueLatLng,{renderer:mapCanvas,radius:4,color,fillColor:color,fillOpacity:.9,weight:1.5,interactive:false}).addTo(window.elbowLayer);
        else window.nodeTrueDots[name].setLatLng(trueLatLng);
        if(lineLatLngs){if(window.nodeElbowLines[name])window.nodeElbowLines[name].setLatLngs(lineLatLngs);
        else window.nodeElbowLines[name]=L.polyline(lineLatLngs,{renderer:mapCanvas,color,weight:1,opacity:.65,interactive:false}).addTo(window.elbowLayer);}
        else if(window.nodeElbowLines[name]){window.nodeElbowLines[name].remove();delete window.nodeElbowLines[name];}
        m._isHub=isHub;
    }

    function updateSingleNodeBubble(name) {
        const marker = nodeMarkers[name]; if (!marker) return;
        const hits = nodeHits[name] || 0, color = getNodeDisplayColor(name), offline=window.NodeStream?.isOffline(name)||false;
        const elements=[marker.getTooltip()?.getElement(),nodeOverflowCards.get(name)];
        const icon=offline?'○':hits>=1000?'🔥':hits>=100?'⚡':hits>=10?'🟢':marker._isHub?'👑':'🖥️';
        for(const element of elements){
            const counter=element?.querySelector('.bubble-hits-count');if(counter&&counter.dataset.val!==String(hits)){counter.dataset.val=String(hits);activeOdometers.add(counter);if(!odometerFrame&&!document.hidden)odometerFrame=requestAnimationFrame(animateOdometers);}
            const title=element?.querySelector('.bubble-title-b');if(title)title.textContent=icon+' '+name;
            element?.style.setProperty('--node-color',color);if(element)element.dataset.offline=String(offline);
        }
        marker.getElement()?.style.setProperty('--node-color',color);if(marker.getElement())marker.getElement().dataset.offline=String(offline);
        const wrapper = marker.getElement()?.querySelector('div');
        if (wrapper) wrapper.style.color = color;
        if (marker._nativeColor !== color) {
            window.nodeTrueDots[name]?.setStyle({color, fillColor:color});
            window.nodeElbowLines[name]?.setStyle({color});
            marker._nativeColor = color;
        }
    }


// Center a world smaller than the viewport; constrain panning on larger worlds.
function coverMapCenter(center,zoom,size) {
    const crs=L.CRS.EPSG3857,scale=crs.scale(zoom),p=crs.latLngToPoint(center,zoom);
    for(const axis of ['x','y'])p[axis]=scale<=size[axis]+2?scale/2:Math.max(size[axis]/2+1,Math.min(scale-size[axis]/2-1,p[axis]));
    return crs.pointToLatLng(p,zoom);
}
let correctingMapCover=false;
function refreshMapCover(reset=false) {
    if(correctingMapCover)return;
    correctingMapCover=true;
    try{
        const size=map.getSize(),min=TrafficRuntime.worldZoom(size.x,size.y);
        // Rebuild the bounded cluster index when a resize changes its root zoom.
        const rebuild=min!==map.getMinZoom()&&typeof cluster!=='undefined'&&map.hasLayer(cluster);
        const markers=rebuild?cluster.getLayers():null;
        if(rebuild)map.removeLayer(cluster);
        map.setMinZoom(min);
        if(rebuild){cluster.clearLayers();cluster.addLayers(markers);map.addLayer(cluster);}
        const zoom=reset?min:Math.max(min,map.getZoom());
        const center=coverMapCenter(reset?L.latLng(0,0):map.getCenter(),zoom,size);
        map.setView(center,zoom,{animate:false});
    }finally{correctingMapCover=false;}
}
// Leaflet rounds projected centers; correct the last fractional edge pixel too.
document.addEventListener('DOMContentLoaded',()=>map.on('moveend',()=>{
    const center=map.getCenter(),target=coverMapCenter(center,map.getZoom(),map.getSize());
    if(map.project(center).distanceTo(map.project(target))>1)refreshMapCover();
}));

// Only screen clamping runs while dragging; expensive coastline layout runs on settle.
document.addEventListener('DOMContentLoaded',()=>map.on('move',()=>{
    if(nodeMoveFrame)return;
    nodeMoveFrame=requestAnimationFrame(()=>{
        nodeMoveFrame=0;const size=map.getSize(),hw=isMobile?59:69,top=isMobile?(window.mobileChromeInsets?.top||112)+23:123,bottom=size.y-(isMobile?(window.mobileChromeInsets?.bottom||96)+23:137);
        const occupied=[];
        for(const [name,a] of nodeLabelAnchors){
            const p=map.latLngToContainerPoint(a.position),right=isMobile?(window.mobileChromeInsets?.right||16):16,x=Math.max(hw+16,Math.min(size.x-hw-right,p.x));
            let y=Math.max(top,Math.min(bottom,p.y));
            // Keep edge neighbours readable throughout the gesture.
            for(let i=0;i<occupied.length;i++)if(Math.abs(x-occupied[i].x)<hw*2+8&&Math.abs(y-occupied[i].y)<52){y=occupied[i].y+52;if(y>bottom)y=top;}
            occupied.push({x,y});nodeMarkers[name]?.getTooltip()?.setLatLng(map.containerPointToLatLng([x,y]));
        }
    });
}));
