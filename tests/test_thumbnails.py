from pathlib import Path
import sys,json,uuid,subprocess,os,time,urllib.request,urllib.error,io,hashlib,http.cookiejar,re
from concurrent.futures import ThreadPoolExecutor
root=Path(__file__).resolve().parent.parent
site=root/"outputs/media-site";sys.path.insert(0,str(site/"tools/python"))
from PIL import Image
data=root/"work"/("thumbnail-test-"+uuid.uuid4().hex[:8]);(data/"files").mkdir(parents=True)
identifier=str(uuid.uuid4());source=data/"files"/(identifier+".jpeg")
image=Image.effect_noise((600,1200),65).convert("RGB");exif=Image.Exif();exif[274]=6
image.save(source,"JPEG",quality=95,exif=exif)
original=source.read_bytes()
multi_id=str(uuid.uuid4());multi_source=data/"files"/(multi_id+".jpeg")
Image.new("RGB",(800,600),(190,50,40)).save(multi_source,"MPO",save_all=True,append_images=[Image.new("RGB",(400,300),(20,40,210))])
multi_original=multi_source.read_bytes()
legacy=data/"thumbnails"/(multi_id+".webp");legacy.parent.mkdir(exist_ok=True)
Image.new("RGB",(640,480),(20,40,210)).save(legacy,"WEBP")
(data/"library.json").write_text(json.dumps([
 {"id":identifier,"name":"test.jpeg","ext":"jpeg","kind":"image","size":len(original),"metadataVersion":2},
 {"id":multi_id,"name":"apple.jpeg","ext":"jpeg","kind":"image","size":len(multi_original),"metadataVersion":2,"liveState":"missing-motion"}
]),"utf8")
log=(data/"server.log").open("wb")
server=subprocess.Popen(["node",str(site/"server.js")],env={**os.environ,"PORT":"8792","MEDIA_DATA_DIR":str(data)},stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
url="http://127.0.0.1:8792";checks=[]
try:
 for _ in range(50):
  try:
   with urllib.request.urlopen(url+"/api/library",timeout=1) as response:records=json.load(response)["items"];record=records[0]
   break
  except OSError:time.sleep(.1)
 else:raise AssertionError("Thumbnail test server failed")
 assert record["thumbnailUrl"]==f"/media/{identifier}/thumbnail?v=still-2";checks.append("API publishes versioned thumbnail URL")
 def fetch():
  with urllib.request.urlopen(url+record["thumbnailUrl"],timeout=30) as response:
   return response.read(),dict(response.headers)
 with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:fetch(),range(2)))
 first,headers=results[0]
 assert first==results[1][0] and headers["Content-Type"]=="image/webp"
 checks.append("Concurrent thumbnail requests share a valid cached result")
 with Image.open(io.BytesIO(first)) as thumbnail:assert thumbnail.size==(640,320)
 checks.append("Thumbnail respects EXIF orientation and dimension limit")
 assert len(first)<len(original)/3;checks.append("Thumbnail substantially smaller than original")
 assert source.read_bytes()==original;checks.append("Original bytes remain unchanged")
 cached=data/"thumbnails/still-2"/(identifier+".webp");mtime=cached.stat().st_mtime_ns
 assert fetch()[0]==first and cached.stat().st_mtime_ns==mtime
 assert "immutable" in headers["Cache-Control"];checks.append("Repeated reads reuse immutable cache")
 with urllib.request.urlopen(urllib.request.Request(url+record["thumbnailUrl"],method="HEAD"),timeout=10) as response:
  assert int(response.headers["Content-Length"])==len(first) and not response.read()
 checks.append("HEAD serves thumbnail metadata")
 display_path=data/"previews/still-2"/(identifier+".jpg")
 with urllib.request.urlopen(url+record["displayUrl"],timeout=10) as response:
  with Image.open(io.BytesIO(response.read())) as display:assert display.size==(1200,600)
 checks.append("Display uses the same EXIF-correct orientation as its thumbnail")
 multi=records[1]
 assert multi["kind"]=="image" and "motionUrl" not in multi and multi["displayUrl"].endswith("/display?v=still-2")
 checks.append("Still-only former Live photo has no motion resource")
 def read_route(route):
  with urllib.request.urlopen(url+route,timeout=30) as response:return response.read()
 with ThreadPoolExecutor(max_workers=2) as pool:
  decoded=list(pool.map(read_route,[multi["thumbnailUrl"],multi["displayUrl"]]))
 with Image.open(io.BytesIO(decoded[0])) as thumb,Image.open(io.BytesIO(decoded[1])) as display:
  thumbnail_pixel=thumb.convert("RGB").getpixel((100,100));display_pixel=display.convert("RGB").getpixel((100,100))
  assert thumbnail_pixel[0]>150 and thumbnail_pixel[2]<80
  assert display_pixel[0]>150 and display_pixel[2]<80 and getattr(display,"n_frames",1)==1
  assert max(abs(a-b) for a,b in zip(thumbnail_pixel,display_pixel))<8
 checks.append("MPO thumbnail and detail use primary still instead of the blue auxiliary image")
 assert decoded[0]!=legacy.read_bytes();checks.append("Old cached wrong cover is bypassed")
 assert multi_source.read_bytes()==multi_original;checks.append("Multi-image original is preserved byte for byte")
 assert read_route(multi["displayUrl"])==decoded[1]
 checks.append("Repeated detail reads cannot switch to an auxiliary frame")
 pwd=re.search("管理员密码：([^\\r\\n]+)",(data/"登录信息.txt").read_text("utf8")).group(1)
 client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 client.open(urllib.request.Request(url+"/api/login",data=json.dumps({"password":pwd}).encode(),headers={"Content-Type":"application/json"})).close()
 client.open(urllib.request.Request(url+"/api/media/"+identifier,method="DELETE")).close()
 assert not cached.exists() and not display_path.exists();checks.append("Deleting media removes thumbnail and display copies")
 print(json.dumps({"passed":len(checks),"originalBytes":len(original),"thumbnailBytes":len(first),"checks":checks},ensure_ascii=False,indent=2))
finally:
 server.terminate();server.wait(timeout=10);log.close()
