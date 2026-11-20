$ErrorActionPreference = 'Stop'
$siteRoot = $PSScriptRoot
$dataPath = Join-Path $siteRoot 'data'
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $siteRoot 'tools\node\node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$bundledPython = Join-Path $siteRoot 'tools\python-runtime\python.exe'
if (Test-Path -LiteralPath $bundledPython) { $env:PYTHON = $bundledPython }
$env:PATH = (Split-Path $nodePath) + ';' + $env:PATH
if (-not (Test-Path -LiteralPath $nodePath)) { throw '找不到 Node.js，请先安装 Node.js LTS，然后重新启动。' }
$siteReady = $false
try {
  $probe = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/library' -TimeoutSec 3
  $siteReady = $null -ne $probe.items
} catch {}
if (-not $siteReady) {
  $serverProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $siteRoot 'server.js') + '"') -WorkingDirectory $siteRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log')
  Set-Content -LiteralPath (Join-Path $dataPath 'server.pid') -Value $serverProcess.Id
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/library' -TimeoutSec 2 | Out-Null; $siteReady = $true; break } catch {}
  }
}
if (-not $siteReady) { throw '网站启动失败，请查看 data\server-error.log。' }
Write-Host '本地网站已启动：http://localhost:8787'
Write-Host '管理员密码在「登录信息.txt」中。'
$tunnelPath = Join-Path $siteRoot 'tools\cloudflared.exe'
if (-not (Test-Path -LiteralPath $tunnelPath)) {
  Write-Host '正在下载 Cloudflare 官方隧道工具…'
  New-Item -ItemType Directory -Force -Path (Split-Path $tunnelPath) | Out-Null
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $tunnelPath -TimeoutSec 180
}
$tunnelPidFile = Join-Path $dataPath 'tunnel.pid'
if (Test-Path -LiteralPath $tunnelPidFile) {
  $existingId = [int](Get-Content -LiteralPath $tunnelPidFile)
  $existingTunnel = Get-CimInstance Win32_Process -Filter "ProcessId = $existingId" -ErrorAction SilentlyContinue
  if ($existingTunnel -and $existingTunnel.ExecutablePath -eq $tunnelPath) {
    Get-Content -LiteralPath (Join-Path $siteRoot '公网地址.txt')
    return
  }
}
$tunnelLog = Join-Path $dataPath 'tunnel.log'
$tunnelProcess = Start-Process -FilePath $tunnelPath -ArgumentList @('tunnel','--url','http://127.0.0.1:8787','--protocol','http2','--no-autoupdate') -WorkingDirectory $siteRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'tunnel-output.log') -RedirectStandardError $tunnelLog
Set-Content -LiteralPath $tunnelPidFile -Value $tunnelProcess.Id
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $tunnelLog) {
    $logText = Get-Content -LiteralPath $tunnelLog -Raw
    if ($logText -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
      $publicUrl = $Matches[0]
      Set-Content -LiteralPath (Join-Path $siteRoot '公网地址.txt') -Encoding UTF8 -Value "$publicUrl`r`n`r`n将上方网址发给别人即可访问。`r`n重启隧道后，临时网址通常会变化。电脑需保持开机、联网，网站和隧道需保持运行。"
      Write-Host "公网访问地址：$publicUrl"
      return
    }
  }
  if ($tunnelProcess.HasExited) { throw '公网隧道启动失败，请查看 data\tunnel.log。' }
}
throw '公网链接生成超时，请查看 data\tunnel.log。本地网站仍可使用。'
