/* Two instanced GPU draws: per-access flowing dashes and their source lights.
   The Canvas fallback keeps the same queue/backpressure contract. */
function createPacketRenderer(map, L, capacity) {
    const surface = L.DomUtil.create('canvas', 'traffic-canvas traffic-packets', map.getPanes().overlayPane);
    surface.style.pointerEvents = 'none'; surface.style.zIndex = '351';
    const gl = surface.getContext('webgl2', {alpha:true, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:false, powerPreference:'low-power'});
    let lost = !gl, program, instanceBuffer, uniforms;
    const stride = 12, data = new Float32Array(capacity * stride);
    function init() {
        const vertex = `#version 300 es
        precision highp float;
        layout(location=0) in vec2 corner;
        layout(location=1) in vec4 ends;
        layout(location=2) in vec4 timing;
        layout(location=3) in vec4 tint;
        uniform vec2 viewport; uniform float now; uniform float mode; uniform float brightness;
        out vec2 uv; out vec3 color; out float gain; out float routeLength; out float halfWidth; out float pulse; out float phase;
        void main() {
            pulse=clamp((now-timing.x)/1.2,0.0,1.0);phase=timing.y;
            vec2 delta=ends.zw-ends.xy; float len=max(1.0,length(delta)); vec2 dir=delta/len;
            vec2 p; uv=corner; color=tint.rgb; routeLength=len; halfWidth=timing.z;
            // CPU combines only exactly coincident paths; every access contributes its envelope.
            gain=brightness*tint.a;
            if(mode<0.5) {
                p=ends.xy+delta*corner.x+vec2(-dir.y,dir.x)*corner.y*(timing.z+4.0);
            } else {
                p=ends.xy+vec2(corner.x*2.0-1.0,corner.y)*timing.w;
            }
            gl_Position=vec4(p.x/viewport.x*2.0-1.0,1.0-p.y/viewport.y*2.0,0.0,1.0);
        }`;
        const fragment = `#version 300 es
        precision highp float;
        uniform float mode; uniform float dashLength; uniform float dashSpace;
        in vec2 uv; in vec3 color; in float gain; in float routeLength; in float halfWidth; in float pulse; in float phase; out vec4 outColor;
        void main() {
            float a;
            if(mode<0.5) {
                float along=uv.x*routeLength, across=abs(uv.y)*(halfWidth+4.0);
                // Rounded luminous dashes move visitor → node without arrowheads.
                float dash=max(1.0,dashLength),pitch=dash+max(0.0,dashSpace);
                float x=abs(mod(along-phase+pitch*.5,pitch)-pitch*.5);
                float width=max(.6,halfWidth*.4);
                float d=length(vec2(max(0.0,x-max(0.0,dash*.5-width)),across));
                float core=1.0-smoothstep(width*.45,width+.6,d);
                float halo=exp(-d*d/(width*width*4.0+2.0))*.18;
                a=exp(-across*across/1.2)*.06+core*.9+halo;
            } else {
                float d=length(vec2(uv.x*2.0-1.0,uv.y)); if(d>1.0) discard;
                float core=max(.025,halfWidth);
                float orb=exp(-pow(d/core,4.0)*1.5);
                float rim=exp(-pow((d-core)*70.0,2.0))*.7;
                float ring=mix(core+.08,.95,1.0-pow(1.0-pulse,3.0));
                float ripple=exp(-pow((d-ring)*55.0,2.0))*pow(1.0-pulse,1.5);
                a=orb*.8+rim+exp(-d*d*8.0)*.22+ripple*.8;
            }
            vec3 lit=mix(color,vec3(.94,1.0,1.0),mode<.5?exp(-uv.y*uv.y*36.0)*.28:exp(-length(vec2(uv.x*2.0-1.0,uv.y))*35.0)*.45);
            outColor=vec4(lit,min(1.0,a*gain));
        }`;
        const compile = (type, source) => { const s=gl.createShader(type); gl.shaderSource(s,source); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
        const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
        program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
        gl.deleteShader(vs);gl.deleteShader(fs);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);gl.bindVertexArray(gl.createVertexArray());
        const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,-1,1,-1,0,1,0,1,1,-1,1,1]),gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
        instanceBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);gl.bufferData(gl.ARRAY_BUFFER,data.byteLength,gl.DYNAMIC_DRAW);
        for(let i=1;i<=3;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,stride*4,(i-1)*16);gl.vertexAttribDivisor(i,1);}
        uniforms=Object.fromEntries(['viewport','now','mode','dashLength','brightness','dashSpace'].map(n=>[n,gl.getUniformLocation(program,n)]));
        gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);lost=false;
    }
    if(gl)try{init();}catch(error){console.warn('GPU packet renderer unavailable',error);lost=true;}
    surface.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;surface.style.visibility='hidden';});
    surface.addEventListener('webglcontextrestored',()=>{try{init();surface.style.visibility='';}catch{lost=true;}});
    let used=0,routeInstances=0,lightInstances=0,drawCalls=0;
    return {
        get available(){return !lost;}, surface, data,
        reset(width,height,dpr){surface.width=Math.round(width*dpr);surface.height=Math.round(height*dpr);surface.style.width=width+'px';surface.style.height=height+'px';L.DomUtil.setPosition(surface,map.containerPointToLayerPoint([0,0]));},
        begin(){used=0;},
        add(segment,particle,color,weight,energy,overlap){
            if(used>=data.length/stride)return false;
            let i=used++*stride;
            data[i++]=segment.a.x;data[i++]=segment.a.y;data[i++]=segment.b.x;data[i++]=segment.b.y;
            data[i++]=particle.born/1000;data[i++]=particle.phase||0;data[i++]=weight;data[i++]=Math.max((window.currentVisitorDotSize||4)*1.5+energy*13,(window.currentHaloSize||40)*0.75);
            data[i++]=color[0];data[i++]=color[1];data[i++]=color[2];data[i]=overlap;
            return true;
        },
        addLight(pos,state,color,visual,now,reduced=false){
            if(used>=data.length/stride)return;
            let i=used++*stride;
            const extent=Math.max(22,(window.currentHaloSize??40)*(.6+Math.sqrt(visual.level)*.7)+visual.burst*12);
            data[i++]=pos.x;data[i++]=pos.y;data[i++]=pos.x;data[i++]=pos.y;
            data[i++]=(reduced?now-1200:state.at)/1000;data[i++]=0;data[i++]=((window.currentVisitorDotSize??4)/2+Math.sqrt(visual.level)*13)/extent;data[i++]=extent;
            data[i++]=color[0];data[i++]=color[1];data[i++]=color[2];data[i]=Math.min(1,(.5+Math.sqrt(visual.level)*.65+visual.burst*.65)*Math.min(1,visual.energy))*(window.currentVisitorOpacity??1)*(visual.occlusion??1);
        },
        draw(now,width,height,brightness,mode=0){
            if(mode===0){routeInstances=used;drawCalls=0;}else lightInstances=used;
            if(lost)return;
            gl.viewport(0,0,surface.width,surface.height);
            if(mode===0){gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);}
            if(!used)return;
            gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,data.subarray(0,used*stride));
            gl.uniform2f(uniforms.viewport,width,height);gl.uniform1f(uniforms.now,now/1000);gl.uniform1f(uniforms.dashLength,window.currentDashLength??8);gl.uniform1f(uniforms.brightness,brightness);gl.uniform1f(uniforms.dashSpace,window.currentDashGap??6);
            gl.uniform1f(uniforms.mode,mode);gl.drawArraysInstanced(gl.TRIANGLES,0,6,used);drawCalls++;
        },
        inspect(){return {engine:lost?'Canvas':'WebGL2',instances:routeInstances,lightInstances,bufferBytes:data.byteLength,drawCalls:lost?0:drawCalls};}
    };
}

