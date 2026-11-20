'use strict';
(function(root) {
  function attachViewerGestures(surface, options) {
    let start = null, suppressClick = false;
    const pointers = new Set();
    const listeners = [];
    const listen = (target, type, handler, settings) => {
      target.addEventListener(type, handler, settings);
      listeners.push(() => target.removeEventListener(type, handler, settings));
    };
    const cancel = () => { start = null; pointers.clear(); };
    listen(surface, 'pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.add(event.pointerId);
      if (pointers.size > 1) {
        start = null; suppressClick = true; options.cancelLive?.(); return;
      }
      suppressClick = false;
      start = null;
      if (event.isPrimary === false || options.canStart?.(event) === false) return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      const media = event.target.closest?.('.preview-media');
      try { media?.setPointerCapture(event.pointerId); } catch {}
    });
    listen(surface, 'pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) > 10) suppressClick = true;
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        options.cancelLive?.();
        if (event.cancelable) event.preventDefault();
      }
    }, { passive: false });
    listen(window, 'pointerup', event => {
      pointers.delete(event.pointerId);
      if (!start || event.pointerId !== start.id) return;
      const origin = start;
      start = null;
      const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
      if (Math.hypot(dx, dy) > 10) suppressClick = true;
      const threshold = Math.max(40, Math.min(90, surface.clientWidth * .12));
      if (pointers.size === 0 && Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.35) {
        suppressClick = true; options.cancelLive?.(); options.navigate(dx < 0 ? 1 : -1);
      }
    });
    listen(window, 'pointercancel', event => {
      if (pointers.has(event.pointerId)) { suppressClick = true; options.cancelLive?.(); }
      pointers.delete(event.pointerId);
      start = null;
    });
    listen(surface, 'click', event => {
      if (suppressClick || options.consumeClick?.()) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (event.detail !== 0 && options.isBackdrop?.(event)) {
        event.preventDefault(); event.stopImmediatePropagation(); options.close?.();
      }
    }, true);
    listen(surface, 'dragstart', event => event.preventDefault());
    listen(surface, 'keydown', () => { suppressClick = false; });
    listen(window, 'blur', cancel);
    return {
      reset() { cancel(); suppressClick = false; },
      destroy() { cancel(); for (const remove of listeners) remove(); }
    };
  }
  function neighbor(index, delta, total) {
    const next = index + delta;
    return next >= 0 && next < total ? next : index;
  }
  function containsMediaPoint(media, x, y) {
    if (!media) return false;
    const width = media.naturalWidth || media.videoWidth, height = media.naturalHeight || media.videoHeight;
    if (!width || !height) return false;
    const box = media.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height);
    const left = box.left + (box.width - width * scale) / 2;
    const top = box.top + (box.height - height * scale) / 2;
    return x >= left && x <= left + width * scale && y >= top && y <= top + height * scale;
  }
  const api = { attachViewerGestures, neighbor, containsMediaPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoViewer = api;
})(typeof window !== 'undefined' ? window : globalThis);
