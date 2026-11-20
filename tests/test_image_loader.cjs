const assert = require('node:assert/strict');
const { SerialImageLoader } = require('../outputs/media-site/public/image-loader.js');
class Image {
  constructor(auto=true){this.auto=auto;this.dataset={};this.listeners=new Map();}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  fire(type){for(const fn of [...(this.listeners.get(type)||[])])fn();}
  set src(value){this.value=value;if(this.auto)queueMicrotask(()=>this.fire('load'));}
  get src(){return this.value;}
  removeAttribute(){this.value=undefined;}
}
let observer;
class Observer {
  constructor(callback){this.callback=callback;observer=this;}
  observe(){} unobserve(){}
  visible(image,yes=true){this.callback([{target:image,isIntersecting:yes}]);}
}
const ticks=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
(async()=>{
  const requests=[];let active=0,peak=0,completed=0;
  const fetch=(url,{signal})=>new Promise((resolve,reject)=>{
    const item={url,signal,done:false};
    active++;peak=Math.max(peak,active);requests.push(item);
    item.resolve=(ok=true)=>{
      if(item.done)return;item.done=true;active--;
      resolve({ok,blob:async()=>({})});
    };
    signal.addEventListener('abort',()=>{
      if(item.done)return;item.done=true;active--;
      reject(new DOMException('Aborted','AbortError'));
    },{once:true});
  });
  let objectCount=0;const revoked=[];
  const loader=new SerialImageLoader({fetch,Observer,urls:{createObjectURL:()=>`blob:${++objectCount}`,revokeObjectURL:u=>revoked.push(u)}});
  const first=new Image(false),second=new Image(),hidden=new Image();
  loader.add(first,'first',{onLoad:()=>completed++});loader.add(second,'second');loader.add(hidden,'hidden');
  observer.visible(first);observer.visible(second);await ticks();
  assert.deepEqual(requests.map(r=>r.url),['first']);
  requests[0].resolve();await ticks();assert.equal(requests.length,1);
  first.fire('load');await ticks();
  assert.equal(completed,1);assert.equal(requests[1].url,'second');
  requests[1].resolve();await ticks();assert.equal(requests[2].url,'hidden');
  requests[2].resolve();await ticks();assert.equal(hidden.dataset.loadState,'loaded');
  const pending=new Image();loader.add(pending,'pending');observer.visible(pending);await ticks();
  const preview=new Image();loader.pauseGallery(true);loader.add(preview,'preview',{group:'preview'});await ticks();
  assert.equal(requests[3].signal.aborted,true);assert.equal(requests[4].url,'preview');
  loader.clear('preview');const nextPreview=new Image();loader.add(nextPreview,'next-preview',{group:'preview'});await ticks();
  assert.equal(requests[4].signal.aborted,true);assert.equal(requests[5].url,'next-preview');
  requests[5].resolve();await ticks();loader.clear('preview');loader.pauseGallery(false);await ticks();
  assert.equal(requests[6].url,'pending');
  observer.visible(pending,false);await ticks();assert.equal(requests[6].signal.aborted,false);
  assert.equal(requests.length,7);
  requests[6].resolve(false);await ticks();assert.equal(pending.dataset.loadState,'error');
  const afterError=new Image();loader.add(afterError,'after-error');observer.visible(afterError);await ticks();
  assert.equal(requests[7].url,'after-error');requests[7].resolve();await ticks();
  loader.suspend('live');const held=new Image();loader.add(held,'held');observer.visible(held);await ticks();
  assert.equal(requests.length,8);loader.resume('live');await ticks();
  assert.equal(requests[8].url,'held');requests[8].resolve();await ticks();
  assert.equal(peak,1);
  const placeholder=new Image();
  const releasePlaceholder=loader.useLoaded(placeholder,'first');
  assert.equal(typeof releasePlaceholder,'function');assert.equal(requests.length,9);await ticks();
  assert(placeholder.src?.startsWith('blob:'));
  const ownedPlaceholder=placeholder.src;
  loader.clear('gallery');assert.equal(loader.jobs.size,0);assert(revoked.length>=4);
  assert.equal(revoked.includes(ownedPlaceholder),false);
  releasePlaceholder();releasePlaceholder();assert.equal(revoked.filter(url=>url===ownedPlaceholder).length,1);
  assert.equal(loader.useLoaded(new Image(),'absent'),null);
  let passed=15;
  const create=options=>{
    const pending=[];let live=0,highest=0;
    const instance=new SerialImageLoader({Observer,idleDelay:1,urls:{createObjectURL:()=>`blob:${++objectCount}`,revokeObjectURL:u=>revoked.push(u)},
      fetch:(url,{signal})=>new Promise((resolve,reject)=>{
        live++;highest=Math.max(highest,live);
        const request={url,signal,done:false,resolve:(size=4)=>{
          if(request.done)return;request.done=true;live--;resolve({ok:true,blob:async()=>({size})});
        }};
        signal.addEventListener('abort',()=>{
          if(request.done)return;request.done=true;live--;reject(new DOMException('Aborted','AbortError'));
        },{once:true});pending.push(request);
      }),...options});
    return {loader:instance,observer,pending,peak:()=>highest};
  };
  const idle=async()=>{await new Promise(r=>setTimeout(r,12));await ticks();};
  const queue=create(),a=new Image(),b=new Image();
  queue.loader.add(a,'thumb-a',{detailUrl:'detail-a'});queue.loader.add(b,'thumb-b',{detailUrl:'detail-b'});
  queue.observer.visible(a);queue.observer.visible(b);await ticks();
  queue.pending[0].resolve();await ticks();
  assert.equal(queue.pending[1].url,'thumb-b');assert.equal(queue.pending.length,2);passed++;
  queue.pending[1].resolve();await idle();
  assert.equal(queue.pending[2].url,'detail-a');passed++;
  queue.loader.pauseGallery(true);const selected=new Image();
  queue.loader.add(selected,'detail-a',{group:'preview'});await ticks();
  assert.equal(queue.pending.length,3);assert.equal(queue.pending[2].signal.aborted,false);passed++;
  queue.pending[2].resolve();await ticks();
  assert.equal(selected.dataset.loadState,'loaded');assert.equal(queue.pending.length,3);passed++;
  queue.loader.clear('preview');queue.loader.pauseGallery(false);await idle();
  assert.equal(queue.pending[3].url,'detail-b');
  const c=new Image();queue.loader.add(c,'thumb-c',{detailUrl:'detail-c'});queue.observer.visible(c);await ticks();
  assert.equal(queue.pending[3].signal.aborted,true);assert.equal(queue.pending[4].url,'thumb-c');passed++;
  queue.pending[4].resolve();await idle();assert.equal(queue.pending[5].url,'detail-b');
  queue.loader.pauseGallery(true);const other=new Image();
  queue.loader.add(other,'detail-c',{group:'preview'});await ticks();
  assert.equal(queue.pending[5].signal.aborted,true);assert.equal(queue.pending[6].url,'detail-c');passed++;
  queue.pending[6].resolve();await ticks();assert.equal(other.dataset.loadState,'loaded');
  queue.loader.suspend('video');await idle();assert.equal(queue.pending.length,7);passed++;
  queue.loader.resume('video');await idle();assert.equal(queue.pending[7].url,'detail-b');
  queue.pending[7].resolve();await idle();
  assert.equal(queue.pending.length,8);assert.equal(queue.peak(),1);passed++;
  queue.loader.clear('preview');queue.loader.clear('gallery');await ticks();
  const reused=new Image();queue.loader.add(reused,'detail-b',{group:'preview'});await ticks();
  assert.equal(reused.dataset.loadState,'loaded');assert.equal(queue.pending.length,8);passed++;
  queue.loader.clear('preview');
  const bounded=create({maxCacheEntries:1,maxCacheBytes:6});
  const loadPreview=async(url,size)=>{
    const image=new Image();bounded.loader.add(image,url,{group:'preview'});await ticks();
    bounded.pending.at(-1).resolve(size);await ticks();bounded.loader.clear('preview');
  };
  await loadPreview('first-detail',4);await loadPreview('second-detail',4);
  assert.equal(bounded.loader.cacheBytes,4);assert.equal(bounded.loader.cache.size,1);
  assert.equal(bounded.loader.cache.has('first-detail'),false);passed++;
  await loadPreview('oversized',8);
  assert.equal(bounded.loader.cacheBytes,4);assert.equal(bounded.loader.cache.has('oversized'),false);passed++;
  const evicted=create({maxCacheEntries:1});
  const e=new Image(),f=new Image();
  evicted.loader.add(e,'e',{detailUrl:'original-e'});evicted.loader.add(f,'f',{detailUrl:'original-f'});
  evicted.observer.visible(e);evicted.observer.visible(f);await ticks();evicted.pending[0].resolve();await ticks();
  evicted.pending[1].resolve();await idle();evicted.pending[2].resolve();await idle();
  evicted.pending[3].resolve();await idle();evicted.loader.pump();await idle();
  assert.equal(evicted.pending.length,4);assert.equal(evicted.loader.cache.size,1);passed++;
  evicted.loader.clear('gallery');
  assert.equal(evicted.loader.prefetches.size,0);passed++;
  console.log(JSON.stringify({passed,peakImageRequests:Math.max(peak,queue.peak()),checks:'all offscreen thumbnails, visible priority, strict single fetch, decoded thumbnail reuse without network, independent placeholder lifetime, idle detail prefetch, preview preemption, video/Live pause, bounded cache, cleanup'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
