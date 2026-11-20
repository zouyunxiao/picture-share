'use strict';
(function(root) {
  class SerialImageLoader {
    constructor(options = {}) {
      this.fetch = options.fetch || ((...args) => fetch(...args));
      this.urls = options.urls || URL;
      this.jobs = new Map(); this.active = null; this.galleryPaused = false; this.holds = new Set();
      this.timeout = options.timeout || 45000;
      this.prefetches = new Map(); this.prefetched = new Set(); this.cache = new Map(); this.cacheBytes = 0;
      this.maxCacheBytes = options.maxCacheBytes ?? 64 * 1024 ** 2;
      this.maxCacheEntries = options.maxCacheEntries ?? 12;
      this.idleDelay = options.idleDelay ?? 300; this.idleTimer = null;
      const Observer = options.Observer === undefined ? root.IntersectionObserver : options.Observer;
      this.observer = Observer ? new Observer(entries => {
        for (const entry of entries) {
          const job = this.jobs.get(entry.target);
          if (!job) continue;
          job.visible = entry.isIntersecting;
        }
        this.pump();
      }, { rootMargin:'0px', threshold:0 }) : null;
      this.wake = () => this.pump();
      root.addEventListener?.('scroll',this.wake,{passive:true});
      root.addEventListener?.('resize',this.wake);
    }
    add(image, url, options = {}) {
      const job = { image, url, group:options.group || 'gallery', visible:false, state:'waiting',
        detailUrl:options.detailUrl, onLoad:options.onLoad, onError:options.onError, objectURL:null, released:false };
      image.dataset.loadState = 'waiting'; image.decoding = 'async'; image.loading = 'eager';
      this.jobs.set(image,job);
      if (job.group === 'gallery') this.observer?.observe(image);
      else job.visible = true;
      this.pump();
      return () => this.release(job);
    }
    release(job) {
      if (job.released) return;
      job.released = true; this.observer?.unobserve(job.image);
      this.jobs.delete(job.image);
      job.controller?.abort();
      job.image.removeAttribute('src');
      if (job.objectURL) { this.urls.revokeObjectURL(job.objectURL); job.objectURL = null; }
    }
    clear(group) {
      for (const job of [...this.jobs.values()]) if (job.group === group) this.release(job);
      if (group === 'gallery') {
        for (const job of this.prefetches.values()) { job.released = true; job.controller?.abort(); }
        this.prefetches.clear();
      }
    }
    pauseGallery(paused) {
      this.galleryPaused = paused;
      if (paused && this.active?.group === 'gallery') this.active.controller.abort();
      this.pump();
    }
    suspend(reason) { this.holds.add(reason); this.cancelIdle(); this.active?.controller.abort(); }
    resume(reason) { this.holds.delete(reason); this.pump(); }
    useLoaded(image, url) {
      const source = [...this.jobs.values()].find(job => job.url === url && job.state === 'loaded' && job.blob);
      if (!source) return null;
      const objectURL = this.urls.createObjectURL(source.blob);
      image.src = objectURL;
      let released = false;
      return () => {
        if (released) return;
        released = true; image.removeAttribute('src'); this.urls.revokeObjectURL(objectURL);
      };
    }
    eligible(job) {
      if (job.released || job.state !== 'waiting') return false;
      if (job.group !== 'gallery') return true;
      return !this.galleryPaused;
    }
    pump() {
      queueMicrotask(() => {
        if (this.holds.size) return;
        const waiting = [...this.jobs.values()].filter(job => this.eligible(job));
        waiting.sort((a,b) => (a.group === 'preview' ? -2 : a.visible ? -1 : 0)
          - (b.group === 'preview' ? -2 : b.visible ? -1 : 0));
        if (this.active) {
          // Keep a detail download already in progress when the user opens that same photo.
          const next = waiting[0];
          if (this.active.group === 'prefetch' && next &&
            (next.group !== 'preview' || next.url !== this.active.url)) this.active.controller.abort();
          return;
        }
        if (waiting.length) { this.cancelIdle(); this.run(waiting[0]); return; }
        if (!this.nextPrefetch() || this.idleTimer !== null) return;
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.active || this.holds.size) return;
          if ([...this.jobs.values()].some(job => this.eligible(job))) { this.pump(); return; }
          const job = this.nextPrefetch();
          if (job) this.run(job);
        }, this.idleDelay);
      });
    }
    cancelIdle() { clearTimeout(this.idleTimer); this.idleTimer = null; }
    nextPrefetch() {
      return [...this.prefetches.values()].filter(job => job.state === 'waiting' && !job.released)
        .sort((a,b) => Number(b.source.visible) - Number(a.source.visible))[0];
    }
    prepareDetail(source) {
      const url = source.detailUrl;
      if (!url || this.prefetched.has(url) || this.prefetches.has(url) || this.cache.has(url)) return;
      this.prefetches.set(url, { url, source, group:'prefetch', state:'waiting', released:false });
    }
    cached(url) {
      const blob = this.cache.get(url);
      if (blob) { this.cache.delete(url); this.cache.set(url,blob); }
      return blob;
    }
    remember(url, blob) {
      if (this.cache.has(url)) this.cacheBytes -= this.cache.get(url).size || 0;
      this.cache.delete(url);
      const size = blob.size || 0;
      if (size > this.maxCacheBytes || this.maxCacheEntries <= 0) return;
      this.cache.set(url,blob); this.cacheBytes += size;
      while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
        const oldest = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(oldest).size || 0; this.cache.delete(oldest);
      }
    }
    async run(job) {
      this.active = job; job.state = 'loading';
      if (job.image) job.image.dataset.loadState = 'loading';
      const controller = new AbortController(); job.controller = controller;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeout);
      try {
        let blob = this.cached(job.url);
        if (!blob) {
          const response = await this.fetch(job.url,{signal:controller.signal});
          if (!response.ok) throw new Error('图片加载失败');
          blob = await response.blob();
        }
        if (job.released || controller.signal.aborted) throw new DOMException('Aborted','AbortError');
        if (job.group !== 'gallery') this.remember(job.url,blob);
        if (job.group === 'prefetch') {
          job.state = 'loaded'; this.prefetched.add(job.url); return;
        }
        job.objectURL = this.urls.createObjectURL(blob);
        await new Promise((resolve,reject) => {
          const cleanup = () => {
            job.image.removeEventListener('load',loaded); job.image.removeEventListener('error',failed);
            controller.signal.removeEventListener('abort',aborted);
          };
          const loaded = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error('图片无法解码')); };
          const aborted = () => { cleanup(); reject(new DOMException('Aborted','AbortError')); };
          job.image.addEventListener('load',loaded,{once:true});
          job.image.addEventListener('error',failed,{once:true});
          controller.signal.addEventListener('abort',aborted,{once:true});
          job.image.src = job.objectURL;
        });
        if (!job.released) {
          if (job.group === 'gallery') job.blob = blob;
          job.state = 'loaded'; job.image.dataset.loadState = 'loaded'; job.onLoad?.();
          if (job.group === 'gallery') this.prepareDetail(job);
        }
      } catch (error) {
        if (job.objectURL && job.state !== 'loaded') {
          this.urls.revokeObjectURL(job.objectURL); job.objectURL = null; job.image.removeAttribute('src');
        }
        if (!job.released) {
          const cancelled = error.name === 'AbortError' && !timedOut;
          job.state = cancelled ? 'waiting' : 'error';
          if (job.image) job.image.dataset.loadState = job.state;
          if (!cancelled && job.group === 'prefetch') this.prefetched.add(job.url);
          if (!cancelled) job.onError?.(error);
        }
      } finally {
        clearTimeout(timer);
        if (this.active === job) this.active = null;
        this.pump();
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { SerialImageLoader };
  else root.SerialImageLoader = SerialImageLoader;
})(typeof window !== 'undefined' ? window : globalThis);
