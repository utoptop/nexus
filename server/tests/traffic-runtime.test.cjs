const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timestamp, BoundedMap, EventQueue, HeatBuckets, FairNodeMap, linePoint, worldSegments, resolveNode, statKey, activityValue, activityHit, activityLevel } = require('../templates/assets/traffic-runtime.js');
test('SQL offsets, UTC and ISO timestamps represent the same instant', () => {
    assert.equal(timestamp('2026-11-14 08:00:00+08'), timestamp('2026-11-14T00:00:00Z'));
    assert.equal(timestamp('2026-11-14 00:00:00+00:00'), timestamp('2026-11-14 00:00:00'));
});
test('LRU touches prevent eviction and 100k updates remain bounded', () => {
    const cache = new BoundedMap(100);
    for (let i=0;i<100000;i++) { cache.set(String(i), i); cache.set('hot', i); }
    assert.equal(cache.size, 100); assert.equal(cache.get('hot'), 99999); assert.ok(cache.evicted > 99000);
});
test('each repeated visit remains an independent event with its original timestamp', () => {
    const queue = new EventQueue(1024, {storage:null});
    const event = {ip:'a', server_name:'node', target_domain:'site', time:'2026-11-14 00:00:00', count:1};
    for (let i=0;i<1000;i++) assert.equal(queue.push({...event}),true);
    assert.equal(queue.size,1000);
    for(let i=0;i<1000;i++)assert.equal(queue.shift().count,1);
    assert.equal(queue.dequeued,1000);assert.equal(queue.rejected,0);
});
test('unavailable overflow storage signals backpressure without evicting accepted events', () => {
    const queue = new EventQueue(128, {storage:null});
    for(let i=0;i<128;i++)assert.equal(queue.push({ip:String(i), count:2}),true);
    assert.equal(queue.push({ip:'overflow',count:2}),false);
    assert.equal(queue.size,128);assert.equal(queue.rejected,2);assert.ok(queue.error);
    assert.equal(queue.shift().ip,'0'); queue.clear(); assert.equal(queue.size,0);
});
test('recent traffic increases brightness monotonically and decays back to idle', () => {
    let activity=activityHit(null,1,1000);
    const first=activityLevel(activityValue(activity,1000));
    activity=activityHit(activity,1000,1000);
    assert.ok(activityLevel(activityValue(activity,1000))>first);
    assert.ok(Math.abs(activityValue(activity,2800)-500.5)<0.01);
    assert.ok(activityLevel(activityValue(activity,60000))<0.001);
    assert.equal(activityLevel(Infinity),1);
});
test('heat buckets merge rather than retain events, pruning oldest timestamp', () => {
    const heat = new HeatBuckets(60000,3), t = timestamp('2026-11-14 00:00:00');
    for(let i=0;i<100000;i++) heat.add(t,1);
    heat.add(t+60000,2); heat.add(t+120000,3); heat.add(t-60000,100);
    assert.equal(heat.bins.size,3); assert.equal(heat.bins.get(t),100000);
    assert.equal(heat.rows().reduce((n,r)=>n+r[1],0),100005);
});
test('straight tracks interpolate on the line with exact endpoints', () => {
    const a={x:0,y:0},b={x:100,y:20};
    assert.deepEqual(linePoint(a,b,0),a); assert.deepEqual(linePoint(a,b,1),b);
    assert.deepEqual(linePoint(a,b,0.5),{x:50,y:10});
});
test('hot nodes do not evict quieter nodes and draining is fair', () => {
    const queue=new EventQueue(128,{storage:null});
    queue.push({ip:'quiet',server_name:'quiet',time:'2026-11-14 00:00:00'});
    for(let i=0;i<10000;i++)queue.push({ip:String(i),server_name:'hot',time:'2026-11-14 00:00:00'});
    assert.equal(queue.size,128);
    assert.equal(queue.items.groups.get('quiet').size,1);
    const first=[queue.shift().server_name,queue.shift().server_name]; assert.ok(first.includes('quiet'));
    const tracks=new FairNodeMap(30);
    tracks.set('quiet',{node:'quiet'});
    for(let i=0;i<10000;i++)tracks.set('hot'+i,{node:'hot'});
    assert.equal(tracks.size,30);assert.equal(tracks.counts().quiet,1);
    tracks.clear();assert.equal(tracks.groups.size,0);
});
test('dateline tracks have visible segments at both world edges', () => {
    const parts=worldSegments({x:10,y:30},{x:1010,y:40},1024,1024);
    assert.equal(parts.length,2);
    assert.ok(parts.some(p=>p.b.x===1010)); assert.ok(parts.some(p=>p.a.x===10));
    for(const part of parts) assert.ok(Math.abs(part.a.x-part.b.x)<40);
});
test('node aliases resolve registered IPs and preserve unknown nodes', () => {
    const positions={'Direct Access':[0,0],Tokyo:[35,139]};
    assert.equal(resolveNode('192.0.2.1',positions,{'192.0.2.1':'Tokyo'}),'Tokyo');
    assert.equal(resolveNode('-',positions),'Direct Access');
    assert.equal(resolveNode('unknown',positions),'unknown');
});
test('stat keys do not collide on delimiters in domain/node names', () => {
    assert.notEqual(statKey(['a|b',0,0,0,0,0,0,'c','d']),statKey(['a',0,0,0,0,0,0,'b|c','d']));
});
test('node labels keep one footprint, never overlap or cover true node positions',()=>{
    const {layoutNodeLabels}=require('../templates/assets/traffic-runtime.js');
    for(const [width,height] of [[390,560],[806,400],[1440,700],[280,200]]){
        const nodes=Array.from({length:100},(_,i)=>({name:i===0?'Direct Access':'node '+i,x:width*.65+i%3,y:height*.5+i%2}));
        const result=layoutNodeLabels(nodes,{x:0,y:0,width,height}),visible=result.filter(n=>!n.overflow);
        assert.equal(result.length,nodes.length);assert.ok(visible.length>0);assert.ok(result.some(n=>n.overflow));
        for(const n of visible){
            assert.equal(n.width,138);assert.equal(n.height,46);
            assert.ok(n.labelX>=69 && n.labelX+69<=width+.01);assert.ok(n.labelY>=23&&n.labelY+23<=height+.01);
            for(const point of nodes)assert.ok(Math.abs(point.x-n.labelX)>=79 || Math.abs(point.y-n.labelY)>=33);
            for(const other of visible)if(n!==other)assert.ok(Math.abs(n.labelX-other.labelX)>=154-.01||Math.abs(n.labelY-other.labelY)>=62-.01);
        }
    }
});
test('a real access has one brief brightness envelope with no repetition',()=>{
    const {flashEnvelope}=require('../templates/assets/traffic-runtime.js');
    assert.equal(flashEnvelope(-1),0);assert.equal(flashEnvelope(0),1);
    let prev=1;for(let age=1;age<420;age++){const value=flashEnvelope(age);assert.ok(value<prev);prev=value;}
    for(const age of [420,421,840,5000])assert.equal(flashEnvelope(age),0);
});

