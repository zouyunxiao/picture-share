$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'work') | Out-Null
$bundledNode = Join-Path $projectRoot 'outputs\media-site\tools\node\node.exe'
$bundledPython = Join-Path $projectRoot 'outputs\media-site\tools\python-runtime\python.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$nodeExe = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { throw '找不到 Node.js。' }
$pythonExe = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } elseif ($pythonCommand) { $pythonCommand.Source } else { throw '找不到 Python。' }
$env:PATH = (Split-Path $nodeExe) + ';' + $env:PATH
$env:PYTHON = $pythonExe
foreach ($test in @('test_native_live.py','test_desktop_core.py','test_capture_metadata.py','test_thumbnails.py')) {
    & $pythonExe (Join-Path $projectRoot ('tests\' + $test))
    if ($LASTEXITCODE -ne 0) { throw "测试失败：$test" }
}
foreach ($test in @('test_live_controller.cjs','test_photo_dates.cjs','test_viewer_gestures.cjs','test_image_loader.cjs')) {
    & $nodeExe (Join-Path $projectRoot ('tests\' + $test))
    if ($LASTEXITCODE -ne 0) { throw "测试失败：$test" }
}
