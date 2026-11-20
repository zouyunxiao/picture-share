import sys
from pathlib import Path
import json
import os
import queue
import re
import subprocess
import shutil
import threading
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import uuid
import webbrowser
import core

LABELS = {"live":"◉ LIVE 实况", "missing":"实况 · 缺少动态", "image":"照片", "video":"视频"}
BG, GREEN, MUTED = "#f6f8f1", "#285b40", "#7b8979"
STATE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "MomentsImporter"

def size(value):
    return f"{value/1024**3:.2f} GB" if value >= 1024**3 else f"{value/1024**2:.1f} MB" if value >= 1024**2 else f"{value/1024:.0f} KB"

class Importer:
    def __init__(self, root):
        STATE.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.root.title("片刻 · 原片导入助手")
        self.root.geometry("1180x800")
        self.root.minsize(1010, 700)
        self.root.configure(bg=BG)
        self.events = queue.Queue()
        self.cancel = threading.Event()
        self.assets = []
        self.devices = []
        self.busy = False
        self.phone_id = None
        self.preview_asset = None
        self.cover = None
        self.preview_photo = None
        self.preview_generation = 0
        self.preview_process = None
        self.hold_timer = None
        self.cache = STATE / "originals"
        self.cache.mkdir(exist_ok=True)
        self.cancel_path = STATE / ("cancel-" + uuid.uuid4().hex)
        self.client = core.WebsiteClient()
        self.status = tk.StringVar(value="选择电脑原片，或连接 iPhone 后扫描。不会删除、修改手机和电脑上的原文件。")
        self.connection = tk.StringVar(value="尚未连接网站")
        self.summary = tk.StringVar(value="还没有选择媒体")
        self.preview_hint = tk.StringVar(value="选择一项查看封面 · 实况照片按住预览区播放，松开恢复")
        self.password = tk.StringVar()
        self._style()
        self._layout()
        self.root.after(60, self._drain)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _style(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure(".", font=("Microsoft YaHei UI", 10), background=BG, foreground="#294332")
        style.configure("TFrame", background=BG)
        style.configure("TLabel", background=BG)
        style.configure("Muted.TLabel", foreground=MUTED, font=("Microsoft YaHei UI", 9))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 25, "bold"))
        style.configure("TButton", padding=(13, 9), background="#e8eee0", borderwidth=0)
        style.map("TButton", background=[("active","#dce7d3"),("disabled","#edf0e7")])
        style.configure("Primary.TButton", background=GREEN, foreground="white", padding=(18, 10))
        style.map("Primary.TButton", background=[("active","#1e4731"),("disabled","#a3b79c")])
        style.configure("Treeview", rowheight=34, background="white", fieldbackground="white", borderwidth=0)
        style.configure("Treeview.Heading", background="#e7edde", font=("Microsoft YaHei UI", 10))
        style.map("Treeview", background=[("selected","#dceacf")], foreground=[("selected","#244833")])
        style.configure("TNotebook", background=BG, borderwidth=0)
        style.configure("TNotebook.Tab", padding=(18,10))
        style.configure("Horizontal.TProgressbar", background=GREEN, troughcolor="#e5ecd9", borderwidth=0)

    def _layout(self):
        shell = ttk.Frame(self.root, padding=26)
        shell.pack(fill="both", expand=True)
        top = ttk.Frame(shell)
        top.pack(fill="x")
        ttk.Label(top, text="◒  片刻", style="Title.TLabel").pack(side="left")
        ttk.Label(top, text="原片导入助手   /   照片 · LIVE · 视频", style="Muted.TLabel").pack(side="left", padx=22, pady=10)
        ttk.Button(top, text="打开网站 ↗", command=self.open_site).pack(side="right")
        connect = ttk.Frame(shell, padding=(0,18,0,16))
        connect.pack(fill="x")
        ttk.Label(connect, textvariable=self.connection, style="Muted.TLabel").pack(side="left")
        ttk.Label(connect, text="管理员密码", style="Muted.TLabel").pack(side="left", padx=(20,8))
        ttk.Entry(connect, textvariable=self.password, show="●", width=21).pack(side="left")
        ttk.Button(connect, text="连接", command=lambda: self.task(self.login)).pack(side="left", padx=8)
        ttk.Button(connect, text="启动网站", command=lambda: self.task(self.start_site)).pack(side="left")
        ttk.Label(connect, text="本机：http://127.0.0.1:8787", style="Muted.TLabel").pack(side="right")
        tabs = ttk.Notebook(shell)
        tabs.pack(fill="x")
        local = ttk.Frame(tabs, padding=(15,15))
        phone = ttk.Frame(tabs, padding=(15,15))
        tabs.add(local, text="电脑原片 / iCloud")
        tabs.add(phone, text="iPhone USB 导入")
        local_buttons = ttk.Frame(local)
        local_buttons.pack(fill="x")
        self.local_folder = ttk.Button(local_buttons, text="选择原片文件夹", style="Primary.TButton", command=self.choose_folder)
        self.local_folder.pack(side="left")
        self.local_files = ttk.Button(local_buttons, text="选择照片与视频", command=self.choose_files)
        self.local_files.pack(side="left", padx=10)
        ttk.Label(local, text="支持 HEIC/JPEG＋MOV/MP4 配对及内嵌实况 JPG。优先检查内部实况标识，只有照片时会明确提示缺少动态。", style="Muted.TLabel", wraplength=1050).pack(anchor="w", pady=(12,0))
        phone_buttons = ttk.Frame(phone)
        phone_buttons.pack(fill="x")
        ttk.Button(phone_buttons, text="刷新手机", command=lambda: self.task(self.refresh_devices)).pack(side="left")
        self.device_box = ttk.Combobox(phone_buttons, state="readonly", width=30)
        self.device_box.pack(side="left", padx=10)
        ttk.Button(phone_buttons, text="扫描手机原片", style="Primary.TButton", command=lambda: self.task(self.scan_phone)).pack(side="left")
        ttk.Label(phone, text="USB 连接 → 解锁 → 信任此电脑。建议在 iPhone 的“照片”设置中选择“传输到 Mac 或 PC：保留原片”。\n只会读取你选中的原片；不会删除手机照片。iCloud 原片需先下载到手机。手机文件复制到电脑后才可预览。", style="Muted.TLabel", wraplength=1050).pack(anchor="w", pady=(12,0))
        info = ttk.Frame(shell, padding=(0,16,0,10))
        info.pack(fill="x")
        ttk.Label(info, textvariable=self.summary).pack(side="left")
        ttk.Label(info, text="Ctrl / Shift 多选；默认导入选中项", style="Muted.TLabel").pack(side="right")
        body = ttk.Panedwindow(shell, orient="horizontal")
        body.pack(fill="both", expand=True)
        listing = ttk.Frame(body)
        preview = ttk.Frame(body, padding=(18,0,0,0))
        body.add(listing, weight=5)
        body.add(preview, weight=4)
        self.tree = ttk.Treeview(listing, columns=("kind","name","size","status"), show="headings", selectmode="extended")
        for key, title, width in (("kind","类型",140),("name","原片文件名",190),("size","大小",80),("status","状态",135)):
            self.tree.heading(key, text=title)
            self.tree.column(key, width=width, minwidth=65, stretch=key in ("name","status"))
        scroll = ttk.Scrollbar(listing, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.select_preview)
        self.canvas = tk.Canvas(preview, width=400, height=270, bg="#e6edde", highlightthickness=0, cursor="hand2")
        self.canvas.pack(fill="x")
        self.canvas.create_text(200,130,text="◒",font=("Segoe UI",64),fill="#9ab18a")
        self.canvas.bind("<ButtonPress-1>", self.hold)
        self.canvas.bind("<ButtonRelease-1>", lambda e: self.stop_preview())
        self.canvas.bind("<Leave>", lambda e: self.stop_preview())
        self.root.bind("<FocusOut>", lambda e: self.root.after(0, self._check_focus))
        ttk.Label(preview, textvariable=self.preview_hint, style="Muted.TLabel", wraplength=400).pack(anchor="w", pady=12)
        ttk.Label(preview, text="Live 原片会保留照片和视频两部分。\n导入网站后，可在手机网页中长按播放。\n若显示“缺少动态”，说明还没有拿到配对视频。", style="Muted.TLabel", wraplength=400).pack(anchor="w", pady=(4,12))
        ttk.Button(preview, text="用默认软件打开选中原片", command=self.open_original).pack(anchor="w")
        actions = ttk.Frame(shell, padding=(0,15,0,10))
        actions.pack(fill="x")
        ttk.Button(actions, text="全选", command=lambda:self.tree.selection_set(self.tree.get_children())).pack(side="left")
        ttk.Button(actions, text="取消选择", command=lambda:self.tree.selection_remove(self.tree.selection())).pack(side="left", padx=8)
        self.import_button = ttk.Button(actions, text="导入选中原片到网站 ↗", style="Primary.TButton", command=lambda:self.task(self.import_selected))
        self.import_button.pack(side="right")
        ttk.Button(actions, text="取消当前任务", command=self.cancel_task).pack(side="right", padx=10)
        self.progress = ttk.Progressbar(shell, mode="determinate", maximum=100)
        self.progress.pack(fill="x")
        ttk.Label(shell, textvariable=self.status, style="Muted.TLabel", wraplength=1100).pack(anchor="w", pady=(10,0))

    def emit(self, function, *args):
        self.events.put((function, args))

    def _drain(self):
        for _ in range(80):
            try:
                function, args = self.events.get_nowait()
            except queue.Empty:
                break
            try:
                function(*args)
            except tk.TclError:
                pass
        self.root.after(35, self._drain)

    def task(self, function, *args):
        if self.busy:
            self.status.set("请等待当前任务完成，或点击“取消当前任务”。")
            return
        self.busy = True
        self.cancel.clear()
        self.cancel_path.unlink(missing_ok=True)
        self.stop_preview()
        self.import_button.state(["disabled"])
        # Capture UI input before starting the worker thread.
        inputs = {"password":self.password.get(), "selection":list(self.tree.selection()), "device":self.device_box.current()}
        def execute():
            try:
                function(inputs, *args)
            except Exception as error:
                self.emit(self.status.set, str(error))
                self.emit(messagebox.showerror, "片刻 · 导入提示", str(error))
            finally:
                self.emit(self.finish)
        threading.Thread(target=execute, daemon=True).start()

    def finish(self):
        self.busy = False
        self.import_button.state(["!disabled"])

    def update_progress(self, value):
        self.emit(self.status.set, value)

    def login(self, inputs):
        password = inputs["password"]
        if not password and core.SITE:
            info = core.SITE / "登录信息.txt"
            if info.exists():
                match = re.search(r"管理员密码：([^\r\n]+)", info.read_text("utf-8-sig"))
                password = match[1] if match else ""
        if not password:
            raise RuntimeError("请输入网站管理员密码；密码不会保存在软件中。")
        self.client.login(password)
        library = self.client.request("/api/library")
        self.emit(self.connection.set, f"● 已连接 · 网站现有 {len(library['items'])} 个片刻")
        self.update_progress("网站连接成功，可以导入原片。")

    def start_site(self, inputs):
        if not core.SITE:
            raise RuntimeError("未找到 media-site 文件夹。请把软件与原有网站保留在 outputs 目录中，或先手动启动网站。")
        self.update_progress("正在启动本地网站和公网隧道…")
        result = subprocess.run(["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File",str(core.SITE/"start.ps1")],
                                capture_output=True, creationflags=core.NO_WINDOW, timeout=180)
        if result.returncode:
            raise RuntimeError("网站启动未完成，请查看网站 data 文件夹中的日志。")
        self.login(inputs)

    def choose_folder(self):
        if self.busy:
            return
        folder = filedialog.askdirectory(title="选择包含完整照片与配对视频的原片文件夹")
        if folder:
            self.task(self.scan_local, [folder])

    def choose_files(self):
        if self.busy:
            return
        files = filedialog.askopenfilenames(title="选择照片与视频原片", filetypes=[("照片和视频","*.heic *.heif *.jpg *.jpeg *.png *.gif *.webp *.avif *.mov *.mp4 *.m4v *.webm"),("所有文件","*.*")])
        if files:
            self.task(self.scan_local, list(files))

    def scan_local(self, inputs, paths):
        self.update_progress("正在检查原片中的实况标识…")
        assets = core.inspect_paths(paths, self.update_progress, self.cancel.is_set)
        self.phone_id = None
        self.emit(self.set_assets, assets)

    def set_assets(self, assets):
        self.assets = assets
        self.tree.delete(*self.tree.get_children())
        for asset in assets:
            self.tree.insert("", "end", iid=asset.key, values=(LABELS[asset.kind], asset.name, size(asset.size), asset.status))
        counts = {kind:sum(a.kind==kind for a in assets) for kind in LABELS}
        self.summary.set(f"{len(assets)} 项   ·   LIVE {counts['live']}   ·   照片 {counts['image']}   ·   视频 {counts['video']}   ·   缺少动态 {counts['missing']}")
        self.status.set("扫描完成。请选择需要导入的原片。手机名称配对会在复制后再次检查内部标识。" if self.phone_id else "扫描完成。选择一项可预览，勾选需要导入的原片。")

    def usb(self, request, handler):
        request["cancelPath"] = str(self.cancel_path)
        path = STATE / ("usb-request-" + uuid.uuid4().hex + ".json")
        path.write_text(json.dumps(request, ensure_ascii=False), "utf-8")
        try:
            process = subprocess.Popen(["powershell.exe","-STA","-NoProfile","-ExecutionPolicy","Bypass","-File",str(core.resource("usb-helper.ps1")),"-RequestPath",str(path)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=core.NO_WINDOW)
            for line in process.stdout:
                try:
                    event = json.loads(line.decode("utf-8-sig"))
                except (ValueError, UnicodeError):
                    continue
                if event["type"] == "error":
                    raise RuntimeError(event["message"])
                handler(event)
            error = process.stderr.read()
            process.wait(timeout=15)
            if process.returncode:
                raise RuntimeError("无法访问手机，请解锁并信任此电脑后重试。" + error.decode("utf-8","replace")[-300:])
        finally:
            path.unlink(missing_ok=True)

    def refresh_devices(self, inputs):
        self.update_progress("正在检测 USB 连接的 iPhone…")
        devices = []
        self.usb({"mode":"list"},lambda e:devices.append(e) if e["type"]=="device" else None)
        self.devices = devices
        self.emit(self.set_devices, devices)

    def set_devices(self, devices):
        self.device_box["values"] = [device["name"] for device in devices]
        if devices:
            self.device_box.current(0)
            self.status.set("已检测到 iPhone。点击“扫描手机原片”，再选择需要导入的项目。")
        else:
            self.device_box.set("")
            self.status.set("尚未检测到 iPhone。请用支持数据传输的 USB 线连接，解锁并信任此电脑；必要时安装 Apple Devices。")

    def scan_phone(self, inputs):
        index = inputs["device"]
        if index < 0 or index >= len(self.devices):
            raise RuntimeError("请先点击“刷新手机”，检测并选择已连接的 iPhone。")
        device = self.devices[index]
        files = []
        def receive(event):
            if event["type"] == "file":
                files.append(core.MediaFile(event["name"], event["size"], segments=event["segments"]))
                self.update_progress(f"已发现 {len(files)} 个手机原片 · {event['name']}")
        self.update_progress("正在读取手机原片列表；如果没有内容，请检查手机是否已解锁。")
        self.usb({"mode":"scan","deviceId":device["id"]},receive)
        self.phone_id = device["id"]
        self.emit(self.set_assets, core.group_files(files))

    def import_selected(self, inputs):
        selected = [asset for asset in self.assets if asset.key in inputs["selection"]]
        if not selected:
            raise RuntimeError("请先选择需要导入的项目，或点击“全选”。")
        self.login(inputs)
        if self.phone_id:
            flat = [file for asset in selected for file in asset.files]
            required = sum(file.size for file in flat) + 512 * 1024**2
            if shutil.disk_usage(self.cache).free < required:
                raise RuntimeError("电脑剩余空间不足以保存选中的手机原片，请减少本次选择或清理空间。")
            destination = self.cache / ("iPhone-" + time.strftime("%Y%m%d-%H%M%S"))
            copied = {}
            def receive(event):
                if event["type"]=="progress":
                    self.update_progress(event["message"])
                elif event["type"]=="copied":
                    copied[event["index"]] = event["path"]
            self.usb({"mode":"copy","deviceId":self.phone_id,"destination":str(destination),
                      "files":[{"segments":file.segments} for file in flat]},receive)
            if self.cancel.is_set():
                self.update_progress("已取消。已复制的原片保留在本机缓存中，手机原片未改动。")
                return
            if len(copied) != len(flat):
                raise RuntimeError("部分手机原片尚未复制完成，请解锁手机后重新扫描。")
            for index, file in enumerate(flat):
                file.path = copied[index]
                file.size = Path(file.path).stat().st_size
            selected = core.inspect_paths([file.path for file in flat], self.update_progress, self.cancel.is_set)
            self.phone_id = None
            self.emit(self.set_assets, selected)
        success = 0
        failures = 0
        for index, asset in enumerate(selected):
            if self.cancel.is_set():
                break
            self.emit(self.row_status, asset, "正在上传")
            self.update_progress(f"导入 {index+1}/{len(selected)} · {asset.name}")
            try:
                result = self.client.upload(asset, lambda value:self.emit(self.item_progress, asset, value), self.cancel.is_set)
                status = "LIVE 已发布" if result["kind"]=="live" else "缺少动态 · 照片已保存" if result.get("liveState")=="missing-motion" else "已发布"
                success += 1
                self.emit(self.row_status, asset, status)
            except Exception as error:
                failures += 1
                self.emit(self.row_status, asset, str(error))
                if self.cancel.is_set():
                    break
        self.update_progress(f"导入完成：成功 {success} 项，失败 {failures} 项。原始文件已保留。打开网站可浏览和长按播放。")

    def row_status(self, asset, text):
        asset.status = text
        if self.tree.exists(asset.key):
            values = list(self.tree.item(asset.key, "values"))
            values[3] = text
            self.tree.item(asset.key, values=values)

    def item_progress(self, asset, value):
        self.row_status(asset, f"{value}%" if isinstance(value,int) else value)
        if isinstance(value,int):
            self.progress["value"] = value

    def cancel_task(self):
        self.cancel.set()
        self.cancel_path.touch()
        self.status.set("正在取消。已开始的单个手机复制或网站处理会完成后停止；原片保留。")

    def select_preview(self, event=None):
        selected = self.tree.selection()
        if not selected:
            return
        asset = next((a for a in self.assets if a.key==selected[0]),None)
        if not asset:
            return
        self.stop_preview()
        self.preview_asset = asset
        self.cover = None
        self.canvas.delete("all")
        self.canvas.create_text(200,130,text="◒",font=("Segoe UI",64),fill="#9ab18a")
        token = self.preview_generation
        source = asset.files[0]
        if not source.path:
            self.preview_hint.set("手机原片尚未复制到电脑。导入后可以预览，原片会保留在本机缓存中。")
            return
        self.preview_hint.set("正在读取封面…")
        def cover():
            try:
                if source.ext in core.PHOTO_EXTS:
                    with core.Image.open(source.path) as image:
                        image = core.ImageOps.exif_transpose(image).convert("RGB")
                        image.thumbnail((480,300))
                        result = core.Image.new("RGB",(480,300),(230,237,222))
                        result.paste(image,((480-image.width)//2,(300-image.height)//2))
                else:
                    frame = subprocess.run([core.FFMPEG,"-hide_banner","-loglevel","error","-i",source.path,"-frames:v","1","-vf","scale=480:300:force_original_aspect_ratio=decrease,pad=480:300:(ow-iw)/2:(oh-ih)/2","-f","image2pipe","-vcodec","png","pipe:1"],capture_output=True,creationflags=core.NO_WINDOW,timeout=30)
                    import io
                    result = core.Image.open(io.BytesIO(frame.stdout)).convert("RGB")
                self.emit(self.set_cover, result, token, asset)
            except Exception:
                self.emit(self.preview_hint.set,"此文件封面暂时无法预览；仍可导入或用默认软件打开。")
        threading.Thread(target=cover,daemon=True).start()

    def set_cover(self, image, token, asset):
        if token != self.preview_generation:
            return
        self.cover = image
        self.draw(image)
        self.preview_hint.set("◉ LIVE · 按住播放，松开恢复封面，再次按住从头播放。默认静音。" if asset.kind=="live" else "视频 · 按住预览区播放，松开停止。" if asset.kind=="video" else "这张实况照片缺少配对视频，无法播放。" if asset.kind=="missing" else "静态照片")

    def draw(self, image):
        width = max(1,self.canvas.winfo_width())
        height = max(1,self.canvas.winfo_height())
        shown = image.copy()
        shown.thumbnail((width,height))
        self.preview_photo = core.ImageTk.PhotoImage(shown)
        self.canvas.delete("all")
        self.canvas.create_image(width//2,height//2,image=self.preview_photo)
        if self.preview_asset and self.preview_asset.kind=="live":
            self.canvas.create_rectangle(9,9,80,32,fill="#294332",outline="")
            self.canvas.create_text(44,20,text="◉ LIVE",fill="white",font=("Segoe UI",10,"bold"))

    def hold(self, event):
        asset = self.preview_asset
        if not asset or asset.kind not in ("live","video") or not asset.files[0].path:
            return
        self.hold_timer = self.root.after(220, self.play_preview)

    def play_preview(self):
        self.hold_timer = None
        asset = self.preview_asset
        token = self.preview_generation
        def decode():
            video = next((file.path for file in asset.files if file.ext in core.VIDEO_EXTS),"")
            temporary_video = None
            try:
                if not video and asset.files[0].embedded:
                    video = str(self.cache / ("preview-" + uuid.uuid4().hex + ".mp4"))
                    temporary_video = video
                    if not core.media_worker.embedded_video(asset.files[0].path,video):
                        return
                if not video:
                    return
                process = subprocess.Popen([core.FFMPEG,"-hide_banner","-loglevel","error","-re","-i",video,"-an","-vf","scale=480:300:force_original_aspect_ratio=decrease,pad=480:300:(ow-iw)/2:(oh-ih)/2,fps=24","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=core.NO_WINDOW)
                if token != self.preview_generation:
                    process.terminate(); return
                self.preview_process = process
                while token == self.preview_generation:
                    frame = process.stdout.read(480*300*3)
                    if len(frame)!=480*300*3:
                        break
                    image = core.Image.frombytes("RGB",(480,300),frame)
                    self.emit(self.draw_frame,image,token)
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
            except (OSError,ValueError,subprocess.SubprocessError):
                pass
            finally:
                if temporary_video:
                    try:
                        Path(temporary_video).unlink(missing_ok=True)
                    except OSError:
                        pass
        threading.Thread(target=decode,daemon=True).start()

    def draw_frame(self, image, token):
        if token == self.preview_generation:
            self.draw(image)

    def stop_preview(self):
        if self.hold_timer:
            self.root.after_cancel(self.hold_timer)
            self.hold_timer = None
        self.preview_generation += 1
        if self.preview_process and self.preview_process.poll() is None:
            self.preview_process.terminate()
        self.preview_process = None
        if self.cover:
            self.draw(self.cover)

    def _check_focus(self):
        if self.root.focus_displayof() is None:
            self.stop_preview()

    def open_original(self):
        if self.preview_asset and self.preview_asset.files[0].path:
            os.startfile(self.preview_asset.files[0].path)

    def open_site(self):
        public_url = core.SITE / "公网地址.txt" if core.SITE else None
        if public_url and public_url.exists():
            value = public_url.read_text("utf-8-sig").splitlines()[0]
            if value.startswith("https://") and value.endswith(".trycloudflare.com"):
                webbrowser.open(value)
                return
        webbrowser.open("http://localhost:8787")

    def close(self):
        if self.busy and not messagebox.askokcancel("片刻","当前任务尚未完成。关闭会停止后续导入，已复制原片仍保留。确定关闭吗？"):
            return
        self.cancel_task()
        self.stop_preview()
        self.root.destroy()

def main():
    # A packaged self-check verifies the native build without creating UI or touching photos.
    if "--self-check" in sys.argv:
        result = {"ffmpeg_available":Path(core.FFMPEG).is_file(),"usb_helper_available":core.resource("usb-helper.ps1").is_file(),"website_found":core.SITE is not None}
        import io
        sample = io.BytesIO()
        core.Image.new("RGB",(32,32),(100,150,90)).save(sample,"HEIF")
        sample.seek(0)
        with core.Image.open(sample) as decoded:
            result["heic_decoder_available"] = decoded.size == (32,32)
        frame = subprocess.run([core.FFMPEG,"-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=green:s=64x64","-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],
                               capture_output=True,creationflags=core.NO_WINDOW,timeout=15)
        result["video_decoder_available"] = frame.returncode == 0 and len(frame.stdout) == 64*64*3
        path = Path(sys.argv[sys.argv.index("--self-check")+1])
        path.write_text(json.dumps(result,ensure_ascii=False),"utf-8")
        if not all(result.values()):
            sys.exit(2)
        return
    root = tk.Tk()
    Importer(root)
    root.mainloop()

if __name__=="__main__":
    main()
