'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const DATA = path.resolve(process.env.MEDIA_DATA_DIR || path.join(ROOT, 'data'));
const FILES = path.join(DATA, 'files');
const TEMP = path.join(DATA, 'temporary');
const THUMBNAILS = path.join(DATA, 'thumbnails');
const STILL_VERSION = 'still-2';
const STATIC_THUMBNAILS = path.join(THUMBNAILS, STILL_VERSION);
const PREVIEWS = path.join(DATA, 'previews', STILL_VERSION);
for (const dir of [DATA, FILES, TEMP, THUMBNAILS, STATIC_THUMBNAILS, PREVIEWS]) fs.mkdirSync(dir, { recursive: true });
const PORT = Number(process.env.PORT || 8787);
const MAX_FILE = 2 * 1024 ** 3;
const CHUNK = 8 * 1024 ** 2;
const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const configPath = path.join(DATA, 'config.json');
let config;
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} else {
  const password = crypto.randomBytes(12).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  config = { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(process.env.MEDIA_DATA_DIR ? DATA : ROOT, '登录信息.txt'),
    `本地网址：http://localhost:${PORT}\r\n管理员密码：${password}\r\n\r\n管理员密码只用于登录上传和删除。不要分享此文件或整个项目文件夹。\r\n公网链接请查看 公网地址.txt。\r\n`);
}
const indexPath = path.join(DATA, 'library.json');
let library = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
const sessions = new Map();
const attempts = new Map();
const uploads = new Map();
let importing = false;
const thumbnailJobs = new Map();
let thumbnailTail = Promise.resolve();
function saveLibrary(next) {
  fs.writeFileSync(indexPath + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(indexPath + '.tmp', indexPath);
  library = next;
}
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 16384) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw fail(413, '请求内容过大');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw fail(400, '请求格式不正确'); }
}
function authenticated(req) {
  const token = /(?:^|;\s*)media_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const expires = sessions.get(token);
  if (expires && expires > Date.now()) return true;
  if (token) sessions.delete(token);
  return false;
}
function admin(req) {
  if (!authenticated(req)) throw fail(401, '请先登录管理员');
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '不允许跨站操作');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw fail(403, '来源无效'); }
    if (host !== req.headers.host) throw fail(403, '来源无效');
  }
}
function publicItem(item) {
  const { pairKey, metadataVersion, ...visible } = item;
  return { ...visible, url: `/media/${item.id}`, thumbnailUrl:`/media/${item.id}/thumbnail?v=${STILL_VERSION}`,
    ...(item.kind !== 'video' ? {displayUrl:staticDisplay(item) ? `/media/${item.id}/display?v=${STILL_VERSION}` : `/media/${item.id}`} : {}),
    ...(item.kind === 'live' ? { motionUrl: `/media/${item.id}/motion` } : {}),
    ...(item.sources ? { sources: item.sources.map((source, index) => ({ ...source, url: `/media/${item.id}/original/${index}` })) } : {}) };
}
function staticDisplay(item) {
  return item.kind !== 'video' && ['jpg','jpeg','heic','heif'].includes(item.ext);
}
async function imageAssetFor(item, variant) {
  const thumbnail = path.join(STATIC_THUMBNAILS, item.id + '.webp');
  const display = staticDisplay(item) ? path.join(PREVIEWS, item.id + '.jpg') : undefined;
  const target = variant === 'display' ? display : thumbnail;
  if (!target) throw fail(404, '展示图片不存在');
  if (fs.existsSync(target)) return target;
  if (!thumbnailJobs.has(item.id)) {
    const job = thumbnailTail.catch(() => {}).then(async () => {
      if (!fs.existsSync(target)) {
        const requestFile = path.join(TEMP, crypto.randomUUID() + '.json');
        try {
          await runMediaWorker({mode:'thumbnails',items:[{id:item.id,kind:item.kind,path:path.join(FILES,`${item.id}.${item.ext}`),output:thumbnail,displayOutput:display}]},requestFile);
        } finally { fs.rmSync(requestFile,{force:true}); }
      }
      if (!library.some(current => current.id === item.id)) {
        fs.rmSync(thumbnail,{force:true});
        if (display) fs.rmSync(display,{force:true});
        throw fail(404,'文件不存在');
      }
      return target;
    });
    thumbnailTail = job;
    thumbnailJobs.set(item.id,job);
    job.finally(() => thumbnailJobs.delete(item.id)).catch(() => {});
  }
  await thumbnailJobs.get(item.id);
  return target;
}
function originalResource(item) {
  let index = item.sources?.findIndex(source => types[source.ext]?.startsWith(item.kind === 'video' ? 'video/' : 'image/'));
  if (index === -1 || index === undefined) index = 0;
  const original = item.sources?.[index];
  return original ? { ...original, id: item.id, publishedId: item.id, sourcePath: path.join(FILES, `${item.id}.source${index}.${original.ext}`) }
    : { ...item, publishedId: item.id, sourcePath: path.join(FILES, `${item.id}.${item.ext}`) };
}
function stem(name) { return name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase(); }
function findPartner(first, key, isPhoto) {
  const candidates = library.filter(item => item.kind === (isPhoto ? 'video' : 'image'));
  if (key) {
    const exact = candidates.filter(item => item.pairKey === key);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const named = candidates.filter(item => stem(item.name) === stem(first.name) && !(key && item.pairKey && key !== item.pairKey));
  return named.length === 1 ? named[0] : null;
}
async function scanLibraryMetadata() {
  const pending = library.filter(item => item.metadataVersion !== 2);
  if (!pending.length) return;
  const jobPath = path.join(TEMP, crypto.randomUUID() + '.json');
  try {
    const result = await runMediaWorker({ mode: 'inspect', items: pending.map(item => {
      const original = originalResource(item);
      const motionIndex = item.kind === 'live' ? item.sources?.findIndex(source => types[source.ext]?.startsWith('video/')) : -1;
      const motion = motionIndex >= 0 ? item.sources[motionIndex] : null;
      return { id: item.id, path: original.sourcePath, ext: original.ext,
        fallbackPath: motion ? path.join(FILES, `${item.id}.source${motionIndex}.${motion.ext}`) : null, fallbackExt: motion?.ext };
    }) }, jobPath);
    const metadata = new Map(result.items.map(item => [item.id, item]));
    saveLibrary(library.map(item => {
      const details = metadata.get(item.id);
      return details ? { ...item, pairKey: details.pairKey, metadataVersion: 2,
        capturedAt: details.capturedAt, captureDate: details.captureDate, captureTimeSource: details.captureTimeSource,
        liveState: item.kind === 'image' && details.liveHint ? 'missing-motion' : undefined } : item;
    }));
    console.log(`Live metadata checked: ${pending.length} existing files`);
  } finally { fs.rmSync(jobPath, { force: true }); }
}
function runMediaWorker(job, jobPath) {
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const localPython = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
  const bundledPython = path.join(ROOT, 'tools', 'python-runtime', 'python.exe');
  const python = process.env.PYTHON || (fs.existsSync(bundledPython) ? bundledPython : fs.existsSync(localPython) ? localPython : 'python');
  return new Promise((resolve, reject) => {
    const worker = spawn(python, ['-X', 'utf8', path.join(ROOT, 'media-worker.py'), jobPath], { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { worker.kill(); reject(fail(422, 'Live 图处理超时，请尝试更短的动态片段')); }, 600000);
    worker.stdout.on('data', chunk => { output += chunk.toString(); });
    worker.stderr.on('data', () => {});
    worker.on('error', () => { clearTimeout(timer); reject(fail(503, '无法启动 Live 图处理组件，请检查 Python 环境')); });
    worker.on('close', code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(output); } catch { reject(fail(422, 'Live 图处理失败，请重新导出原始文件')); return; }
      if (code !== 0 || result.error) reject(fail(422, result.error || 'Live 图处理失败'));
      else resolve(result);
    });
  });
}
async function importResources(ids) {
  if (importing) throw fail(409, '正在处理上一张 Live 图，请稍后再试');
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw fail(400, '导入文件组合无效');
  const resources = ids.map(id => uploads.get(id));
  if (resources.some(item => !item || !item.ready || item.busy)) throw fail(409, '上传尚未完成或已过期');
  const photos = resources.filter(item => types[item.ext].startsWith('image/'));
  const videos = resources.filter(item => types[item.ext].startsWith('video/'));
  if (resources.length === 2 && (photos.length !== 1 || videos.length !== 1)) throw fail(400, 'Live 图需要一张照片和一段动态视频');
  importing = true;
  for (const resource of resources) resource.busy = true;
  const id = crypto.randomUUID();
  const prefix = path.join(TEMP, id);
  const jobPath = prefix + '.json';
  const generated = [];
  let committed = false;
  try {
    let photo = photos[0], video = videos[0], matched = null;
    const sourcePath = resource => resource.sourcePath || path.join(TEMP, resource.id);
    const processResources = () => runMediaWorker({ photo: photo ? sourcePath(photo) : null, photoExt: photo?.ext,
      video: video ? sourcePath(video) : null, videoExt: video?.ext, outputPrefix: prefix }, jobPath);
    let result = await processResources();
    if (resources.length === 1 && result.kind !== 'live') {
      matched = findPartner(photo || video, result.pairKey, Boolean(photo));
      if (matched) {
        const previous = originalResource(matched);
        resources.push(previous);
        if (photo) video = previous;
        else photo = previous;
        result = await processResources();
      }
    }
    // A complete original pair can repair a previously uploaded browser JPEG.
    if (!matched && result.kind === 'live' && result.pairKey) {
      const priorPhotos = library.filter(item => item.kind === 'image' && item.pairKey === result.pairKey);
      if (priorPhotos.length === 1) matched = priorPhotos[0];
    }
    const first = photo || video;
    const item = { id, name: first.name, size: resources.reduce((sum, resource) => sum + resource.size, 0),
      ext: result.kind === 'original' ? first.ext : 'jpg',
      kind: result.kind === 'live' ? 'live' : photo ? 'image' : 'video', createdAt: new Date().toISOString(),
      pairKey: result.pairKey, metadataVersion: 2,
      capturedAt: result.capturedAt, captureDate: result.captureDate, captureTimeSource: result.captureTimeSource,
      liveState: photo && result.kind !== 'live' && result.liveHint ? 'missing-motion' : undefined };
    if (result.kind === 'original') {
      const target = path.join(FILES, `${id}.${first.ext}`);
      fs.copyFileSync(sourcePath(first), target); generated.push(target);
    } else {
      const target = path.join(FILES, `${id}.jpg`);
      fs.renameSync(prefix + '.poster.jpg', target); generated.push(target);
      if (item.kind === 'live') {
        const motion = path.join(FILES, `${id}.live.mp4`);
        fs.renameSync(prefix + '.motion.mp4', motion); generated.push(motion);
      }
      item.sources = resources.map((resource, index) => {
        const original = path.join(FILES, `${id}.source${index}.${resource.ext}`);
        fs.copyFileSync(sourcePath(resource), original); generated.push(original);
        return { name: resource.name, ext: resource.ext, size: resource.size };
      });
    }
    if (matched && !library.some(item => item.id === matched.id)) throw fail(409, '待配对照片已被删除，请重新上传');
    if (matched) {
      const archivePath = path.join(DATA, 'merged-history.json');
      const history = fs.existsSync(archivePath) ? JSON.parse(fs.readFileSync(archivePath, 'utf8')) : [];
      fs.writeFileSync(archivePath, JSON.stringify([...history, { previous: matched, replacementId: item.id }], null, 2));
    }
    saveLibrary([item, ...library.filter(previous => previous.id !== matched?.id)]);
    committed = true;
    for (const resource of resources) {
      if (!resource.publishedId) { uploads.delete(resource.id); fs.rmSync(path.join(TEMP, resource.id), { force: true }); }
    }
    return publicItem(item);
  } finally {
    if (!committed) for (const file of generated) fs.rmSync(file, { force: true });
    for (const suffix of ['.json', '.poster.jpg', '.motion.mp4', '.embedded.mp4']) fs.rmSync(prefix + suffix, { force: true });
    for (const resource of resources) resource.busy = false;
    importing = false;
  }
}
function validSignature(ext, buffer) {
  if (['jpg', 'jpeg'].includes(ext)) return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (ext === 'png') return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === 'gif') return /^GIF8[79]a/.test(buffer.subarray(0,6).toString('ascii'));
  if (ext === 'webp') return buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP';
  if (ext === 'webm') return buffer.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  if (['mp4','m4v','mov','avif'].includes(ext)) return ['ftyp','moov','mdat','wide','free','skip'].includes(buffer.toString('ascii',4,8));
  if (['heic','heif'].includes(ext)) return buffer.toString('ascii',4,8) === 'ftyp';
  return false;
}
async function serveMedia(req, res, id, variant, sourceIndex) {
  const item = library.find(x => x.id === id);
  if (!item) throw fail(404, '文件不存在');
  let ext = item.ext, name = item.name, suffix = `.${ext}`;
  if (item.sources && ext === 'jpg') name = name.replace(/\.[^.]+$/, '') + '.jpg';
  if (variant === 'motion') {
    if (item.kind !== 'live') throw fail(404, '动态片段不存在');
    ext = 'mp4'; suffix = '.live.mp4'; name = item.name.replace(/\.[^.]+$/, '') + '.mp4';
  } else if (variant === 'original') {
    const source = item.sources?.[Number(sourceIndex)];
    if (!source) throw fail(404, '原始文件不存在');
    ext = source.ext; name = source.name; suffix = `.source${Number(sourceIndex)}.${ext}`;
  }
  const filename = ['thumbnail','display'].includes(variant) ? await imageAssetFor(item,variant) : path.join(FILES, `${item.id}${suffix}`);
  if (variant === 'thumbnail') { ext = 'webp'; name = 'thumbnail.webp'; }
  if (variant === 'display') { ext = 'jpg'; name = 'photo.jpg'; }
  const stat = await fs.promises.stat(filename).catch(() => { throw fail(404, '文件不存在'); });
  let start = 0, end = stat.size - 1, status = 200;
  const headers = { 'Content-Type': types[ext], 'Accept-Ranges': 'bytes',
    'Cache-Control': ['thumbnail','display'].includes(variant) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` };
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(filename, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (!['GET','HEAD'].includes(req.method)) sameOrigin(req);
    if (route === '/api/library' && req.method === 'GET') {
      json(res, 200, { items: library.map(publicItem), admin: authenticated(req), maxFileSize: MAX_FILE, chunkSize: CHUNK }); return;
    }
    if (route === '/api/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress;
      const attempt = attempts.get(key);
      if (attempt && attempt.until > Date.now() && attempt.count >= 10) throw fail(429, '尝试次数过多，请 15 分钟后再试');
      const { password } = await body(req);
      if (typeof password !== 'string' || password.length > 256) throw fail(400, '密码格式不正确');
      const actual = crypto.scryptSync(password, config.salt, 64);
      if (!crypto.timingSafeEqual(actual, Buffer.from(config.hash, 'hex'))) {
        attempts.set(key, { count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 900000 });
        throw fail(401, '管理员密码不正确');
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 12 * 3600000);
      const secure = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
      json(res, 200, { ok: true }, { 'Set-Cookie': `media_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}` }); return;
    }
    if (route === '/api/logout' && req.method === 'POST') {
      const token = /(?:^|;\s*)media_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
      sessions.delete(token);
      json(res, 200, { ok: true }, { 'Set-Cookie': 'media_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); return;
    }
    if (route === '/api/uploads' && req.method === 'POST') {
      admin(req);
      if (uploads.size >= 10) throw fail(429, '等待上传的文件过多，请稍后再试');
      const { name, size, purpose } = await body(req);
      if (typeof name !== 'string' || name.length > 240) throw fail(400, '文件名无效或过长');
      const ext = name.split('.').pop().toLowerCase();
      if (!types[ext]) throw fail(415, '支持 JPG、HEIC、PNG、GIF、WebP、AVIF、MP4、WebM、MOV 格式');
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) throw fail(413, '单个文件需小于等于 2 GB');
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(TEMP, id), '');
      uploads.set(id, { id, name: path.basename(name).replace(/[\x00-\x1f]/g, ''), size, ext, purpose: purpose === 'auto' ? 'auto' : null, offset: 0, touched: Date.now(), busy: false });
      json(res, 201, { id, chunkSize: CHUNK }); return;
    }
    const uploadMatch = /^\/api\/uploads\/([a-f0-9-]{36})(\/complete)?$/.exec(route);
    if (uploadMatch) {
      admin(req);
      const upload = uploads.get(uploadMatch[1]);
      if (!upload) throw fail(404, '上传任务已失效，请重新上传');
      if (upload.busy) throw fail(409, '文件正在写入，请稍后再试');
      const tempPath = path.join(TEMP, upload.id);
      if (req.method === 'PUT' && !uploadMatch[2]) {
        if (upload.ready) throw fail(409, '上传已经完成');
        const offset = Number(url.searchParams.get('offset'));
        const length = Number(req.headers['content-length']);
        if (offset !== upload.offset) throw fail(409, '上传位置不一致，请重新上传');
        if (!Number.isSafeInteger(length) || length < 1 || length > CHUNK || offset + length > upload.size) throw fail(413, '上传分片大小无效');
        upload.busy = true;
        let handle;
        let received = 0;
        try {
          handle = await fs.promises.open(tempPath, 'r+');
          for await (const chunk of req) {
            received += chunk.length;
            if (received > length) throw fail(413, '分片大小不一致');
            let written = 0;
            while (written < chunk.length) {
              const result = await handle.write(chunk, written, chunk.length - written, offset + received - chunk.length + written);
              written += result.bytesWritten;
            }
          }
          if (received !== length) throw fail(400, '网络中断，请重试');
          upload.offset += received;
          upload.touched = Date.now();
        } catch (error) {
          if (handle) await handle.truncate(offset);
          throw error;
        } finally {
          if (handle) await handle.close();
          upload.busy = false;
        }
        json(res, 200, { offset: upload.offset }); return;
      }
      if (req.method === 'POST' && uploadMatch[2]) {
        if (upload.offset !== upload.size) throw fail(400, '文件尚未上传完成');
        const header = Buffer.alloc(32);
        const handle = fs.openSync(tempPath, 'r');
        try { fs.readSync(handle, header, 0, 32, 0); } finally { fs.closeSync(handle); }
        if (!validSignature(upload.ext, header)) throw fail(415, '文件内容与格式不符，请选择真实的图片或视频文件');
        if (upload.purpose === 'auto') {
          upload.ready = true; upload.touched = Date.now();
          json(res, 200, { id: upload.id, ready: true }); return;
        }
        const item = { id: upload.id, name: upload.name, size: upload.size, ext: upload.ext,
          kind: types[upload.ext].startsWith('image/') ? 'image' : 'video', createdAt: new Date().toISOString() };
        const finalPath = path.join(FILES, `${item.id}.${item.ext}`);
        fs.renameSync(tempPath, finalPath);
        try { saveLibrary([item, ...library]); }
        catch (error) { fs.renameSync(finalPath, tempPath); throw error; }
        uploads.delete(item.id);
        json(res, 201, publicItem(item)); return;
      }
      if (req.method === 'DELETE') {
        fs.rmSync(tempPath, { force: true }); uploads.delete(upload.id);
        json(res, 200, { ok: true }); return;
      }
    }
    if (route === '/api/import' && req.method === 'POST') {
      admin(req);
      const { ids } = await body(req);
      json(res, 201, await importResources(ids)); return;
    }
    const mediaMatch = /^\/media\/([a-f0-9-]{36})(?:\/(motion|original|thumbnail|display)(?:\/([01]))?)?$/.exec(route);
    if (mediaMatch && ['GET', 'HEAD'].includes(req.method)) { await serveMedia(req, res, mediaMatch[1], mediaMatch[2], mediaMatch[3]); return; }
    const deleteMatch = /^\/api\/media\/([a-f0-9-]{36})$/.exec(route);
    if (deleteMatch && req.method === 'DELETE') {
      admin(req);
      const item = library.find(x => x.id === deleteMatch[1]);
      if (!item) throw fail(404, '文件不存在');
      saveLibrary(library.filter(x => x.id !== item.id));
      fs.rmSync(path.join(FILES, `${item.id}.${item.ext}`), { force: true });
      fs.rmSync(path.join(THUMBNAILS,`${item.id}.webp`),{force:true});
      fs.rmSync(path.join(STATIC_THUMBNAILS,`${item.id}.webp`),{force:true});
      fs.rmSync(path.join(PREVIEWS,`${item.id}.jpg`),{force:true});
      if (item.kind === 'live') fs.rmSync(path.join(FILES, `${item.id}.live.mp4`), { force: true });
      for (const [index, source] of (item.sources || []).entries()) fs.rmSync(path.join(FILES, `${item.id}.source${index}.${source.ext}`), { force: true });
      json(res, 200, { ok: true }); return;
    }
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/live-photo.js': ['live-photo.js', 'text/javascript; charset=utf-8'], '/photo-dates.js': ['photo-dates.js', 'text/javascript; charset=utf-8'], '/viewer-gestures.js': ['viewer-gestures.js', 'text/javascript; charset=utf-8'], '/image-loader.js': ['image-loader.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    if (assets[route] && ['GET', 'HEAD'].includes(req.method)) {
      const [file, type] = assets[route];
      const bytes = fs.readFileSync(path.join(ROOT, 'public', file));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes); return;
    }
    if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    throw fail(404, '页面不存在');
  } catch (error) {
    if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : '服务器暂时无法处理，请检查磁盘空间后重试' });
    if (!error.status) console.error(error);
  }
});
setInterval(() => {
  for (const [id, upload] of uploads) if (!upload.busy && Date.now() - upload.touched > 3600000) {
    fs.rmSync(path.join(TEMP, id), { force: true }); uploads.delete(id);
  }
  for (const [key, until] of sessions) if (until < Date.now()) sessions.delete(key);
  for (const [key, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(key);
}, 60000).unref();
// Unfinished uploads are disposable; published files remain in data/files.
for (const file of fs.readdirSync(TEMP)) fs.rmSync(path.join(TEMP, file), { force: true });
server.requestTimeout = 300000;
server.headersTimeout = 30000;
server.on('error', error => { console.error(error.message); process.exit(1); });
scanLibraryMetadata().catch(error => console.error('Metadata scan:', error.message)).finally(() => {
  server.listen(PORT, '127.0.0.1', () => console.log(`Media site ready: http://localhost:${PORT}`));
});
