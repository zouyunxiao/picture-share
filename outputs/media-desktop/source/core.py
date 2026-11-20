"""Local-only media inspection and authenticated upload for the desktop client."""
from dataclasses import dataclass, field
from pathlib import Path
import hashlib
import http.cookiejar
import importlib.util
import json
import mmap
import os
import sys
import urllib.error
import urllib.request

PHOTO_EXTS = {"jpg", "jpeg", "heic", "heif", "png", "gif", "webp", "avif"}
VIDEO_EXTS = {"mov", "mp4", "m4v", "webm"}
SUPPORTED = PHOTO_EXTS | VIDEO_EXTS

def site_folder():
    start = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    for parent in (start, *list(start.parents)[:5]):
        candidate = parent / "media-site"
        if (candidate / "server.js").is_file():
            return candidate
    return None

SITE = site_folder()
if not getattr(sys, "frozen", False) and SITE:
    sys.path.insert(0, str(SITE / "tools" / "python"))
# Explicit imports allow the standalone build to collect the media decoders.
from PIL import Image, ImageOps, ImageTk
import pillow_heif
import imageio_ffmpeg

def resource(name):
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / name

worker_path = resource("media-worker.py")
if not worker_path.exists() and SITE:
    worker_path = SITE / "media-worker.py"
spec = importlib.util.spec_from_file_location("moments_media_worker", worker_path)
media_worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media_worker)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

@dataclass
class MediaFile:
    name: str
    size: int
    path: str = ""
    segments: list = field(default_factory=list)
    pair_key: str | None = None
    embedded: bool = False

    @property
    def ext(self):
        return self.name.rsplit(".", 1)[-1].lower()

    @property
    def stem(self):
        import unicodedata
        return unicodedata.normalize("NFC", self.name.rsplit(".", 1)[0]).casefold()

@dataclass
class Asset:
    files: list
    kind: str
    key: str = ""
    status: str = "待导入"

    @property
    def name(self):
        return self.files[0].name

    @property
    def size(self):
        return sum(file.size for file in self.files)

def embedded_motion(path):
    try:
        with open(path, "rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            at = data.find(b"ftyp")
            return at > 4 and data.rfind(b"\xff\xd9", 0, at - 4) >= 0
    except (OSError, ValueError):
        return False

def group_files(files):
    """Prefer original identifiers; only use unique, non-conflicting name pairs."""
    used = set()
    assets = []
    photo_keys, photo_names, video_keys, video_names = {}, {}, {}, {}
    for index, file in enumerate(files):
        keys, names = (photo_keys, photo_names) if file.ext in PHOTO_EXTS else (video_keys, video_names)
        names.setdefault(file.stem, []).append((index, file))
        if file.pair_key:
            keys.setdefault(file.pair_key, []).append((index, file))
    for index, photo in enumerate(files):
        if photo.ext not in PHOTO_EXTS or index in used:
            continue
        exact = [(j, video) for j, video in video_keys.get(photo.pair_key, []) if j not in used] if photo.pair_key else []
        if len(exact) == 1:
            match = exact[0] if len(photo_keys.get(photo.pair_key, [])) == 1 else None
        elif exact:
            match = None
        else:
            named = [(j, video) for j, video in video_names.get(photo.stem, []) if j not in used and
                     not (photo.pair_key and video.pair_key and photo.pair_key != video.pair_key)]
            match = named[0] if len(named) == 1 and len(photo_names.get(photo.stem, [])) == 1 else None
        if match:
            j, video = match
            used.update((index, j))
            assets.append(Asset([photo, video], "live"))
        else:
            used.add(index)
            assets.append(Asset([photo], "live" if photo.embedded else "missing" if photo.pair_key else "image"))
    for index, file in enumerate(files):
        if index not in used:
            assets.append(Asset([file], "video"))
    for index, asset in enumerate(assets):
        asset.key = str(index)
    return assets

def inspect_paths(paths, progress=lambda value: None, cancelled=lambda: False):
    media = []
    seen = set()
    for source in paths:
        source = Path(source)
        iterator = source.rglob("*") if source.is_dir() else [source]
        for file in iterator:
            if cancelled():
                return group_files(media)
            if not file.is_file() or file.suffix.lower().lstrip(".") not in SUPPORTED:
                continue
            absolute = str(file.resolve())
            if absolute in seen:
                continue
            seen.add(absolute)
            record = MediaFile(file.name, file.stat().st_size, absolute)
            try:
                details = media_worker.inspect_source(absolute, record.ext)
                record.pair_key = details.get("pairKey")
                if record.ext in ("jpg", "jpeg"):
                    record.embedded = embedded_motion(absolute)
            except (OSError, ValueError, RuntimeError):
                pass
            media.append(record)
            progress(f"已检查 {len(media)} 个文件 · {file.name}")
    return group_files(media)

class WebsiteClient:
    def __init__(self, base="http://127.0.0.1:8787"):
        self.base = base.rstrip("/")
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, route, method="GET", data=None):
        headers = {}
        if isinstance(data, dict):
            data = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + route, data=data, method=method, headers=headers)
        try:
            with self.client.open(request, timeout=660) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                message = json.load(error).get("error", "网站请求失败")
            except (ValueError, OSError):
                message = "网站请求失败"
            raise RuntimeError(message) from None
        except urllib.error.URLError:
            raise RuntimeError("无法连接本地网站，请先点击“启动网站”") from None

    def login(self, password):
        return self.request("/api/login", "POST", {"password": password})

    def upload(self, asset, progress=lambda value: None, cancelled=lambda: False):
        ids = []
        try:
            total = asset.size
            complete = 0
            for file in asset.files:
                created = self.request("/api/uploads", "POST", {"name": file.name, "size": file.size, "purpose": "auto"})
                uid = created["id"]
                ids.append(uid)
                offset = 0
                with open(file.path, "rb") as source:
                    while chunk := source.read(created["chunkSize"]):
                        if cancelled():
                            raise RuntimeError("已取消，当前照片未发布")
                        self.request(f"/api/uploads/{uid}?offset={offset}", "PUT", chunk)
                        offset += len(chunk)
                        progress(min(99, int((complete + offset) * 100 / max(1, total))))
                self.request(f"/api/uploads/{uid}/complete", "POST", {})
                complete += file.size
            progress("识别与处理")
            result = self.request("/api/import", "POST", {"ids": ids})
            progress(100)
            return result
        except Exception:
            for uid in ids:
                try:
                    self.request(f"/api/uploads/{uid}", "DELETE")
                except Exception:
                    pass
            raise
