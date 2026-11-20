$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$desktopRoot = Split-Path $sourceRoot
$outputsRoot = Split-Path $desktopRoot
$projectRoot = Split-Path $outputsRoot
$buildRoot = Join-Path $projectRoot 'work\desktop-build'
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCommand) { throw 'Rebuilding requires a normal Python 3.12 installation with pip.' }
& $pythonCommand.Source -m pip install --only-binary=:all: --target (Join-Path $buildRoot 'packages') -r (Join-Path $sourceRoot 'requirements-build.txt')
if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed.' }
$env:PYTHONPATH = Join-Path $buildRoot 'packages'
$workerData = (Join-Path $outputsRoot 'media-site\media-worker.py') + ';.'
$usbData = (Join-Path $sourceRoot 'usb-helper.ps1') + ';.'
& $pythonCommand.Source -m PyInstaller --noconfirm --windowed --onedir --name '片刻导入助手' --icon (Join-Path $sourceRoot 'app.ico') --distpath $desktopRoot --workpath (Join-Path $buildRoot 'cache') --specpath $buildRoot --paths $sourceRoot --collect-all pillow_heif --collect-all imageio_ffmpeg --add-data $workerData --add-data $usbData (Join-Path $sourceRoot 'app.py')
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
