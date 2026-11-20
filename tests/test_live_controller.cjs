'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
class Target extends EventEmitter {
  addEventListener(type, handler) { this.on(type, handler); }
  removeEventListener(type, handler) { this.off(type, handler); }
  fire(type, event = {}) { this.emit(type, { preventDefault() {}, ...event }); }
}
global.window = new Target();
global.document = new Target();
const { attachLivePhoto } = require('../outputs/media-site/public/live-photo.js');
function fixture() {
  const surface = new Target(), video = new Target(), classes = new Set();
  surface.classList = { add(...names) { names.forEach(n => classes.add(n)); }, remove(...names) { names.forEach(n => classes.delete(n)); }, contains(name) { return classes.has(name); } };
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200 });
  video.currentTime = 7; video.readyState = 4; video.paused = true; video.plays = 0;
  video.play = () => { video.paused = false; video.plays++; return Promise.resolve(); };
  video.pause = () => { video.paused = true; };
  const controller = attachLivePhoto(surface, video, message => { throw new Error(message); });
  const down = () => surface.fire('pointerdown', { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 });
  return { surface, video, classes, controller, down };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let passed = 0;
  const a = fixture();
  a.down();
  assert.equal(a.video.currentTime, 0);
  assert.equal(a.classes.has('is-playing'), false);
  await delay(240);
  assert.equal(a.classes.has('is-playing'), true); passed++;
  a.surface.fire('pointerup');
  assert.equal(a.classes.has('is-playing'), false);
  assert.equal(a.video.paused, true);
  assert.equal(a.video.currentTime, 0);
  assert.equal(a.controller.consumeClick(), true); passed++;
  a.down(); await delay(240);
  assert.equal(a.video.plays, 2);
  assert.equal(a.classes.has('is-playing'), true); passed++;
  a.surface.fire('pointermove', { pointerId: 1, clientX: 210, clientY: 50 });
  assert.equal(a.video.paused, true); assert.equal(a.classes.has('is-playing'), false); passed++;
  a.down(); a.surface.fire('pointercancel'); await delay(240);
  assert.equal(a.classes.has('is-playing'), false); passed++;
  a.down(); a.surface.fire('pointerup'); await delay(240);
  assert.equal(a.classes.has('is-playing'), false);
  assert.equal(a.controller.consumeClick(), false); passed++;
  a.down(); await delay(240);
  window.fire('blur'); assert.equal(a.video.paused, true); passed++;
  a.down(); await delay(240);
  document.hidden = true; document.fire('visibilitychange'); document.hidden = false;
  assert.equal(a.video.paused, true); passed++;
  a.down(); await delay(240);
  const b = fixture(); b.down();
  assert.equal(a.video.paused, true); passed++;
  b.surface.fire('keydown', { key: 'Enter', repeat: false });
  await delay(240); b.surface.fire('keyup', { key: 'Enter' });
  assert.equal(b.video.paused, true); passed++;
  a.controller.destroy(); b.controller.destroy();
  assert.equal(window.listenerCount('blur'), 0);
  assert.equal(document.listenerCount('visibilitychange'), 0); passed++;
  console.log(JSON.stringify({ passed, description: 'Hold, release, repeat, move away, cancel, short tap, blur, hidden page, single active player, keyboard and cleanup' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
