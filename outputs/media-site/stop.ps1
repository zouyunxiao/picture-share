$ErrorActionPreference = 'Stop'
$siteRoot = $PSScriptRoot
foreach ($kind in @('tunnel','server')) {
  $pidPath = Join-Path $siteRoot "data\$kind.pid"
  if (Test-Path -LiteralPath $pidPath) {
    $recordedId = [int](Get-Content -LiteralPath $pidPath)
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedId" -ErrorAction SilentlyContinue
    $matchesSite = $processInfo -and (($kind -eq 'tunnel' -and $processInfo.ExecutablePath -eq (Join-Path $siteRoot 'tools\cloudflared.exe')) -or ($kind -eq 'server' -and $processInfo.CommandLine.Contains((Join-Path $siteRoot 'server.js'))))
    if ($matchesSite) { Stop-Process -Id $recordedId }
    Remove-Item -LiteralPath $pidPath -Force
  }
}
Write-Host '网站和公网隧道已停止。已上传的文件保留在 data 文件夹中。'
