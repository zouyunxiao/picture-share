'use strict';
const $ = id => document.getElementById(id);
const state = { items: [], admin: false, filter: 'all', uploading: false, chunkSize: 8 * 1024 ** 2, maxFileSize: 2 * 1024 ** 3 };
let galleryControllers = [], previewController = null, previewPlaceholderCleanup = null;
let visibleItems = [], previewItems = [], previewIndex = -1, previewScrollY = 0, previewGeneration = 0;
let toastTimer;
const imageLoader = new SerialImageLoader();
window.addEventListener('pagehide', () => imageLoader.suspend('page-hidden'));
window.addEventListener('pageshow', () => imageLoader.resume('page-hidden'));
document.addEventListener('visibilitychange', () => document.hidden ? imageLoader.suspend('tab-hidden') : imageLoader.resume('tab-hidden'));
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500); }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试');
  return result;
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const thumbnailURL = item => item.thumbnailUrl || `/media/${item.id}/thumbnail?v=still-2`;
const displayURL = item => item.displayUrl || item.url;
function loadPreviewPhoto(surface, photo, item) {
  const generation = previewGeneration;
  const placeholder = document.createElement('img');
  placeholder.className = 'preview-placeholder'; placeholder.alt = ''; placeholder.setAttribute('aria-hidden','true');
  photo.classList.add('preview-detail');
  surface.insertBefore(placeholder,photo);
  placeholder.addEventListener('load', () => {
    if (generation !== previewGeneration || photo.dataset.loadState === 'loaded') return;
    $('preview-status').textContent = photo.dataset.loadState === 'error' ? '清晰图暂时无法加载，正在显示缩略图' : '正在加载清晰图…';
    $('preview-status').classList.add('with-thumbnail');
  }, {once:true});
  const release = imageLoader.useLoaded(placeholder,thumbnailURL(item))
    || imageLoader.add(placeholder,thumbnailURL(item),{group:'preview'});
  previewPlaceholderCleanup = () => { release(); placeholder.remove(); };
  imageLoader.add(photo,displayURL(item),{group:'preview',
    onLoad:() => {
      if (generation !== previewGeneration) return;
      previewPlaceholderCleanup?.(); previewPlaceholderCleanup = null;
      $('preview-status').classList.add('hidden'); imageLoader.pauseGallery(false);
    },
    onError:() => {
      if (generation !== previewGeneration) return;
      $('preview-status').textContent = placeholder.naturalWidth ? '清晰图暂时无法加载，正在显示缩略图' : '暂时无法加载，请稍后重试';
      imageLoader.pauseGallery(false);
    }});
}
function liveSurface(item, large = false) {
  const surface = document.createElement(large ? 'div' : 'button');
  surface.className = large ? 'preview-media live-surface live-large' : 'thumb live-surface';
  if (large) { surface.tabIndex = 0; surface.setAttribute('role', 'group'); }
  surface.setAttribute('aria-label', `长按播放 ${PhotoDates.captureLabel(item)}的实况照片`);
  const photo = document.createElement('img'); photo.alt = '实况照片'; photo.draggable = false;
  const motion = document.createElement('video'); motion.className = 'live-motion';
  motion.muted = true; motion.defaultMuted = true; motion.playsInline = true; motion.preload = 'none';
  motion.setAttribute('playsinline', ''); motion.setAttribute('muted', ''); motion.setAttribute('aria-hidden', 'true'); motion.tabIndex = -1;
  motion.src = item.motionUrl;
  const badge = document.createElement('span'); badge.className = 'live-badge'; badge.innerHTML = '<span class="live-symbol" aria-hidden="true">◉</span> LIVE';
  const hint = document.createElement('span'); hint.className = 'live-hint'; hint.textContent = '按住播放';
  surface.append(photo, motion, badge, hint);
  if (large) loadPreviewPhoto(surface,photo,item);
  else imageLoader.add(photo,thumbnailURL(item),{detailUrl:displayURL(item)});
  const controller = attachLivePhoto(surface, motion, toast, {
    canStart:large ? event => PhotoViewer.containsMediaPoint(photo.naturalWidth ? photo : surface.querySelector('.preview-placeholder'),event.clientX,event.clientY) : undefined,
    onStart:() => imageLoader.suspend('live-motion'),onStop:() => imageLoader.resume('live-motion')});
  return { surface, controller };
}
function render() {
  $('login-open').classList.toggle('hidden', state.admin);
  $('logout').classList.toggle('hidden', !state.admin);
  $('upload-panel').classList.toggle('hidden', !state.admin);
  $('empty-upload').classList.toggle('hidden', !state.admin || Boolean(state.items.length));
  $('count').textContent = state.items.length;
  const items = state.items.filter(x => state.filter === 'all' || x.kind === state.filter || (state.filter === 'image' && x.kind === 'live'));
  for (const controller of galleryControllers) controller.destroy();
  galleryControllers = [];
  imageLoader.clear('gallery');
  $('gallery').replaceChildren();
  $('empty').classList.toggle('hidden', items.length > 0);
  $('empty-text').textContent = state.items.length ? '这个分类下还没有内容。' : '这里即将装满值得分享的照片和视频。';
  const ordered = PhotoDates.group(items).flatMap(group => group.items);
  visibleItems = ordered;
  for (const [index, item] of ordered.entries()) {
    const card = document.createElement('article'); card.className = 'card';
    let thumb;
    if (item.kind === 'live') {
      const live = liveSurface(item); thumb = live.surface; galleryControllers.push(live.controller);
      thumb.onclick = event => { if (live.controller.consumeClick()) { event.preventDefault(); return; } preview(item); };
    } else {
    thumb = document.createElement('button'); thumb.className = 'thumb'; thumb.setAttribute('aria-label', `查看第${index + 1}项，${PhotoDates.captureLabel(item)}`);
    const media = document.createElement('img');
    media.setAttribute('aria-hidden', 'true'); media.alt = item.kind === 'image' ? '照片' : '视频封面';
    imageLoader.add(media,thumbnailURL(item),{detailUrl:item.kind === 'image' ? displayURL(item) : undefined});
    thumb.append(media);
    if (item.kind === 'video') { const play = document.createElement('span'); play.className = 'play'; play.textContent = '▶'; thumb.append(play); }
    const tag = document.createElement('span'); tag.className = 'type-tag'; tag.textContent = item.kind === 'image' ? '照片' : '视频'; thumb.append(tag);
    thumb.onclick = () => preview(item);
    }
    const bottom = document.createElement('div'); bottom.className = 'card-actions';
    if (state.admin) {
      const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '删除';
      remove.onclick = async () => {
        if (!confirm('确定删除这个片刻？删除后无法恢复。')) return;
        try { await api(`/api/media/${item.id}`, { method: 'DELETE' }); await refresh(); toast('已删除这个片刻'); } catch (error) { toast(error.message); }
      };
      bottom.append(remove);
    }
    card.append(thumb, bottom); $('gallery').append(card);
  }
}
async function refresh() {
  const result = await api('/api/library');
  Object.assign(state, { items: result.items, admin: result.admin, chunkSize: result.chunkSize, maxFileSize: result.maxFileSize });
  $('loading').classList.add('hidden'); render();
}
function preview(item) {
  const opening = !$('preview-dialog').open;
  if (opening) {
    previewItems = visibleItems.slice();
    previewIndex = previewItems.findIndex(entry => entry.id === item.id);
    if (previewIndex < 0) { previewItems = [item]; previewIndex = 0; }
    previewScrollY = window.scrollY;
    document.body.style.top = `-${previewScrollY}px`;
    document.body.classList.add('viewer-open');
    imageLoader.pauseGallery(true);
    previewGestures.reset();
  }
  showPreview(item);
  if (opening) $('preview-dialog').showModal();
}
function showPreview(item) {
  const generation = ++previewGeneration;
  imageLoader.pauseGallery(true);
  previewPlaceholderCleanup?.(); previewPlaceholderCleanup = null;
  if (previewController) { previewController.destroy(); previewController = null; }
  imageLoader.resume('preview-video');
  imageLoader.clear('preview');
  const previousVideo = $('preview-content').querySelector('video');
  if (previousVideo) { previousVideo.pause(); previousVideo.removeAttribute('src'); previousVideo.load(); }
  $('preview-more').open = false;
  $('preview-date').textContent = PhotoDates.captureLabel(item);
  try { history.replaceState({ ...(history.state || {}), previewId:item.id, galleryScrollY:previewScrollY, previewFilter:state.filter }, ''); } catch {}
  $('preview-counter').textContent = `${previewIndex + 1} / ${previewItems.length}`;
  $('preview-prev').disabled = previewIndex <= 0;
  $('preview-next').disabled = previewIndex >= previewItems.length - 1;
  $('preview-status').textContent = '正在加载…';
  $('preview-status').classList.remove('hidden');
  $('preview-status').classList.remove('with-thumbnail');
  let loadingMedia;
  if (item.kind === 'live') {
    const live = liveSurface(item, true); previewController = live.controller;
    $('preview-content').replaceChildren(live.surface);
    loadingMedia = live.surface.querySelector('.preview-detail');
  } else {
    const media = document.createElement(item.kind === 'image' ? 'img' : 'video');
    if (item.kind === 'video') {
      imageLoader.suspend('preview-video');
      media.controls = true; media.playsInline = true; media.autoplay = true;
      $('preview-content').replaceChildren(media);
    } else {
      media.alt = '照片'; media.draggable = false;
      const surface = document.createElement('div'); surface.className = 'preview-media';
      surface.append(media); $('preview-content').replaceChildren(surface);
      loadPreviewPhoto(surface,media,item);
    }
    if (item.kind === 'video') media.src = item.url;
    loadingMedia = media;
  }
  const loaded = () => { if (generation === previewGeneration) $('preview-status').classList.add('hidden'); };
  loadingMedia.addEventListener(item.kind === 'video' ? 'loadeddata' : 'load', loaded, { once:true });
  loadingMedia.addEventListener('error', () => { if (generation === previewGeneration) $('preview-status').textContent = '暂时无法加载，请稍后重试'; }, { once:true });
  if (loadingMedia.complete && loadingMedia.naturalWidth || loadingMedia.readyState >= 2) loaded();
  $('preview-hint').textContent = item.kind === 'live' ? '按住播放 · 左右滑动切换 · 点击留白关闭' : item.kind === 'video' ? '左右切换浏览' : '左右滑动切换 · 点击留白关闭';
  $('download').href = item.url; $('download').download = item.kind === 'live' || item.sources ? item.name.replace(/\.[^.]+$/, '') + '.jpg' : item.name;
  $('download').textContent = item.kind === 'live' || item.sources ? '下载照片 ↓' : '下载原文件 ↓';
  $('download-motion').classList.toggle('hidden', item.kind !== 'live');
  $('download-motion').href = item.motionUrl || '#'; $('download-motion').download = item.name.replace(/\.[^.]+$/, '') + '.mp4';
  $('preview-note').textContent = item.kind === 'live' ? '按住照片播放，松开恢复封面；再次长按从头播放。动态默认静音。' : item.kind === 'video' ? '视频能否播放取决于浏览器对原始编码的支持。' : '左右滑动切换照片，点击白色留白或 × 关闭。';
  $('download-originals').replaceChildren();
  for (const source of item.sources || []) {
    const link = document.createElement('a'); link.href = source.url; link.download = source.name; link.textContent = ['mov','mp4','m4v','webm'].includes(source.ext) ? '原始视频' : '原始照片'; $('download-originals').append(link);
  }
}
function navigatePreview(delta) {
  if (!$('preview-dialog').open) return;
  const next = PhotoViewer.neighbor(previewIndex, delta, previewItems.length);
  if (next === previewIndex) return;
  previewIndex = next;
  showPreview(previewItems[previewIndex]);
}
const previewGestures = PhotoViewer.attachViewerGestures($('preview-content'), {
  navigate: navigatePreview,
  cancelLive: () => previewController?.stop(),
  consumeClick: () => previewController?.consumeClick(),
  isBackdrop: event => {
    const media = $('preview-content').querySelector('img,video');
    // Native video controls can extend into the letterbox area.
    return media?.tagName !== 'VIDEO' && !PhotoViewer.containsMediaPoint(media,event.clientX,event.clientY);
  },
  close: () => $('preview-dialog').close(),
  canStart: event => {
    if ((window.visualViewport?.scale || 1) > 1.01) return false;
    if (event.target.tagName === 'VIDEO' && event.clientY > event.target.getBoundingClientRect().bottom - 64) return false;
    return true;
  }
});
$('preview-prev').onclick = () => navigatePreview(-1);
$('preview-next').onclick = () => navigatePreview(1);
document.addEventListener('keydown', event => {
  if (!$('preview-dialog').open) return;
  if (event.target.tagName === 'VIDEO' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); previewGestures.reset(); navigatePreview(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
$('preview-close').onclick = () => $('preview-dialog').close();
$('preview-dialog').addEventListener('close', () => {
  previewGeneration++;
  if (previewController) { previewController.destroy(); previewController = null; }
  previewPlaceholderCleanup?.(); previewPlaceholderCleanup = null;
  const video = $('preview-content').querySelector('video'); if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  imageLoader.clear('preview');
  $('preview-content').replaceChildren();
  previewGestures.reset(); previewItems = []; previewIndex = -1;
  document.body.classList.remove('viewer-open'); document.body.style.top = '';
  try {
    const {previewId, galleryScrollY, previewFilter, ...rest} = history.state || {};
    history.replaceState(rest, '');
  } catch {}
  window.scrollTo(0, previewScrollY);
  imageLoader.pauseGallery(false);
  imageLoader.resume('preview-video');
});
function openLogin() { $('login-error').textContent = ''; $('login-dialog').showModal(); $('password').focus(); }
$('login-open').onclick = openLogin;
$('login-close').onclick = () => $('login-dialog').close();
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-submit').disabled = true; $('login-error').textContent = '';
  try { await api('/api/login', post({ password: $('password').value })); $('password').value = ''; $('login-dialog').close(); await refresh(); toast('已进入管理空间'); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
};
$('logout').onclick = async () => {
  if (state.uploading) { toast('请等待当前上传完成后退出'); return; }
  try { await api('/api/logout', post({})); await refresh(); toast('已退出管理'); } catch (error) { toast(error.message); }
};
for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => {
  state.filter = tab.dataset.filter;
  for (const button of document.querySelectorAll('.tab')) button.classList.toggle('active', button === tab);
  render();
};
$('choose').onclick = $('empty-upload').onclick = () => $('files').click();
$('files').onchange = async () => { const files = Array.from($('files').files); $('files').value = ''; await uploadFiles(files); };
let dragDepth = 0;
$('upload-panel').ondragenter = event => { event.preventDefault(); dragDepth++; $('upload-panel').classList.add('dragging'); };
$('upload-panel').ondragover = event => event.preventDefault();
$('upload-panel').ondragleave = () => { if (--dragDepth <= 0) { dragDepth = 0; $('upload-panel').classList.remove('dragging'); } };
$('upload-panel').ondrop = event => { event.preventDefault(); dragDepth = 0; $('upload-panel').classList.remove('dragging'); uploadFiles(Array.from(event.dataTransfer.files)); };
function uploadChunk(id, offset, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/uploads/${id}?offset=${offset}`);
    request.timeout = 240000;
    request.upload.onprogress = event => onProgress(event.loaded);
    request.onload = () => {
      let value;
      try { value = JSON.parse(request.responseText); } catch { reject(new Error('服务器响应异常，请重试')); return; }
      if (request.status >= 200 && request.status < 300) resolve(value);
      else reject(new Error(value.error || '上传失败'));
    };
    request.onerror = () => reject(new Error('网络连接中断，请重新选择文件上传'));
    request.ontimeout = () => reject(new Error('上传超时，请检查网络后重新上传'));
    request.send(chunk);
  });
}
async function uploadFiles(files) {
  if (!files.length) return;
  if (!state.admin) { openLogin(); return; }
  if (state.uploading) { toast('请等待当前一批文件上传完成'); return; }
  state.uploading = true; $('choose').disabled = true;
  let successes = 0;
  const imageExts = new Set(['jpg','jpeg','heic','heif','png','gif','webp','avif']);
  const videoExts = new Set(['mov','mp4','m4v','webm']);
  const byStem = new Map();
  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(file);
  }
  const groups = [];
  for (const batch of byStem.values()) {
    const photos = batch.filter(file => imageExts.has(file.name.split('.').pop().toLowerCase()));
    const videos = batch.filter(file => videoExts.has(file.name.split('.').pop().toLowerCase()));
    if (batch.length === 2 && photos.length === 1 && videos.length === 1) groups.push([photos[0], videos[0]]);
    else for (const file of batch) groups.push([file]);
  }
  for (const [groupIndex, group] of groups.entries()) {
    const row = document.createElement('div'); row.className = 'upload-row';
    const head = document.createElement('div'); head.className = 'upload-row-head';
    const name = document.createElement('span'); name.textContent = `第 ${groupIndex + 1} 项${group.length > 1 ? ' · 实况原片组合' : ''}`;
    const status = document.createElement('span'); status.textContent = '准备中';
    const track = document.createElement('div'); track.className = 'progress-track';
    const bar = document.createElement('div'); bar.className = 'progress-bar';
    head.append(name, status); track.append(bar); row.append(head, track); $('queue').append(row);
    const staged = [];
    try {
      let completedBytes = 0;
      const totalBytes = group.reduce((sum, file) => sum + file.size, 0);
      for (const file of group) {
      if (file.size > state.maxFileSize) throw new Error('单个文件最大 2 GB');
      const created = await api('/api/uploads', post({ name: file.name, size: file.size, purpose: 'auto' })); const id = created.id; staged.push(id);
      for (let offset = 0; offset < file.size; offset += created.chunkSize) {
        await uploadChunk(id, offset, file.slice(offset, offset + created.chunkSize), loaded => {
          const percent = Math.min(99, Math.floor((completedBytes + offset + loaded) / totalBytes * 100));
          status.textContent = percent + '%'; bar.style.width = percent + '%';
        });
      }
      await api(`/api/uploads/${id}/complete`, post({}));
      completedBytes += file.size;
      }
      status.textContent = '正在识别与处理…';
      const imported = await api('/api/import', post({ ids: staged }));
      status.textContent = imported.kind === 'live' ? 'LIVE 已发布 ✓' : '已发布 ✓';
      bar.style.width = '100%'; successes++;
      await refresh();
    } catch (error) {
      status.textContent = error.message; row.classList.add('row-error');
      for (const id of staged) await api(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  state.uploading = false; $('choose').disabled = false;
  if (successes) toast(`已保存 ${successes} 个片刻`);
}
window.addEventListener('beforeunload', event => { if (state.uploading) { event.preventDefault(); event.returnValue = ''; } });
refresh().then(() => {
  const saved = history.state;
  const item = state.items.find(item => item.id === saved?.previewId);
  if (item) {
    if (['all','image','live','video'].includes(saved.previewFilter)) {
      state.filter = saved.previewFilter;
      for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.filter === state.filter);
      render();
    }
    if (Number.isFinite(saved.galleryScrollY)) window.scrollTo(0, saved.galleryScrollY);
    preview(item);
  }
}).catch(error => { $('loading').textContent = '暂时无法连接，请刷新重试。'; toast(error.message); });
