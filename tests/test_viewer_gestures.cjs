const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
class Target extends EventEmitter {
  addEventListener(type, handler) { this.on(type, handler); }
  removeEventListener(type, handler) { this.off(type, handler); }
  fire(type, extra = {}) {
    const event = { pointerId:1, isPrimary:true, pointerType:'touch', clientX:200, clientY:200, button:0, cancelable:true, target:{closest:()=>null},
      prevented:false, stopped:false, preventDefault() { this.prevented=true; }, stopImmediatePropagation() { this.stopped=true; }, ...extra };
    this.emit(type,event); return event;
  }
}
global.window = new Target();
global.document = new Target();
const viewer = require('../outputs/media-site/public/viewer-gestures.js');
const { attachLivePhoto } = require('../outputs/media-site/public/live-photo.js');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const stage = new Target(); stage.clientWidth=390;
  const changes = []; let cancellations=0; let allowed=true;
  const controller = viewer.attachViewerGestures(stage,{navigate:d=>changes.push(d),cancelLive:()=>cancellations++,canStart:()=>allowed});
  let passed=0;
  stage.fire('pointerdown'); stage.fire('pointermove',{clientX:90}); window.fire('pointerup',{clientX:90});
  assert.deepEqual(changes,[1]); assert.equal(stage.fire('click').prevented,true); passed++;
  stage.fire('pointerdown'); stage.fire('pointermove',{clientX:300}); window.fire('pointerup',{clientX:300});
  assert.deepEqual(changes,[1,-1]); passed++;
  stage.fire('pointerdown'); window.fire('pointerup',{clientX:202,clientY:201});
  assert.equal(stage.fire('click').prevented,false); assert.equal(changes.length,2); passed++;
  stage.fire('pointerdown'); window.fire('pointerup',{clientX:210,clientY:330});
  assert.equal(changes.length,2); assert.equal(stage.fire('click').prevented,true); passed++;
  stage.fire('pointerdown'); window.fire('pointerup',{clientX:180});
  assert.equal(changes.length,2); assert.equal(stage.fire('click').prevented,true); passed++;
  stage.fire('pointerdown'); stage.fire('pointerdown',{pointerId:2,isPrimary:false});
  window.fire('pointerup',{clientX:30}); window.fire('pointerup',{pointerId:2});
  assert.equal(changes.length,2); assert.equal(stage.fire('click').prevented,true); passed++;
  stage.fire('pointerdown'); window.fire('pointercancel'); window.fire('pointerup',{clientX:20});
  assert.equal(changes.length,2); passed++;
  stage.fire('keydown',{key:'Enter'});
  assert.equal(stage.fire('click').prevented,false); passed++;
  allowed=false; stage.fire('pointerdown'); window.fire('pointerup',{clientX:20});
  assert.equal(changes.length,2); allowed=true; passed++;
  assert.equal(viewer.neighbor(0,-1,3),0); assert.equal(viewer.neighbor(2,1,3),2); assert.equal(viewer.neighbor(1,1,3),2); passed++;
  controller.reset(); assert.equal(stage.fire('click').prevented,false);
  controller.destroy(); assert.equal(window.listenerCount('pointerup'),0); passed++;
  const live = new Target(), video = new Target();
  const classes=new Set();live.classList={add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n))};
  live.getBoundingClientRect=()=>({left:0,right:390,top:0,bottom:844});
  video.readyState=4;video.currentTime=0;video.paused=true;
  video.play=()=>{video.paused=false;return Promise.resolve();};video.pause=()=>{video.paused=true;};
  const liveController=attachLivePhoto(live,video);
  const swipeController=viewer.attachViewerGestures(stage,{navigate:d=>changes.push(d),cancelLive:()=>liveController.stop()});
  live.fire('pointerdown');stage.fire('pointerdown');await delay(240);
  assert.equal(classes.has('is-playing'),true);
  live.fire('pointerup');window.fire('pointerup');
  assert.equal(liveController.consumeClick(),true);assert.equal(video.paused,true);assert.equal(video.currentTime,0);assert.equal(changes.length,2);passed++;
  live.fire('pointerdown');stage.fire('pointerdown');await delay(240);
  stage.fire('pointermove',{clientX:40});window.fire('pointerup',{clientX:40});
  assert.equal(video.paused,true);assert.equal(changes.at(-1),1);assert.equal(stage.fire('click').prevented,true);passed++;
  liveController.destroy();swipeController.destroy();
  assert.equal(window.listenerCount('blur'),0);passed++;
  const portrait={naturalWidth:600,naturalHeight:1200,getBoundingClientRect:()=>({left:0,top:0,width:1200,height:800})};
  assert.equal(viewer.containsMediaPoint(portrait,600,400),true);
  assert.equal(viewer.containsMediaPoint(portrait,200,400),false);
  assert.equal(viewer.containsMediaPoint(portrait,400,0),true);passed++;
  const landscape={naturalWidth:1600,naturalHeight:800,getBoundingClientRect:()=>({left:10,top:20,width:400,height:800})};
  assert.equal(viewer.containsMediaPoint(landscape,200,40),false);
  assert.equal(viewer.containsMediaPoint(landscape,200,420),true);passed++;
  assert.equal(viewer.containsMediaPoint({naturalWidth:0,naturalHeight:0},1,1),false);
  assert.equal(viewer.containsMediaPoint(null,1,1),false);passed++;
  const white=new Target();white.clientWidth=1200;let closes=0,consumed=false;
  const blankController=viewer.attachViewerGestures(white,{navigate:()=>{},consumeClick:()=>consumed,
    isBackdrop:event=>!viewer.containsMediaPoint(portrait,event.clientX,event.clientY),close:()=>closes++});
  assert.equal(white.fire('click',{clientX:600,clientY:400,detail:1}).prevented,false);
  assert.equal(closes,0);passed++;
  const outside=white.fire('click',{clientX:100,clientY:400,detail:1});
  assert.equal(outside.prevented,true);assert.equal(outside.stopped,true);assert.equal(closes,1);passed++;
  white.fire('pointerdown',{clientX:600,clientY:400});white.fire('pointermove',{clientX:200,clientY:400});
  window.fire('pointerup',{clientX:200,clientY:400});white.fire('click',{clientX:200,clientY:400,detail:1});
  assert.equal(closes,1);passed++;
  blankController.reset();consumed=true;
  assert.equal(white.fire('click',{clientX:200,detail:1}).prevented,true);assert.equal(closes,1);passed++;
  consumed=false;assert.equal(white.fire('click',{clientX:0,clientY:0,detail:0}).prevented,false);
  assert.equal(closes,1);blankController.destroy();passed++;
  let starts=0,allowLive=false;
  const guarded=attachLivePhoto(live,video,()=>{},{canStart:()=>allowLive,onStart:()=>starts++});
  live.fire('pointerdown');await delay(240);assert.equal(starts,0);assert.equal(video.paused,true);passed++;
  allowLive=true;live.fire('pointerdown');await delay(240);assert.equal(starts,1);
  assert.equal(classes.has('is-playing'),true);live.fire('pointerup');guarded.destroy();passed++;
  console.log(JSON.stringify({passed,checks:'left/right swipe, tap-to-open, vertical drag, short drag, pinch, cancel, keyboard after swipe, zoom gate, boundaries, cleanup, Live hold/release and swipe cancellation'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
