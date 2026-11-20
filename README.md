# 片刻 · 照片分享网站

本仓库保存网站、Windows 原片导入助手的源码和测试。
照片、视频、管理员配置、登录信息、预览截图、打包程序和随包运行环境均留在本地，不提交到 Git。
原有的“开始使用.md”和“打包验证.md”描述完整备份包；从 Git 克隆后请按本文安装依赖。

## 从源码运行网站

在 Windows 上安装 Node.js 和 Python 3.12（含 pip），确保 `node`、`python` 命令可用。
在项目根目录执行：

```powershell
python -m pip install -r outputs/media-site/requirements-live.txt
node outputs/media-site/server.js
```

打开 `http://localhost:8787`。首次启动会自动创建空照片库，
管理员密码写入 `outputs/media-site/登录信息.txt`；这些本地数据均已加入忽略规则。
媒体解码由 Python 处理；如需指定解释器，可在启动前设置 `$env:PYTHON` 为 Python 可执行文件的完整路径。

需要公网访问时，运行根目录的 `启动网站.cmd`。
启动脚本会按需下载 Cloudflare 隧道工具，生成的地址写入 `outputs/media-site/公网地址.txt`。

## 从源码运行或打包导入助手

网站启动后，在项目根目录执行：

```powershell
python -m pip install -r outputs/media-desktop/source/requirements-build.txt
python outputs/media-desktop/source/app.py
```

运行 `outputs/media-desktop/source/重新打包.ps1` 可生成 Windows 导入助手。
生成目录和打包中间文件均已加入忽略规则。

## 自检

安装上述依赖后，运行根目录的 `运行自检.ps1`。
测试使用生成的媒体样本，临时数据保存在 `work` 中。

## 提交范围

`.gitignore` 仅控制 Git 跟踪范围，不删除电脑上的现有文件。
请勿强制添加 `data`、`tools`、登录信息、完整备份压缩包或桌面程序构建目录。