test('native activity has an immediate burst, growing visitor radius and a quiet return',()=>{
 const {activityVisual}=require('../templates/assets/traffic-runtime.js');
 const quiet=activityVisual(null,0),one=activityVisual(activityHit(null,1,0),0),busy=activityVisual(activityHit(null,200,0),0);
 assert.equal(quiet.burst,0);assert.equal(one.burst,1);assert.equal(activityVisual(activityHit(null,1,1000),0).burst,1);assert.ok(busy.radius>one.radius);assert.ok(busy.glow>one.glow);
 const faded=activityVisual(activityHit(null,200,0),18000);assert.equal(faded.burst,0);assert.ok(faded.radius<busy.radius);assert.ok(faded.glow<busy.glow);
});

test('live rate buckets preserve weighted visits, expire idle traffic and reuse fixed storage',()=>{
 const {TrafficMeter}=require('../templates/assets/traffic-runtime.js'),meter=new TrafficMeter();
 meter.add(1,0);meter.add(250,1200);assert.equal(meter.read(1400).rate,50.2);
 assert.equal(meter.read(5000).recent,250);assert.equal(meter.read(6200).recent,0);
 const counts=meter.counts;for(let i=0;i<100000;i++)meter.add(1,65000);
 assert.equal(meter.read(65000).rate,20000);assert.equal(meter.counts,counts);assert.equal(counts.length,120);
 assert.equal(meter.read(125000).series.reduce((a,b)=>a+b,0),0);
 meter.clear();assert.equal(meter.read(125000).recent,0);
});

