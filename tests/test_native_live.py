"""Isolated regression tests: never edits the user's photo library."""
from pathlib import Path
import sys, os, json, struct, uuid, subprocess, time, urllib.request, urllib.error, http.cookiejar, re, io
root = Path(__file__).resolve().parent.parent / "outputs" / "media-site"
sys.path.insert(0, str(root / "tools" / "python"))
from PIL import Image
import imageio_ffmpeg
work = Path(__file__).resolve().parent.parent / "work" / ("native-live-test-" + uuid.uuid4().hex[:8])
work.mkdir()
data = work / "data"
(data / "files").mkdir(parents=True)
old_id = str(uuid.uuid4())
key1, key2, key3 = (str(uuid.uuid4()) for _ in range(3))

def jpeg(key=None):
    image = Image.new("RGB", (320, 240), (123, 165, 112))
    buffer = io.BytesIO()
    if key:
        value = key.encode("ascii") + b"\0"
        maker = b"Apple iOS\0\0\1MM" + struct.pack(">H", 1) + struct.pack(">HHII", 17, 2, len(value), 32) + b"\0" * 4 + value
        exif = Image.Exif()
        exif[34665] = {37500:maker}
        image.save(buffer, "JPEG", exif=exif)
    else:
        image.save(buffer, "JPEG")
    return buffer.getvalue()

def movie(key=None):
    target = work / ("video-" + uuid.uuid4().hex + ".mov")
    args = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-t", "0.5", "-c:v", "libx264"]
    if key:
        args += ["-metadata", f"com.apple.quicktime.content.identifier={key}", "-movflags", "use_metadata_tags"]
    subprocess.run(args + [str(target)], capture_output=True, check=True)
    return target.read_bytes()

old_bytes = jpeg(key3)
(data / "files" / (old_id + ".jpeg")).write_bytes(old_bytes)
(data / "library.json").write_text(json.dumps([{"id":old_id,"name":"existing.jpeg","ext":"jpeg","kind":"image","size":len(old_bytes),"createdAt":"2026-11-10T00:00:00Z"}]), "utf8")
env = {**os.environ, "PORT":"8798", "MEDIA_DATA_DIR":str(data)}
log = (work / "server.log").open("wb")
server = subprocess.Popen(["node", str(root / "server.js")], env=env, stdout=log, stderr=log,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
base = "http://127.0.0.1:8798"
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
checks = []
def request(route, data=None, method="GET"):
    headers = {}
    if isinstance(data, dict):
        data = json.dumps(data).encode(); headers["Content-Type"] = "application/json"
    try:
        with client.open(urllib.request.Request(base+route, data=data, headers=headers, method=method), timeout=30) as res:
            raw=res.read()
            return res.status, json.loads(raw) if res.headers.get("Content-Type","").startswith("application/json") else raw
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())
def post(route, value, expected=201):
    status, result=request(route,value,"POST")
    assert status==expected,(status,result)
    return result
def stage(name, content):
    result=post("/api/uploads",{"name":name,"size":len(content),"purpose":"auto"})
    uid=result["id"]
    status,_=request(f"/api/uploads/{uid}?offset=0",content,"PUT");assert status==200
    post(f"/api/uploads/{uid}/complete",{},200)
    return uid
def load(name, content):
    return post("/api/import",{"ids":[stage(name,content)]})
try:
    for _ in range(50):
        try:
            request("/api/library")
            break
        except (OSError,urllib.error.URLError):
            time.sleep(.2)
    else:
        raise AssertionError("Test server startup failed")
    password=re.search("管理员密码：([^\\r\\n]+)",(data/"登录信息.txt").read_text("utf8")).group(1)
    post("/api/login",{"password":password},200)
    existing=request("/api/library")[1]["items"][0]
    assert existing["liveState"]=="missing-motion" and "pairKey" not in existing
    checks.append("Existing Apple-tagged JPEG reclassified as missing motion without changing original")
    still=load("photo_A.jpeg",jpeg(key1))
    assert still["liveState"]=="missing-motion" and still["kind"]=="image"
    checks.append("Apple MakerNote Live Photo identifier detected")
    motion=movie(key1)
    live=load("completely_different_name.mov",motion)
    assert live["kind"]=="live" and live["name"]=="photo_A.jpeg"
    assert not any(x["id"]==still["id"] for x in request("/api/library")[1]["items"])
    checks.append("Different names and separate batches pair by native content identifier")
    assert (data/"files"/(still["id"]+".jpeg")).read_bytes()==jpeg(key1)
    checks.append("Previously uploaded original retained during repair")
    plain=load("plain.jpeg",jpeg())
    assert plain["kind"]=="image" and not plain.get("liveState")
    checks.append("Ordinary JPEG has no false Live warning")
    before=load("same_name.jpeg",jpeg())
    by_name=load("same_name.mov",movie())
    assert by_name["kind"]=="live"
    checks.append("Later upload pairs by matching filename when native identifier is absent")
    before=load("video_first.mov",movie())
    inverse=load("video_first.jpeg",jpeg())
    assert inverse["kind"]=="live"
    checks.append("Video-first separate upload also combines")
    a=stage("mismatch.jpeg",jpeg(key2));b=stage("mismatch.mov",movie(key3))
    status,result=request("/api/import",{"ids":[a,b]},"POST")
    assert status==422
    checks.append("Contradictory native identifiers reject pairing")
    assert (data/"files"/(old_id+".jpeg")).read_bytes()==old_bytes
    checks.append("Existing library photo bytes unchanged")
    print(json.dumps({"passed":len(checks),"checks":checks},ensure_ascii=False,indent=2))
finally:
    server.terminate()
    server.wait(timeout=15)
    log.close()
