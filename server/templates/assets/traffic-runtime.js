/* Shared bounded data structures. No DOM dependencies; exercised by node:test. */
(function (root) {
    'use strict';
    const timestamp = value => {
        let s = String(value).replace(' ', 'T');
        if (/[+-]\d\d$/.test(s)) s += ':00';
        return Date.parse(/[zZ]$|[+-]\d\d(?::?\d\d)?$/.test(s) ? s : s + 'Z') || 0;
    };
    const statKey = row => JSON.stringify([row[0], row[7], row[8]]);
    class BoundedMap extends Map {
        constructor(limit) { super(); this.limit = limit; this.evicted = 0; }
        set(key, value) {
            this.delete(key);
            super.set(key, value);
            if (this.size > this.limit) { this.delete(this.keys().next().value); this.evicted++; }
            return this;
        }
    }
    class HeatBuckets {
        constructor(step = 60000, limit = 1440) { this.step = step; this.limit = limit; this.bins = new Map(); }
        add(time, count) {
            const ts = typeof time === 'number' ? time : timestamp(time);
            if (!ts || !Number.isFinite(count)) return;
            const key = Math.floor(ts / this.step) * this.step;
            this.bins.set(key, (this.bins.get(key) || 0) + count);
            if (this.bins.size > this.limit) this.bins.delete(Math.min(...this.bins.keys()));
        }
        rows() { return Array.from(this.bins, ([ts, count]) => [new Date(ts).toISOString(), count, ts]); }
    }
    // Fair eviction: a noisy node cannot remove the last routes of quieter nodes.
    class FairNodeMap extends Map {
        constructor(limit, nodeOf = value => value.node, onEvict = () => {}) {
            super(); this.limit = limit; this.nodeOf = nodeOf; this.onEvict = onEvict; this.groups = new Map();
        }
        set(key, value) {
            this.delete(key);
            const node = this.nodeOf(value) || 'Direct Access';
            if (!this.groups.has(node)) this.groups.set(node, new Set());
            this.groups.get(node).add(key); super.set(key, value);
            if (this.size > this.limit) {
                let largest;
                for (const keys of this.groups.values()) if (!largest || keys.size > largest.size) largest = keys;
                const oldest = largest.values().next().value, removed = this.get(oldest);
                this.delete(oldest); this.onEvict(removed);
            }
            return this;
        }
        delete(key) {
            const value = this.get(key); if (!value) return false;
            const node = this.nodeOf(value) || 'Direct Access', keys = this.groups.get(node);
            keys.delete(key); if (!keys.size) this.groups.delete(node);
            return super.delete(key);
        }
        clear() { super.clear(); this.groups.clear(); }
        counts() { return Object.fromEntries(Array.from(this.groups, ([node, keys]) => [node, keys.size])); }
    }
    // A bounded working set with an on-disk overflow inbox. No eviction/coalescing of
    // visitor events. Storage failures are explicit; finite clients cannot buffer forever.
    class EventQueue {
        constructor(limit, options = {}) {
            this.limit = Math.max(128, limit); this.items = new FairNodeMap(this.limit, e => e.server_name);
            this.nextNode = 0; this.sequence = 0; this.epoch = 0; this.disk = 0; this.spill = [];
            this.received = 0; this.dequeued = 0; this.rejected = 0; this.error = ''; this.reading = false;
            this.onReady = options.onReady || (() => {}); this.maxPending = options.maxPending || 1000000;
            this.storage = options.storage === undefined ? root.indexedDB : options.storage;
            if (this.storage) {
                this.dbName = 'iplogger-inbox-' + Date.now() + '-' + Math.random().toString(36).slice(2);
                const request = this.storage.open(this.dbName, 1);
                request.onupgradeneeded = () => request.result.createObjectStore('events', {autoIncrement:true});
                request.onsuccess = () => { this.db = request.result; this.flush(); this.refill(); };
                request.onerror = () => this.fail('浏览器暂存不可用 / Browser spool unavailable');
                root.addEventListener?.('pagehide', event => { if(!event.persisted){ this.db?.close(); this.storage.deleteDatabase(this.dbName); } });
                // Remove abandoned scratch databases after crashes; no persistent visitor archive.
                this.storage.databases?.().then(dbs => dbs.forEach(db => {
                    const match = /^iplogger-inbox-(\d+)-/.exec(db.name || '');
                    if (match && Date.now() - Number(match[1]) > 86400000) this.storage.deleteDatabase(db.name);
                })).catch(() => {});
            }
        }
        fail(message) { this.error = message; this.onReady(); }
        push(event) {
            const count = Math.max(1, Number(event.count) || 1);
            if (this.error || this.size >= this.maxPending || (!this.storage && this.items.size >= this.limit)) {
                this.rejected += count; this.fail(this.error || '暂存已满，实时流存在缺口 / Inbox full; live stream has a gap'); return false;
            }
            this.received += count;
            if (!this.disk && !this.spill.length && this.items.size < this.limit) this.items.set(++this.sequence, event);
            else {
                this.spill.push(event);
                if (this.spill.length >= 128 && this.db) this.flush();
                else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = 0; this.flush(); }, 0);
            }
            return true;
        }
        flush() {
            if (!this.db || !this.spill.length || this.error) return;
            const epoch = this.epoch, batch = this.spill; this.spill = []; this.disk += batch.length;
            let tx;
            try {
                tx = this.db.transaction('events', 'readwrite');
                const store = tx.objectStore('events');
                for (let i=0; i<batch.length; i+=128) store.add(batch.slice(i, i+128));
            } catch { this.fail('浏览器暂存不可写，实时流存在缺口 / Spool unavailable; live stream has a gap'); return; }
            tx.oncomplete = () => { if (epoch === this.epoch) { this.refill(); this.onReady(); } };
            tx.onabort = () => { if (epoch === this.epoch) this.fail('浏览器暂存写入失败，实时流存在缺口 / Spool write failed; live stream has a gap'); };
        }
        refill() {
            if (!this.db || this.reading || !this.disk || this.items.size > this.limit - 128 || this.error) return;
            this.reading = true; const epoch = this.epoch;
            let tx;
            try { tx = this.db.transaction('events', 'readwrite'); }
            catch { this.reading=false; this.fail('浏览器暂存不可读 / Spool unavailable'); return; }
            const store = tx.objectStore('events'), request = store.openCursor(); let batch;
            request.onsuccess = () => { const cursor = request.result; if (cursor) { batch = cursor.value; cursor.delete(); } };
            tx.oncomplete = () => {
                this.reading = false; if (epoch !== this.epoch) { this.refill(); return; }
                if (batch) {
                    this.disk -= batch.length;
                    for (const event of batch) this.items.set(++this.sequence, event);
                    this.onReady(); this.refill();
                }
            };
            tx.onabort = () => { this.reading = false; if (epoch === this.epoch) this.fail('浏览器暂存读取失败 / Spool read failed'); };
        }
        shift() {
            if (!this.items.size) { this.flush(); this.refill(); return; }
            const groups = Array.from(this.items.groups.values());
            const key = groups[this.nextNode++ % groups.length].values().next().value;
            const value = this.items.get(key); this.items.delete(key); this.dequeued += Math.max(1, Number(value.count) || 1);
            this.refill(); return value;
        }
        clear() {
            this.epoch++; this.items.clear(); this.spill = []; this.disk = 0; this.nextNode = 0;
            this.received = 0; this.dequeued = 0; this.rejected = 0; this.error = '';
            clearTimeout(this.flushTimer); this.flushTimer = 0;
            if (this.db) try { this.db.transaction('events', 'readwrite').objectStore('events').clear(); } catch { this.fail('浏览器暂存不可用 / Spool unavailable'); }
        }
        get readySize() { return this.items.size; }
        get size() { return this.items.size + this.disk + this.spill.length; }
    }
    // An exponentially decaying activity level with a logarithmic visual response.
    // Recent visits, not all-time totals, determine brightness; quiet nodes remain visible.
    function activityValue(state, now, halfLife = 1800) {
        return state ? state.energy * Math.pow(0.5, Math.max(0, now - state.at) / halfLife) : 0;
    }
    function activityHit(state, count, now) {
        return { energy: Math.min(1000000, activityValue(state, now) + Math.max(1, count)), at:now };
    }
    function activityLevel(energy) { return Math.min(1, Math.log1p(Math.max(0, energy)) / Math.log(1001)); }
    function flowSpeed(speed=.1) { return 108*Math.sqrt(.1/Math.max(.025,Number(speed)||.1)); }
    // Fixed memory, half-second buckets. Rendering frequency never changes the counts.
    class TrafficMeter {
        constructor(){this.counts=new Float64Array(120);this.times=new Float64Array(120);this.times.fill(-Infinity);}
        add(count,now){const tick=Math.floor(now/500),i=tick%120;if(this.times[i]!==tick){this.times[i]=tick;this.counts[i]=0;}this.counts[i]+=count;}
        read(now){const tick=Math.floor(now/500),series=new Array(120);let recent=0;for(let age=119;age>=0;age--){const t=tick-age,i=((t%120)+120)%120,n=this.times[i]===t?this.counts[i]:0;series[119-age]=n*2;if(age<10)recent+=n;}return {rate:recent/5,recent,series};}
        clear(){this.counts.fill(0);this.times.fill(-Infinity);}
    }
    function linePoint(a, b, t) { return { x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t }; }
    function resolveNode(name, positions, aliases = {}) {
        const raw = String(name || 'Direct Access').trim();
        if (raw === '-') return 'Direct Access';
        const alias = aliases[raw];
        if (alias && Object.hasOwn(positions, alias)) return alias;
        return raw;
    }
    function worldSegments(a, b, worldWidth, viewportWidth) {
        // Preserve the shortest straight path and draw every visible world copy.
        const end = {x:b.x + Math.round((a.x-b.x)/worldWidth)*worldWidth,y:b.y};
        const min = Math.min(a.x,end.x), max = Math.max(a.x,end.x), result = [];
        const first = Math.ceil((-24-max)/worldWidth), last = Math.floor((viewportWidth+24-min)/worldWidth);
        for (let copy=first; copy<=last; copy++) result.push({a:{x:a.x+copy*worldWidth,y:a.y},b:{x:end.x+copy*worldWidth,y:end.y}});
        return result;
    }
    // The map has one world. Its minimum zoom must cover both viewport axes.
    function coverZoom(width,height,floor=0) {
        return Math.max(floor,Math.ceil(Math.log2((Math.max(1,width,height)+2)/256)*4)/4);
    }
    // Zoom-out fits a single complete world; opening view can still fill the screen.
    function worldZoom(width,height) {
        // MarkerCluster traverses integer zoom levels; fractional minima skip unclustered markers.
        return Math.max(0,Math.floor(Math.log2(Math.max(256,Math.min(width,height)-32)/256)));
    }
    function labelLeader(n) {
        const l=n.labelX-n.width/2-5,r=n.labelX+n.width/2+5;
        const t=n.labelY-n.height/2-5,b=n.labelY+n.height/2+5,candidates=[];
        if(n.x<=l)candidates.push({x:l,y:n.labelY,axis:'x'});
        if(n.x>=r)candidates.push({x:r,y:n.labelY,axis:'x'});
        if(n.y<=t)candidates.push({x:n.labelX,y:t,axis:'y'});
        if(n.y>=b)candidates.push({x:n.labelX,y:b,axis:'y'});
        let end=null,length=Infinity;
        for(const c of candidates){const d=Math.abs(c.x-n.x)+Math.abs(c.y-n.y);if(d<length){end=c;length=d;}}
        if(!end)return {length,points:[]};
        const points=end.axis==='x'
            ?[[n.x,n.y],[(n.x+end.x)/2,n.y],[(n.x+end.x)/2,end.y],[end.x,end.y]]
            :[[n.x,n.y],[n.x,(n.y+end.y)/2],[end.x,(n.y+end.y)/2],[end.x,end.y]];
        return {length,points};
    }
    // Local search only: nearby nodes share a column, but never gain a long leader
    // just to fill a larger group. Dense extras remain available in the node list.
    function layoutNodeLabels(nodes,bounds,boxWidth=138,boxHeight=46,gap=16,maxLabels=24,isSeaBox=()=>true,maxLeader=112) {
        const result=[],placed=[],groups=[];
        const left=bounds.x+boxWidth/2,right=bounds.x+bounds.width-boxWidth/2;
        const top=bounds.y+boxHeight/2,bottom=bounds.y+bounds.height-boxHeight/2;
        const order=(a,b)=>a.y-b.y||(a.name==='Direct Access'?-1:b.name==='Direct Access'?1:a.name.localeCompare(b.name));
        const seaCache=new Map();
        const valid=(x,y)=>{
            if(x<left||x>right||y<top||y>bottom)return false;
            const key=x+','+y;
            if(!seaCache.has(key))seaCache.set(key,isSeaBox(x,y,boxWidth,boxHeight));
            return seaCache.get(key)
                &&!nodes.some(n=>Math.abs(x-n.x)<boxWidth/2+10&&Math.abs(y-n.y)<boxHeight/2+10)
                &&!placed.some(p=>Math.abs(x-p.x)<boxWidth+gap-.1&&Math.abs(y-p.y)<boxHeight+gap-.1);
        };
        for(const n of nodes.slice().sort(order)){
            if(n.x<0||n.x>bounds.x+bounds.width+20||n.y<0||n.y>bounds.y+bounds.height+80){result.push({...n,overflow:true});continue;}
            const group=groups.find(g=>g.side===(n.side||1)&&Math.hypot(g.x-n.x,g.y-n.y)<boxWidth+gap);
            if(group)group.nodes.push(n);else groups.push({x:n.x,y:n.y,side:n.side||1,nodes:[n]});
        }
        const pitch=boxHeight+gap;
        for(const g of groups){
            let offset=0;
            while(offset<g.nodes.length){
                const maxCount=Math.min(g.nodes.length-offset,maxLabels-placed.length,Math.floor(2*maxLeader/pitch)+1);
                let best=null;
                for(let count=maxCount;count>0&&!best;count--){
                    const batch=g.nodes.slice(offset,offset+count),cx=batch.reduce((v,n)=>v+n.x,0)/count,cy=batch.reduce((v,n)=>v+n.y,0)/count;
                    const minX=Math.max(left,cx-boxWidth/2-maxLeader),maxX=Math.min(right,cx+boxWidth/2+maxLeader);
                    const minY=Math.max(top,cy-maxLeader-(count-1)*pitch/2),maxY=Math.min(bottom-(count-1)*pitch,cy+maxLeader-(count-1)*pitch/2);
                    let score=Infinity;
                    const xs=[Math.max(left,Math.min(right,cx-g.side*(boxWidth/2+14))),Math.max(left,Math.min(right,cx+g.side*(boxWidth/2+14)))];
                    for(let x=Math.ceil(minX/8)*8;x<=maxX;x+=8)xs.push(x);
                    const ys=[Math.max(minY,Math.min(maxY,cy-(count-1)*pitch/2))];
                    for(let y=Math.ceil(minY/8)*8;y<=maxY;y+=8)ys.push(y);
                    for(const x of xs)for(const y of ys){
                        let cost=0,ok=true;
                        for(let i=0;i<count;i++){
                            const n=batch[i],ly=y+i*pitch;
                            const leader=labelLeader({...n,labelX:x,labelY:ly,width:boxWidth,height:boxHeight});
                            // Distance is measured to the label edge along the actual elbow.
                            // Coast direction is only a tie breaker, never a screen-wide penalty.
                            cost+=leader.length**2+((x-n.x)*g.side<0?144:0);
                            if(leader.length>maxLeader||cost>=score||!valid(x,ly)){ok=false;break;}
                        }
                        if(ok){score=cost;best={x,y,batch};}
                    }
                }
                if(!best){for(const n of g.nodes.slice(offset))result.push({...n,overflow:true});break;}
                best.batch.forEach((n,i)=>{const y=best.y+i*pitch;placed.push({x:best.x,y});result.push({...n,labelX:best.x,labelY:y,width:boxWidth,height:boxHeight,side:Math.sign(best.x-n.x)||g.side,overflow:false});});
                offset+=best.batch.length;
            }
        }
        return result;
    }
    // Preserve nearby sea placement; pin the remaining labels to visible edge slots.
    // Excess labels live in an always-open, scrollable rail instead of disappearing.
    function pinNodeLabels(labels,bounds,boxWidth=138,boxHeight=46,gap=10) {
        const left=bounds.x+boxWidth/2,right=Math.max(left,bounds.x+bounds.width-boxWidth/2);
        const top=bounds.y+boxHeight/2,bottom=Math.max(top,bounds.y+bounds.height-boxHeight/2);
        function place(reserveRail){
            const rail={left:right-boxWidth/2-28,top:bottom+boxHeight/2-210};
            const intersectsRail=(x,y)=>reserveRail&&x+boxWidth/2>rail.left&&y+boxHeight/2>rail.top;
            const result=labels.map(n=>({...n,overflow:n.overflow||intersectsRail(n.labelX,n.labelY)})),placed=result.filter(n=>!n.overflow);
            for(const n of result.filter(n=>n.overflow)){
                let best=null,score=Infinity;
                const candidates=[];
                for(let y=top;y<=bottom;y+=boxHeight+gap){candidates.push([left,y],[right,y]);}
                for(let x=left;x<=right;x+=boxWidth+gap){candidates.push([x,top],[x,bottom]);}
                const tx=Math.max(left,Math.min(right,n.x)),ty=Math.max(top,Math.min(bottom,n.y));
                for(const [x,y] of candidates){
                    if(intersectsRail(x,y)||placed.some(p=>Math.abs(x-p.labelX)<boxWidth+gap-.1&&Math.abs(y-p.labelY)<boxHeight+gap-.1))continue;
                    const d=(x-tx)**2+(y-ty)**2;
                    if(d<score){score=d;best={x,y};}
                }
                if(best){Object.assign(n,{overflow:false,pinned:true,labelX:best.x,labelY:best.y,width:boxWidth,height:boxHeight});placed.push(n);}
            }
            return result;
        }
        const result=place(false);
        return result.some(n=>n.overflow)?place(true):result;
    }

    // Spatial hashing keeps overlap checks independent of the number of visitors.
    class RectMask {
        constructor(cell=128){this.cell=cell;this.grid=new Map();this.rects=[];}
        reset(rects){this.grid.clear();this.rects=rects;const c=this.cell;for(const r of rects){for(let x=Math.floor(r.x/c);x<=Math.floor((r.x+r.w)/c);x++)for(let y=Math.floor(r.y/c);y<=Math.floor((r.y+r.h)/c);y++){const key=x+','+y,list=this.grid.get(key);if(list)list.push(r);else this.grid.set(key,[r]);}}}
        overlaps(x,y,radius=0){const c=this.cell;for(let a=Math.floor((x-radius)/c);a<=Math.floor((x+radius)/c);a++)for(let b=Math.floor((y-radius)/c);b<=Math.floor((y+radius)/c);b++)for(const r of this.grid.get(a+','+b)||[]){const dx=x-Math.max(r.x,Math.min(r.x+r.w,x)),dy=y-Math.max(r.y,Math.min(r.y+r.h,y));if(dx*dx+dy*dy<=radius*radius)return true;}return false;}
        opacity(x,y,radius=0){return this.overlaps(x,y,radius)?.12:1;}
    }
    function activityVisual(state,now) {
        const energy=activityValue(state,now),level=activityLevel(energy);
        const burst=state?Math.pow(Math.max(0,1-Math.max(0,now-state.at)/650),2):0;
        return {energy,level,burst,radius:3+Math.sqrt(level)*16,glow:4+Math.sqrt(level)*28+burst*16};
    }
    function flashEnvelope(age, duration = 420) {
        if(age<0 || age>=duration)return 0;
        return Math.pow(1-age/duration,1.5);
    }
    function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
    const api = { RectMask, timestamp, statKey, BoundedMap, HeatBuckets, EventQueue, FairNodeMap, TrafficMeter, linePoint, worldSegments, resolveNode, hash, activityValue, activityHit, activityLevel, flowSpeed, layoutNodeLabels, pinNodeLabels, labelLeader, coverZoom, worldZoom, flashEnvelope, activityVisual };
    if (typeof module !== 'undefined') module.exports = api;
    root.TrafficRuntime = api;
})(globalThis);