/* Straight, one-shot access flashes. Persistent history uses a separate cached canvas. */
function createTrajectoryLayer(map, L, limits) {
    const { FairNodeMap, BoundedMap, flashEnvelope } = TrafficRuntime;
    const routes = new FairNodeMap(limits.routes), history = new FairNodeMap(limits.history || limits.routes);
    const pings = new BoundedMap(limits.pings), sources = new BoundedMap(limits.sources||1200);
    const packets = new Map(), nodeActivity = new Map(), drawnByNode = new Map(), renderGroups = new Map(), activeSources = new Map();
    const readSource=pos=>sources.get(pos.join(','))||activeSources.get(pos.join(','));
    const maxPackets = limits.particles || 24000, gpu = createPacketRenderer(map,L,maxPackets);
    const trafficMeter=new TrafficRuntime.TrafficMeter();let revision=0;
    let serial=0, admitted=0, completed=0, represented=0, drawnVisitors=0, lastActivityUpdate=-1000, frameCost=0;
    const capacity = () => gpu.available ? maxPackets : Math.min(maxPackets,1200);
    const rgb = color => [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
    const canvas = L.DomUtil.create('canvas', 'traffic-canvas traffic-afterglow', map.getPanes().overlayPane);
    canvas.style.pointerEvents = 'none';
    const ctx = canvas.getContext('2d', { alpha:true });
    const historyCanvas = L.DomUtil.create('canvas','traffic-canvas traffic-history',map.getPanes().overlayPane), historyCtx = historyCanvas.getContext('2d');
    historyCanvas.style.zIndex='349';
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf=0, version=0, width=0, height=0, lastFrame=0, frameMs=reducedMotion?100:1000/60;
    let frozenAt=null;
    let occluded=false,rasterFrames=0,paused=false, historyDirty=true, historyVisible=true, slowFrames=0, historyPaints=0, lastHistoryPaint=-1000, paintedVersion=-1;
    let lastNodes=[], lastHistoryNodes=[], frameCount=0, renderedHistory=0, renderedRoutes=0;
    const visible = () => !document.hidden && !paused;
    const lifetime = () => Math.max(900, window.currentResTimeMs || 3000);
    function wake() { if (!raf && visible()) raf=requestAnimationFrame(draw); }
    function invalidateGeometry() { version++; historyDirty=true; wake(); }
    function reset() {
        const size=map.getSize(), dpr=Math.min(devicePixelRatio||1, limits.dpr, Math.sqrt((limits.pixelBudget||3000000)/Math.max(1,size.x*size.y)));
        width=size.x; height=size.y;
        for (const surface of [canvas,historyCanvas]) { surface.width=Math.round(width*dpr); surface.height=Math.round(height*dpr); surface.style.width=width+'px';surface.style.height=height+'px';L.DomUtil.setPosition(surface,map.containerPointToLayerPoint([0,0])); }
        canvas.style.width=width+'px'; canvas.style.height=height+'px';
        ctx.setTransform(dpr,0,0,dpr,0,0); historyCtx.setTransform(dpr,0,0,dpr,0,0);
        L.DomUtil.setPosition(canvas,map.containerPointToLayerPoint([0,0]));
        gpu.reset(width,height,dpr);
        invalidateGeometry();
    }
    function keyFor(a,b,node) { return JSON.stringify([a,b,node]); }
    function geometry(r) {
        if (r.version===version) return;
        const anchor=limits.resolveTarget?.(r.node);
        const to=anchor ? (Array.isArray(anchor)?anchor:[anchor.lat,anchor.lng]) : r.to;
        const from=map.latLngToContainerPoint(r.from), target=map.latLngToContainerPoint(to);
        // One fixed world, one exact source and destination. Labels never enter geometry.
        r.segments=[{a:from,b:target}];
        for (const s of r.segments) {
            s.dx=s.b.x-s.a.x; s.dy=s.b.y-s.a.y; s.length=Math.max(1,Math.hypot(s.dx,s.dy));
            s.path=new Path2D(); s.path.moveTo(s.a.x,s.a.y); s.path.lineTo(s.b.x,s.b.y);
        }
        r.version=version;
    }
    function add(from,to,color,weight=1,node='',historic=false,count=1) {
        if (!Array.isArray(from)||!Array.isArray(to)||![...from,...to].every(Number.isFinite)) return false;
        if (!historic && packets.size>=capacity()) return false;
        const pool=historic?history:routes, key=keyFor(from,to,node), now=performance.now();
        let r=pool.get(key);
        if (!r) r={from,to,key,node,born:now,version:-1};
        if (!historic && now-r.updated>lifetime()) r.born=now;
        r.updated=now; r.hits=(r.hits||0)+count; r.color=color; r.weight=Math.min(2.2,Math.max(1,weight));
        pool.set(key,r);
        if(historic) historyDirty=true;
        else {
            const id=++serial;
            // Each received visit keeps its own lifetime, including identical IPs and
            // coordinates. Shared GPU draws combine their light, never their event records.
            const duration=420;
            r.active=(r.active||0)+1;r.activity=TrafficRuntime.activityHit(r.activity,count,now);
            packets.set(id,{r,born:now,duration,count,rgb:rgb(color)});if(packets.size===1&&!reducedMotion)frameMs=1000/60;admitted++; represented+=count;
            nodeActivity.set(node,TrafficRuntime.activityHit(nodeActivity.get(node),count,now));
            const sourceKey=from.join(','),previous=sources.get(sourceKey)||activeSources.get(sourceKey)||r.source;
            const activity=TrafficRuntime.activityHit(previous,count,now);activity.energy=Math.min(1000,activity.energy);
            r.source=previous||{pos:from,color,rgb:rgb(color),version:-1};r.source.hits=(previous&&now-previous.at<8000?r.source.hits||0:0)+count;Object.assign(r.source,activity);r.sourceKey=sourceKey;sources.set(sourceKey,r.source);
        }
        if(!historic)trafficMeter.add(count,now);
        revision++;wake(); return true;
    }
    function paintHistory() {
        if (!historyDirty || (paintedVersion===version && performance.now()-lastHistoryPaint<200)) return;
        historyCtx.clearRect(0,0,width,height);
        historyCtx.lineCap='butt';
        historyCtx.setLineDash([]);
        const nodes=new Set(), density=new Map(), cell=10;
        for(const r of history.values()){
            geometry(r);
            for(const s of r.segments){const key=r.node+':'+Math.floor(s.a.x/cell)+':'+Math.floor(s.a.y/cell);density.set(key,(density.get(key)||0)+1);}
        }
        renderedHistory=0;
        for (const r of Array.from(history.values()).reverse()) {
            geometry(r);
            historyCtx.strokeStyle='#8b929d';
            historyCtx.globalAlpha=history.size>700?0.2:0.3;
            historyCtx.lineWidth=.65;
            for (const s of r.segments) {
                const key=r.node+':'+Math.floor(s.a.x/cell)+':'+Math.floor(s.a.y/cell);
                historyCtx.globalAlpha=Math.min(0.7,(window.currentResBright??3.5)*0.086)/(1+((density.get(key)||1)-1)*0.8);
                historyCtx.stroke(s.path); nodes.add(r.node); renderedHistory++;
            }
        }
        lastHistoryNodes=Array.from(nodes); historyDirty=false; historyPaints++; lastHistoryPaint=performance.now(); paintedVersion=version;
    }
    function flash(s,color,brightness,weight,phase=0) {
        ctx.setLineDash([]);ctx.strokeStyle=color;ctx.globalAlpha=Math.min(1,brightness)*.06;ctx.lineWidth=.8;ctx.stroke(s.path);
        const dash=Math.max(1,window.currentDashLength??8),gap=Math.max(0,window.currentDashGap??6),lineWidth=Math.max(.9,weight*.7);
        ctx.setLineDash([dash,gap]);ctx.lineDashOffset=-phase;ctx.lineCap='round';
        ctx.globalAlpha=Math.min(1,brightness)*.14;ctx.lineWidth=lineWidth+3;ctx.stroke(s.path);
        ctx.globalAlpha=Math.min(1,brightness);ctx.lineWidth=lineWidth;ctx.stroke(s.path);
        ctx.setLineDash([]);ctx.lineDashOffset=0;
    }

    function draw(now) {
        raf=0;if(!visible()) return;
        if(now-lastFrame<frameMs-0.5){raf=requestAnimationFrame(draw);return;}
        lastFrame=now; const start=performance.now(), nodes=new Set();
        renderedRoutes=0;
        if(!occluded){rasterFrames++;ctx.clearRect(0,0,width,height);ctx.lineCap='round';ctx.globalAlpha=1;ctx.setLineDash([]);if(historyVisible)paintHistory();}
        const life=lifetime(),busy=packets.size>capacity()*0.65;
        // Native cooling stage slows and dims; historical routes remain still.
        ctx.setLineDash([]);
        for(const [key,r] of routes){
            if(now-r.updated>=life){routes.delete(key);continue;}
            if(occluded)continue;
            geometry(r);ctx.strokeStyle=r.color;
            const cooling=Math.max(0,1-(now-r.updated)/life);
            ctx.globalAlpha=Math.min(0.3,(window.currentResBright??3.5)*0.055)*cooling*cooling;ctx.lineWidth=Math.max(.2,window.currentResThick??.5)+cooling*.5;
            ctx.lineDashOffset=0;
            for(const s of r.segments)ctx.stroke(s.path);
        }
        ctx.setLineDash([]);ctx.lineDashOffset=0;
        gpu.begin();
        renderGroups.clear();activeSources.clear();
        let freed=0;
        for(const [id,p] of packets){
            if(!p.seen)p.born=now;
            const progress=(now-p.born)/p.duration;
            if(!p.seen){p.seen=true;drawnVisitors++;drawnByNode.set(p.r.node,(drawnByNode.get(p.r.node)||0)+1);}
            if(progress>=1){packets.delete(id);p.r.active--;completed++;freed++;continue;}
            const r=p.r;nodes.add(r.node);
            if(!activeSources.has(r.sourceKey))activeSources.set(r.sourceKey,sources.get(r.sourceKey)||r.source);
            let group=renderGroups.get(r.key);
            if(!group){group=r.flashGroup||(r.flashGroup={});group.p=p;group.alpha=0;group.count=0;renderGroups.set(r.key,group);}
            // Source-over composition is bounded and retains every event's independent age.
            // Exact same routes share a draw, avoiding thousands of identical GPU quads.
            group.alpha=1-(1-group.alpha)*(1-.85*flashEnvelope(now-p.born,p.duration));group.count++;
        }
        const bright=Math.min(1.5,(window.currentDynBright??4)/4);
        if(!occluded)for(const {p,alpha,count} of renderGroups.values()){
            const r=p.r;geometry(r);const energy=TrafficRuntime.activityLevel(TrafficRuntime.activityValue(r.activity,now));
            const intensity=alpha*(.55+energy*.45);
            p.phase=reducedMotion?0:(now-r.born)/1000*TrafficRuntime.flowSpeed(window.currentInitSpeed);
            for(const s of r.segments){
                renderedRoutes++;
                if(gpu.available)gpu.add(s,p,p.rgb,Math.max(.7,window.currentInitThick||1.5)*r.weight*(1+energy*.7),energy,intensity);
                else{
                    flash(s,r.color,bright*intensity,r.weight*Math.max(1,window.currentInitThick||1.5)*(1+energy*.7),p.phase);
                }
            }
        }
        for(const group of renderGroups.values())group.p=null;
        if(!occluded)gpu.draw(now,width,height,Math.min(1.5,(window.currentDynBright??4)/4));
        gpu.begin();let lightCount=0;if(!occluded)window.VisitorOcclusion?.refresh();
        // Every active access keeps its origin light; only quiet afterglows use the cache cap.
        function drawSource(source){
            const v=TrafficRuntime.activityVisual(source,now);
            if(v.energy<.03)return;
            lightCount++;
            if(occluded)return;
            if(source.version!==version){source.point=map.latLngToContainerPoint(source.pos);source.version=version;}
            const pos=source.point;v.occlusion=window.VisitorOcclusion?.opacity(pos,v.radius)??1;
            if(gpu.available)gpu.addLight(pos,source,source.rgb,v,now,reducedMotion);
            else{
                const radius=(window.currentVisitorDotSize??4)/2+Math.sqrt(v.level)*13;
                const glowRadius=Math.max(radius+8,(window.currentHaloSize??40)*(.6+Math.sqrt(v.level)*.7)+v.burst*12),glow=ctx.createRadialGradient(pos.x,pos.y,0,pos.x,pos.y,glowRadius);glow.addColorStop(0,source.color);glow.addColorStop(1,source.color+'00');ctx.fillStyle=glow;ctx.globalAlpha=(.4+v.level*.5+v.burst*.5)*(window.currentVisitorOpacity??1)*v.occlusion;ctx.beginPath();ctx.arc(pos.x,pos.y,glowRadius,0,Math.PI*2);ctx.fill();
                ctx.fillStyle=source.color;ctx.globalAlpha=Math.min(1,(.5+Math.sqrt(v.level)*.65+v.burst*.65)*Math.min(1,v.energy))*(window.currentVisitorOpacity??1)*v.occlusion;
                ctx.beginPath();ctx.arc(pos.x,pos.y,radius,0,Math.PI*2);ctx.fill();
                const phase=Math.min(1,(now-source.at)/1200);
                if(phase<1&&!reducedMotion){ctx.lineWidth=1.5;ctx.strokeStyle=source.color;ctx.globalAlpha=(1-phase)*(.65+v.level*.35)*(window.currentVisitorOpacity??1)*v.occlusion;ctx.beginPath();ctx.arc(pos.x,pos.y,radius+phase*(window.currentHaloSize??40)*.6,0,Math.PI*2);ctx.stroke();}
            }
        }
        for(const source of activeSources.values())drawSource(source);
        for(const [key,source] of sources){
            if(TrafficRuntime.activityValue(source,now)<.03){sources.delete(key);continue;}
            if(lightCount>=capacity())break;
            if(!activeSources.has(key))drawSource(source);
        }
        if(!occluded)gpu.draw(now,width,height,bright,1);
        if(freed)limits.onCapacity?.();
        // Small, fixed-cost updates per registered node, independent of visit count.
        if(now-lastActivityUpdate>=100){
            lastActivityUpdate=now;
            for(const [node,state] of nodeActivity){
                const {energy,level,burst}=TrafficRuntime.activityVisual(state,now);
                limits.onNodeActivity?.(node,energy<0.03?0:level,energy,reducedMotion?0:burst);
                if(energy<0.03)nodeActivity.delete(node);
            }
            if(!occluded)limits.onVisitorActivity?.(readSource);
        }
        for(const [key,p] of pings){
            const age=(now-p.born)/1000;if(age>=1){pings.delete(key);continue;}
            if(occluded)continue;
            const pos=map.latLngToContainerPoint(p.pos);
            ctx.globalAlpha=(1-age)*0.5*(window.currentVisitorOpacity??1);ctx.strokeStyle=p.color;ctx.lineWidth=1;
            ctx.beginPath();ctx.arc(pos.x,pos.y,2+age*14,0,Math.PI*2);ctx.stroke();
        }
        ctx.globalAlpha=1;lastNodes=Array.from(nodes);frameCount++;
        frameCost=performance.now()-start;
        if(frameCost>12)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);
        frameMs=reducedMotion?100:occluded?1000/30:slowFrames>8?1000/30:busy?1000/45:packets.size||routes.size||pings.size?1000/60:1000/20;
        if(packets.size||routes.size||pings.size||sources.size||nodeActivity.size||(!occluded&&historyVisible&&historyDirty))raf=requestAnimationFrame(draw);
    }
    function freeze(){if(frozenAt==null)frozenAt=performance.now();cancelAnimationFrame(raf);raf=0;}
    function thaw(){
        if(!visible())return;
        if(frozenAt!=null){
            const now=performance.now(),shift=at=>at+now-Math.max(frozenAt,at);
            for(const p of packets.values())p.born=shift(p.born);
            for(const r of routes.values()){r.updated=shift(r.updated);r.born=shift(r.born);if(r.activity)r.activity.at=shift(r.activity.at);}
            for(const a of nodeActivity.values())a.at=shift(a.at);
            const lights=new Set(sources.values());for(const p of packets.values())lights.add(p.r.source);
            for(const a of lights)if(a)a.at=shift(a.at);
            frozenAt=null;
        }
        reset();
    }
    function pause(){paused=true;canvas.style.visibility='hidden';historyCanvas.style.visibility='hidden';gpu.surface.style.visibility='hidden';freeze();}
    function resume(){paused=false;canvas.style.visibility='';historyCanvas.style.visibility='';gpu.surface.style.visibility='';thaw();}
    map.on('movestart zoomstart',pause);map.on('moveend zoomend resize',resume);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)freeze();else thaw();});
    reset();
    return {
        get revision(){return revision;},
        trafficMetrics:()=>trafficMeter.read(performance.now()),
        fireLine:(a,b,color,weight,node,count=1)=>add(a,b,color,weight,node,false,count),
        availableSlots:()=>Math.max(0,capacity()-packets.size),
        addHistory:(a,b,node,color='#7098bd')=>add(a,b,color,1,node,true),
        firePing(pos,color){if(reducedMotion)return;const key=pos.join(',');if(!pings.has(key))pings.set(key,{pos,color,born:performance.now()});wake();},
        clear(){routes.clear();pings.clear();sources.clear();activeSources.clear();limits.onVisitorActivity?.(()=>null);packets.clear();renderGroups.clear();for(const node of nodeActivity.keys())limits.onNodeActivity?.(node,0,0);nodeActivity.clear();trafficMeter.clear();revision++;drawnByNode.clear();admitted=0;completed=0;represented=0;drawnVisitors=0;lastNodes=[];wake();},
        clearHistory(){history.clear();revision++;historyDirty=true;paintedVersion=-1;wake();},
        setHistoryVisible(value){historyVisible=value;historyCanvas.style.display=value?'':'none';wake();},
        refreshStyle(){historyDirty=true;wake();},
        setOccluded(value){
            if(occluded===value)return;occluded=value;
            if(!value){invalidateGeometry();limits.onVisitorActivity?.(readSource);}wake();
        },
        wake,reset,invalidateGeometry,
        refreshVisitorActivity:()=>limits.onVisitorActivity?.(readSource),
        snapshotTraffic(limit=120){
            const now=performance.now(),groups=new Map();
            // Bounded route summary. Sampling happens only while the overview is visible.
            for(const r of history.values()){let g=groups.get(r.node);if(!g)groups.set(r.node,g=[]);g.push(r);}
            for(const g of groups.values())g.reverse();
            const result=[];let i=0,more=true;
            while(result.length<limit&&more){more=false;for(const g of groups.values()){if(g[i]){more=true;const h=g[i],r=routes.get(h.key);result.push({key:h.key,from:h.from,to:h.to,node:h.node,color:r?.color||h.color,energy:r?TrafficRuntime.activityValue(r.activity,now):0,hits:h.hits||1,age:r?now-r.updated:1e9});if(result.length>=limit)break;}}i++;}
            return result;
        },
        snapshotLights(limit=1200){
            const now=performance.now(),result=[],seen=new Set();
            const append=(source,key)=>{const energy=TrafficRuntime.activityValue(source,now);if(energy>.03){seen.add(key);result.push({pos:source.pos,color:source.color,energy,at:source.at,hits:source.hits||1});}};
            // Active access lights outlive eviction from the smaller quiet-afterglow cache.
            for(const [key,source] of activeSources){if(result.length>=limit)break;append(source,key);}
            for(const [key,source] of sources){if(result.length>=limit)break;if(!seen.has(key))append(source,key);}
            return result;
        },
        nodeVisual:node=>{const a=nodeActivity.get(node),now=performance.now();return {energy:TrafficRuntime.activityValue(a,now),at:a?.at??-10000};},
        inspectSource:pos=>{const state=sources.get(pos.join(','));return state?TrafficRuntime.activityVisual(state,performance.now()):null;},
        inspect:()=>({occluded,rasterFrames,sources:sources.size,activePackets:packets.size,admitted,completed,represented,drawnVisitors,drawnByNode:Object.fromEntries(drawnByNode),packetCapacity:capacity(),frameCost,activity:Object.fromEntries(Array.from(nodeActivity,([node,state])=>[node,TrafficRuntime.activityLevel(TrafficRuntime.activityValue(state,performance.now()))])),...gpu.inspect(),routes:routes.size,history:history.size,pings:pings.size,historyVisible,byNode:routes.counts(),historyByNode:history.counts(),drawnNodes:lastNodes,drawnHistoryNodes:historyVisible?lastHistoryNodes:[],fpsTarget:Math.round(1000/frameMs),frameCount,historyPaints,renderedRoutes,renderedHistory,canvasPixels:canvas.width*canvas.height}),
        inspectGeometry:node=>{const found=Array.from(routes.values()).find(r=>r.node===node);if(!found)return[];geometry(found);return found.segments.map(s=>({a:s.a,b:s.b}));}
    };
}
