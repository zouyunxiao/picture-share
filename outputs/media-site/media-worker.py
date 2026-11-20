"""Decode HEIC and normalize Live Photo motion for browser playback."""
import json
import mmap
import os
from pathlib import Path
import re
import subprocess
import sys
import struct
import hashlib
import io
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(Path(__file__).parent / "tools" / "python"))
from PIL import Image, ImageOps, ImageCms
import pillow_heif
import imageio_ffmpeg

pillow_heif.register_heif_opener()
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

EMPTY_CAPTURE = {"capturedAt": None, "captureDate": None, "captureTimeSource": None}

def capture_value(raw, source, offset=None, subseconds=None):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    if not isinstance(raw, str):
        return None
    raw = raw.strip().strip("\x00")
    raw = re.sub(r"^(\d{4}):(\d{2}):(\d{2})", r"\1-\2-\3", raw)
    if not re.match(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", raw):
        return None
    try:
        value = datetime.fromisoformat(raw.replace(" ", "T", 1).replace("Z", "+00:00"))
        if value.tzinfo is None and offset:
            zone = str(offset).strip().strip("\x00")
            match = re.fullmatch(r"([+-])(\d{2}):?(\d{2})", zone)
            if match:
                hours, minutes = int(match[2]), int(match[3])
                if hours < 24 and minutes < 60:
                    delta = timedelta(hours=hours, minutes=minutes)
                    value = value.replace(tzinfo=timezone(delta if match[1] == "+" else -delta))
        fraction = str(subseconds or "").strip().strip("\x00").lstrip(".")
        if fraction.isdigit():
            value = value.replace(microsecond=int(fraction[:6].ljust(6, "0")))
        return {"capturedAt": value.isoformat(), "captureDate": value.date().isoformat(), "captureTimeSource": source}
    except (ValueError, OverflowError):
        return None

def photo_capture(source):
    try:
        with Image.open(source) as image:
            exif = image.getexif()
            details = exif.get_ifd(34665)
            for tag, offset, fraction, label in (
                (36867, 36881, 37521, "exif-original"),
                (36868, 36882, 37522, "exif-digitized"),
            ):
                result = capture_value(details.get(tag) or exif.get(tag), label,
                                       details.get(offset) or exif.get(offset),
                                       details.get(fraction) or exif.get(fraction))
                if result:
                    return result
            xmp = image.info.get("xmp") or image.info.get("XML:com.adobe.xmp") or b""
            if isinstance(xmp, bytes):
                xmp = xmp.decode("utf-8", "replace")
            for name in ("exif:DateTimeOriginal", "photoshop:DateCreated", "xmp:CreateDate"):
                match = re.search(re.escape(name) + r'''\s*=\s*["']([^"']+)["']''', xmp)
                if match:
                    result = capture_value(match[1], "xmp-capture")
                    if result:
                        return result
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return dict(EMPTY_CAPTURE)

def identity_digest(value):
    value = value.strip().strip("\x00").lower()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value):
        return None
    return hashlib.sha256(value.encode("ascii")).hexdigest()

def photo_identity(source):
    # Apple MakerNote tag 17 identifies a paired still. It is not the movie itself.
    try:
        with Image.open(source) as image:
            maker = image.getexif().get_ifd(34665).get(37500, b"")
        if not maker.startswith(b"Apple iOS") or len(maker) < 16:
            return None
        endian = ">" if maker[12:14] == b"MM" else "<"
        count = struct.unpack_from(endian + "H", maker, 14)[0]
        for index in range(min(count, 512)):
            at = 16 + index * 12
            if at + 12 > len(maker):
                break
            tag, kind, length, offset = struct.unpack_from(endian + "HHII", maker, at)
            if tag == 17 and kind == 2 and 0 < length <= 128:
                value = maker[at+8:at+12] if length <= 4 else maker[offset:offset+length]
                return identity_digest(value.rstrip(b"\x00").decode("ascii"))
    except (OSError, ValueError, struct.error, UnicodeError, TypeError):
        pass
    return None

def video_metadata(source):
    result = subprocess.run([FFMPEG, "-hide_banner", "-i", str(source)], capture_output=True, timeout=30,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    text = result.stderr.decode("utf-8", "replace")
    found = re.search(r"content.identifier\s*:\s*([^\r\n]+)", text, re.I)
    key = identity_digest(found[1]) if found else None
    capture = None
    for pattern, label in (
        (r"^\s*com\.apple\.quicktime\.creationdate\s*:\s*([^\r\n]+)", "quicktime-local"),
        (r"^\s*creation_time\s*:\s*([^\r\n]+)", "quicktime-created"),
    ):
        for match in re.finditer(pattern, text, re.M | re.I):
            candidate = capture_value(match[1], label)
            if candidate and int(candidate["captureDate"][:4]) > 1904:
                capture = candidate
                break
        if capture:
            break
    return {"pairKey": key, "liveHint": bool(key), **(capture or EMPTY_CAPTURE)}

def video_identity(source):
    return video_metadata(source)["pairKey"]

def inspect_source(source, ext):
    if ext in ("mov", "mp4", "m4v", "webm"):
        return video_metadata(source)
    key = photo_identity(source) if ext in ("jpg", "jpeg", "heic", "heif") else None
    return {"pairKey": key, "liveHint": bool(key), **photo_capture(source)}

def inspect_item(item):
    details = inspect_source(item["path"], item["ext"])
    if not details["capturedAt"] and item.get("fallbackPath"):
        alternate = inspect_source(item["fallbackPath"], item["fallbackExt"])
        for key in EMPTY_CAPTURE:
            details[key] = alternate[key]
    return {"id": item["id"], **details}

def run_ffmpeg(arguments):
    result = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *arguments],
        capture_output=True, timeout=540,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise ValueError("动态部分无法解码，请从照片或影石 App 重新导出原片")

