from pathlib import Path
import importlib.util, sys, json, io, uuid, subprocess, os, time, re
workspace=Path(__file__).resolve().parent.parent
root=workspace/"outputs"/"media-site"
spec=importlib.util.spec_from_file_location("capture_worker",root/"media-worker.py")
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
work=workspace/"work"/("capture-date-test-"+uuid.uuid4().hex[:8])
work.mkdir()
checks=[]
def photo(name, original=None, offset=None, digitized=None):
    image=worker.Image.new("RGB",(480,320),(94,145,108))
    exif=worker.Image.Exif()
    values={}
    if original:values[36867]=original
    if offset:values[36881]=offset
    if digitized:values[36868]=digitized
    if values:exif[34665]=values
    image.save(work/name,"HEIF" if name.endswith(".heic") else "JPEG",exif=exif)
    return work/name
dated=photo("arbitrary-filename.jpeg","2026:11:01 00:10:15","+09:00","2026:11:09 10:00:00")
details=worker.inspect_source(dated,"jpeg")
assert details["captureDate"]=="2026-11-01" and details["capturedAt"]=="2026-11-01T00:10:15+09:00"
assert details["captureTimeSource"]=="exif-original"
checks.append("Original EXIF capture time takes precedence and retains local day")
heic=photo("heic-original.heic","2025:04:05 18:40:00","-07:00")
assert worker.inspect_source(heic,"heic")["capturedAt"]=="2025-04-05T18:40:00-07:00"
checks.append("HEIC capture time extraction")
no_date=photo("no-date.jpeg")
assert worker.inspect_source(no_date,"jpeg")["captureDate"] is None
checks.append("Missing metadata remains unknown instead of using upload or modification time")
digitized=photo("digitized.jpeg",digitized="2024:02:29 12:30:00")
assert worker.inspect_source(digitized,"jpeg")["captureDate"]=="2024-02-29"
checks.append("Digitized timestamp fallback")
assert worker.capture_value("0000:00:00 00:00:00","test") is None
assert worker.capture_value("2025:02:29 00:00:00","test") is None
checks.append("Invalid dates rejected")
video=work/"motion.mov"
subprocess.run([worker.FFMPEG,"-y","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=green:s=320x240:r=24","-t","0.4","-c:v","libx264","-metadata","com.apple.quicktime.creationdate=2026-10-31T23:50:00-07:00","-movflags","use_metadata_tags",str(video)],capture_output=True,check=True)
assert worker.inspect_source(video,"mov")["captureDate"]=="2026-10-31"
checks.append("QuickTime creation date retains original timezone")
live=worker.main({"photo":str(dated),"photoExt":"jpeg","video":str(video),"videoExt":"mov","outputPrefix":str(work/"live")})
assert live["kind"]=="live" and live["captureDate"]=="2026-11-01"
checks.append("Live pairing uses photo capture time over video timestamp")
# Start with a preexisting record to exercise the metadata migration.
data=work/"data";(data/"files").mkdir(parents=True)
old_id=str(uuid.uuid4())
(data/"files"/(old_id+".jpeg")).write_bytes(dated.read_bytes())
(data/"library.json").write_text(json.dumps([{"id":old_id,"name":"hidden-name.jpeg","ext":"jpeg","kind":"image","size":dated.stat().st_size,"metadataVersion":1,"createdAt":"2026-11-10T00:00:00Z"}]),"utf8")
log=(work/"server.log").open("wb")
server=subprocess.Popen(["node",str(root/"server.js")],env={**os.environ,"PORT":"8794","MEDIA_DATA_DIR":str(data)},stdout=log,stderr=log,creationflags=worker.subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0)
try:
    import urllib.request
    for _ in range(50):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8794/api/library",timeout=1) as response:
                item=json.load(response)["items"][0]
            break
        except OSError:time.sleep(.1)
    else:raise AssertionError("Test server failed")
    assert item["captureDate"]=="2026-11-01" and item["createdAt"].startswith("2026-11-10")
    assert (data/"files"/(old_id+".jpeg")).read_bytes()==dated.read_bytes()
    checks.append("Existing library migrated using EXIF without altering original or upload timestamp")
finally:
    server.terminate();server.wait(timeout=10);log.close()
print(json.dumps({"passed":len(checks),"checks":checks},ensure_ascii=False,indent=2))
