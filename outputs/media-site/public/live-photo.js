'use strict';
// One controller for mouse, touch, pen and keyboard, shared by cards and previews.
(function (root) {
  let active = null;
  function attachLivePhoto(surface, video, reportError = () => {}, options = {}) {
    let held = false, activated = false, timer = null, pointer = null, origin = null;
    let generation = 0, suppressClick = false, destroyed = false;
    const listeners = [];
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler, options));
    };
    function show() {
      if (held && activated && video.readyState >= 2) {
        surface.classList.add('is-playing');
        surface.classList.remove('is-loading');
      }
    }
    function stop() {
      const wasHeld = held;
      held = false; activated = false; generation++;
      clearTimeout(timer); timer = null;
      video.pause();
      try { video.currentTime = 0; } catch {}
      surface.classList.remove('is-playing', 'is-loading', 'is-holding');
      if (pointer !== null && surface.hasPointerCapture?.(pointer)) surface.releasePointerCapture(pointer);
      pointer = null; origin = null;
      if (active === controller) active = null;
      if (wasHeld) options.onStop?.();
    }
    function begin() {
      if (destroyed || held) return;
      if (active && active !== controller) active.stop();
      held = true; suppressClick = false; active = controller;
      options.onStart?.();
      const current = ++generation;
      try { video.currentTime = 0; } catch {}
      // Call play inside the input event so mobile Safari retains user activation.
      Promise.resolve(video.play()).then(() => {
        if (current === generation && held) show();
        else if (!held) video.pause();
      }).catch(() => {
        if (current === generation && held) { stop(); reportError('动态片段暂时无法播放，请稍后重试'); }
      });
      timer = setTimeout(() => {
        if (!held || current !== generation) return;
        activated = true; suppressClick = true;
        try { video.currentTime = 0; } catch {}
        surface.classList.add('is-holding', 'is-loading');
        show();
      }, 220);
    }
    const controller = {
      stop,
      consumeClick() { const consumed = suppressClick; suppressClick = false; return consumed; },
      destroy() { stop(); destroyed = true; for (const remove of listeners) remove(); }
    };
    listen(surface, 'pointerdown', event => {
      if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (options.canStart?.(event) === false) return;
      pointer = event.pointerId; origin = { x: event.clientX, y: event.clientY };
      try { surface.setPointerCapture(pointer); } catch {}
      begin();
    });
    listen(surface, 'pointermove', event => {
      if (!held || event.pointerId !== pointer) return;
      const bounds = surface.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom ||
          (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 14)) {
        suppressClick = true; stop();
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(surface, type, stop);
    listen(surface, 'pointerleave', () => { if (held) { suppressClick = true; stop(); } });
    listen(surface, 'contextmenu', event => event.preventDefault());
    listen(surface, 'dragstart', event => event.preventDefault());
    listen(surface, 'keydown', event => {
      if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) begin(); }
    });
    listen(surface, 'keyup', event => {
      if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stop(); }
    });
    listen(video, 'playing', show);
    listen(video, 'loadeddata', show);
    listen(video, 'error', () => { if (held) { stop(); reportError('动态片段无法加载，请检查网络后重试'); } });
    listen(window, 'blur', stop);
    listen(window, 'scroll', () => { if (held) { suppressClick = true; stop(); } }, true);
    listen(document, 'visibilitychange', () => { if (document.hidden) stop(); });
    return controller;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { attachLivePhoto };
  else root.attachLivePhoto = attachLivePhoto;
})(typeof window !== 'undefined' ? window : globalThis);