def embedded_video(source, output):
    """Use Motion Photo XMP offsets, then validate an appended MP4 box sequence."""
    with open(source, "rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        candidates = []
        header = data[:min(len(data), 2 * 1024 * 1024)]
        for match in re.finditer(rb'(?:MicroVideoOffset|MotionPhotoOffset)\s*=\s*["\'](\d+)["\']', header):
            candidates.append(len(data) - int(match[1]))
        # Container:Directory motion photos store the video length in their XMP.
        for match in re.finditer(rb'Item:Length\s*=\s*["\'](\d+)["\']', header):
            length = int(match[1])
            if length:
                candidates.append(len(data) - length)
        pos = data.find(b"ftyp")
        while pos >= 0 and len(candidates) < 100:
            candidates.append(pos - 4)
            pos = data.find(b"ftyp", pos + 4)
        for offset in dict.fromkeys(candidates):
            if offset < 4 or offset + 16 > len(data):
                continue
            if data[offset+4:offset+8] != b"ftyp":
                continue
            size = int.from_bytes(data[offset:offset+4], "big")
            if size < 16 or size > 4096 or offset + size > len(data):
                continue
            # A JPEG EOI before the movie distinguishes appended motion from EXIF.
            if data[:2] == b"\xff\xd8" and data.rfind(b"\xff\xd9", 0, offset) < 0:
                continue
            with open(output, "wb") as dest:
                for start in range(offset, len(data), 1024 * 1024):
                    dest.write(data[start:min(start + 1024 * 1024, len(data))])
            return True
    return False

def still_image(source):
    with Image.open(source) as image:
        # MPF auxiliary images (for example HDR gain maps) are not Live motion frames.
        entries = getattr(image, "mpinfo", {}).get(45058, [])
        primary = next((index for index, entry in enumerate(entries)
                        if entry.get("Attribute", {}).get("MPType") == "Baseline MP Primary Image"), 0)
        if entries:
            image.seek(primary)
        image = ImageOps.exif_transpose(image).convert("RGB")
        profile = image.info.get("icc_profile")
        if profile:
            try:
                image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                                  ImageCms.createProfile("sRGB"), outputMode="RGB")
            except (OSError, ValueError, ImageCms.PyCMSError):
                pass
        return image

def poster(source, output):
    image = still_image(source)
    image.thumbnail((3840, 3840))
    image.save(output, "JPEG", quality=94)

def main(job):
    if job.get("mode") == "thumbnails":
        results = []
        for item in job["items"]:
            destination = Path(item["output"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.stem + "." + os.urandom(4).hex() + ".temporary.webp")
            frame = temporary.with_suffix(".frame.png")
            display = Path(item["displayOutput"]) if item.get("displayOutput") else None
            display_temporary = temporary.with_suffix(".display.jpg")
            try:
                source = item["path"]
                if item.get("kind") == "video":
                    run_ffmpeg(["-i",source,"-frames:v","1","-vf","scale=640:640:force_original_aspect_ratio=decrease",str(frame)])
                    source = frame
                if display:
                    display.parent.mkdir(parents=True, exist_ok=True)
                    if not display.exists():
                        image = still_image(source)
                        image.thumbnail((4096,4096))
                        image.save(display_temporary,"JPEG",quality=92)
                        os.replace(display_temporary,display)
                    source = display
                image = still_image(source)
                image.thumbnail((640,640))
                image.save(temporary,"WEBP",quality=76,method=4)
                os.replace(temporary,destination)
                results.append({"id":item["id"],"bytes":destination.stat().st_size})
            finally:
                temporary.unlink(missing_ok=True)
                frame.unlink(missing_ok=True)
                display_temporary.unlink(missing_ok=True)
        return {"items":results}
    if job.get("mode") == "inspect":
        return {"items": [inspect_item(item) for item in job["items"]]}
    photo = job.get("photo")
    video = job.get("video")
    identity = inspect_source(photo, job.get("photoExt")) if photo else inspect_source(video, job.get("videoExt"))
    if photo and video:
        video_details = video_metadata(video)
        video_key = video_details["pairKey"]
        if identity["pairKey"] and video_key and identity["pairKey"] != video_key:
            raise ValueError("照片与视频的实况标识不同，不能配对")
        identity["pairKey"] = identity["pairKey"] or video_key
        if not identity["capturedAt"]:
            for field in EMPTY_CAPTURE:
                identity[field] = video_details[field]
    prefix = job["outputPrefix"]
    extracted = prefix + ".embedded.mp4"
    try:
        if photo and not video and job.get("photoExt") in ("jpg", "jpeg"):
            if embedded_video(photo, extracted):
                video = extracted
        if video and not photo:
            return {"kind": "original", **identity}
        if video:
            poster(photo, prefix + ".poster.jpg")
            run_ffmpeg(["-i", video, "-map", "0:v:0", "-map", "0:a:0?",
                        "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                        "-movflags", "+faststart", prefix + ".motion.mp4"])
            return {"kind": "live", **identity}
        if photo and job.get("photoExt") in ("heic", "heif"):
            poster(photo, prefix + ".poster.jpg")
            return {"kind": "converted-image", **identity}
        return {"kind": "original", **identity}
    finally:
        Path(extracted).unlink(missing_ok=True)

if __name__ == "__main__":
    try:
        job = json.loads(Path(sys.argv[1]).read_text("utf-8"))
        print(json.dumps(main(job), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        sys.exit(1)
