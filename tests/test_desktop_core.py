from pathlib import Path
import sys, json, struct, io, uuid, subprocess, os, time, re
workspace = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(workspace/"outputs"/"media-desktop"/"source"))
import core
fixtures = workspace/"work"/"desktop-fixtures"
fixtures.mkdir(exist_ok=True)
key=str(uuid.uuid4())
def photo(name, identity=None):
    image=core.Image.new("RGB",(480,320),(107,151,94))
    if identity:
        value=identity.encode()+b"\0"
        maker=b"Apple iOS\0\0\1MM"+struct.pack(">H",1)+struct.pack(">HHII",17,2,len(value),32)+b"\0"*4+value
        exif=core.Image.Exif();exif[34665]={37500:maker}
        image.save(fixtures/name,"JPEG",exif=exif)
    else:image.save(fixtures/name,"JPEG")
photo("照片原片.jpeg",key)
photo("缺少动态.jpeg",str(uuid.uuid4()))
photo("静态照片.jpeg")
video=fixtures/"不同名称动态.mov"
subprocess.run([core.FFMPEG,"-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=480x320:rate=24","-t","0.6","-c:v","libx264","-metadata",f"com.apple.quicktime.content.identifier={key}","-movflags","use_metadata_tags",str(video)],capture_output=True,check=True)
subprocess.run([core.FFMPEG,"-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=480x320:rate=24","-t","0.6","-c:v","libx264",str(fixtures/"普通视频.mp4")],capture_output=True,check=True)
assets=core.inspect_paths([fixtures])
assert len(assets)==4,[(a.name,a.kind) for a in assets]
counts={kind:sum(a.kind==kind for a in assets) for kind in ["live","image","missing","video"]}
assert counts=={"live":1,"image":1,"missing":1,"video":1},counts
ambiguous=core.group_files([core.MediaFile("a.jpeg",1,pair_key="x"),core.MediaFile("b.jpeg",1,pair_key="x"),core.MediaFile("c.mov",1,pair_key="x")])
assert not any(a.kind=="live" for a in ambiguous)
conflicting=core.group_files([core.MediaFile("a.jpeg",1,pair_key="x"),core.MediaFile("a.mov",1,pair_key="y")])
assert not any(a.kind=="live" for a in conflicting)
duplicate_paths=core.inspect_paths([fixtures,fixtures/"静态照片.jpeg"])
assert len(duplicate_paths)==4
data=workspace/"work"/("desktop-client-test-"+uuid.uuid4().hex[:8])
data.mkdir()
env={**os.environ,"PORT":"8799","MEDIA_DATA_DIR":str(data)}
with (data/"server.log").open("wb") as log:
    server=subprocess.Popen(["node",str(core.SITE/"server.js")],env=env,stdout=log,stderr=log,creationflags=core.NO_WINDOW)
    try:
        client=core.WebsiteClient("http://127.0.0.1:8799")
        for _ in range(50):
            try:client.request("/api/library");break
            except Exception:time.sleep(.1)
        password=re.search("管理员密码：([^\\r\\n]+)",(data/"登录信息.txt").read_text("utf8")).group(1)
        client.login(password)
        live=next(a for a in assets if a.kind=="live")
        result=client.upload(live)
        assert result["kind"]=="live"
        missing=client.upload(next(a for a in assets if a.kind=="missing"))
        assert missing["liveState"]=="missing-motion"
        assert len(client.request("/api/library")["items"])==2
        # Test upgrade of a previously imported still when complete originals arrive.
        prior=client.upload(core.Asset([live.files[0]],"missing"))
        repaired=client.upload(live)
        library=client.request("/api/library")["items"]
        assert not any(a["id"]==prior["id"] for a in library)
        assert repaired["kind"]=="live"
    finally:
        server.terminate();server.wait(timeout=10)
print(json.dumps({"fixture_counts":counts,"checks":["native identifier pairing","missing motion detection","static and video classification","ambiguous and conflicting identifiers kept apart","duplicate path suppression","authenticated chunk upload","real backend Live import","complete originals repair prior JPEG"],"passed":8},ensure_ascii=False,indent=2))