test('cover zoom fills both viewport axes, including ultrawide and rotated screens',()=>{
 const {coverZoom}=require('../templates/assets/traffic-runtime.js');
 for(const [w,h] of [[1440,900],[1920,1080],[3440,1440],[390,844],[844,390],[3840,2160],[280,1000]]){
  const z=coverZoom(w,h),world=256*2**z;
  assert.ok(world>=w+2&&world>=h+2);assert.equal(z*4,Math.round(z*4));
  assert.ok(256*2**(z-.25)<Math.max(w,h)+2);
 }
});
test('offshore placement stays local and keeps adjacent nodes aligned',()=>{
 const {layoutNodeLabels,labelLeader}=require('../templates/assets/traffic-runtime.js');
 const nodes=[{name:'A',x:600,y:320,side:-1},{name:'B',x:602,y:327,side:-1},{name:'C',x:608,y:342,side:-1}];
 const result=layoutNodeLabels(nodes,{x:0,y:0,width:1000,height:700},138,46,16,24,(x,y,w)=>x+w/2<590);
 assert.ok(result.every(n=>!n.overflow));assert.equal(new Set(result.map(n=>n.labelX)).size,1);
 for(const n of result){const leader=labelLeader(n);assert.ok(leader.length<=112);assert.deepEqual(leader.points[0],[n.x,n.y]);}
 // A remote ocean is not a valid excuse for dragging a label across the map.
 const inland=layoutNodeLabels([{name:'inland',x:600,y:320}],{x:0,y:0,width:1000,height:700},138,46,16,24,(x,y,w)=>x+w/2<120);
 assert.equal(inland[0].overflow,true);
});
test('offscreen nodes remain in disjoint viewport edge slots, retaining valid sea labels',()=>{
 const {pinNodeLabels}=require('../templates/assets/traffic-runtime.js');
 const sea={name:'sea',x:400,y:300,labelX:500,labelY:300,width:138,height:46,overflow:false};
 const points=[sea,...Array.from({length:6},(_,i)=>({name:'edge'+i,x:i%2?-1000:5000,y:100+i*10,overflow:true}))];
 const result=pinNodeLabels(points,{x:16,y:100,width:1408,height:786});
 assert.deepEqual(result[0],sea);assert.equal(result.filter(n=>n.overflow).length,0);
 for(const a of result){assert.ok(a.labelX-69>=16&&a.labelX+69<=1424&&a.labelY-23>=100&&a.labelY+23<=886);for(const b of result)if(a!==b)assert.ok(Math.abs(a.labelX-b.labelX)>=148||Math.abs(a.labelY-b.labelY)>=56);}
});
test('dense node rail has reserved space and no node is discarded',()=>{
 const {pinNodeLabels}=require('../templates/assets/traffic-runtime.js');
 const labels=pinNodeLabels(Array.from({length:120},(_,i)=>({name:String(i),x:9999,y:-999,overflow:true})),{x:16,y:158,width:358,height:582},118);
 assert.equal(labels.length,120);assert.ok(labels.some(n=>n.overflow));
 for(const n of labels.filter(n=>!n.overflow))assert.ok(n.labelX+59<=228||n.labelY+23<=530,'pinned label must not overlap the visible node rail');
});
test('zoom-out can show the complete world on wide, portrait and landscape screens',()=>{
 const {worldZoom,coverZoom}=require('../templates/assets/traffic-runtime.js');
 for(const [w,h] of [[1440,900],[3440,1440],[390,844],[844,390],[320,568]]){
  const z=worldZoom(w,h),world=256*2**z;
  assert.ok(world<=Math.min(w,h)-32);assert.ok(z<coverZoom(w,h));assert.equal(z*4,Math.floor(z*4));
 }
});

test('visitor collision mask fades only intersecting positions and resets without stale cells',()=>{
 const {RectMask}=require('../templates/assets/traffic-runtime.js');const mask=new RectMask();mask.reset([{x:100,y:100,w:138,h:46},{x:-20,y:-20,w:30,h:30}]);assert.equal(mask.opacity(110,110,8),.12);assert.equal(mask.opacity(246,120,10),.12);assert.equal(mask.opacity(260,120,10),1);assert.equal(mask.opacity(0,0),.12);mask.reset([]);assert.equal(mask.opacity(110,110,8),1);assert.equal(mask.grid.size,0);
});
