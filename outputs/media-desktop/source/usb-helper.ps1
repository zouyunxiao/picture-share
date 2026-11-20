param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
function Emit($value) { Write-Output ($value | ConvertTo-Json -Depth 12 -Compress) }
function Phone-Items {
  @($shell.Namespace(17).Items() | Where-Object { $_.Name -match 'iPhone|iPad' })
}
function Find-Phone {
  $phone = Phone-Items | Where-Object { $_.Path -eq $request.deviceId } | Select-Object -First 1
  if (-not $phone) { throw '没有找到这台 iPhone，请确认 USB 连接、解锁并信任此电脑。' }
  return $phone
}
function File-Size($item) {
  $fileBytes = 0
  try { $fileBytes = [long]$item.ExtendedProperty('System.Size') } catch {}
  if ($fileBytes -le 0) { try { $fileBytes = [long]$item.Size } catch {} }
  return $fileBytes
}
function Item-Name($item) {
  $fileName = $null
  try { $fileName = [string]$item.ExtendedProperty('System.FileName') } catch {}
  if ([string]::IsNullOrWhiteSpace($fileName)) { $fileName = [string]$item.Name }
  return $fileName
}
function Scan-Folder($folder, [string[]]$segments, [int]$depth) {
  if ($depth -gt 8) { return }
  foreach ($item in @($folder.Items())) {
    if ($request.cancelPath -and (Test-Path -LiteralPath $request.cancelPath)) { return }
    $itemName = Item-Name $item
    $next = @($segments) + @($itemName)
    if ($item.IsFolder) {
      Scan-Folder $item.GetFolder $next ($depth + 1)
    } elseif ($itemName -match '\.(heic|heif|jpg|jpeg|png|gif|webp|avif|mov|mp4|m4v|webm)$') {
      Emit @{type='file';name=$itemName;size=(File-Size $item);segments=$next}
    }
  }
}
try {
  if ($request.mode -eq 'list') {
    foreach ($phone in (Phone-Items)) { Emit @{type='device';name=[string]$phone.Name;id=[string]$phone.Path} }
  } elseif ($request.mode -eq 'scan') {
    $phone = Find-Phone
    Scan-Folder $phone.GetFolder @() 0
  } elseif ($request.mode -eq 'copy') {
    $phone = Find-Phone
    $destinationRoot = [IO.Path]::GetFullPath([string]$request.destination)
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    $index = 0
    foreach ($file in $request.files) {
      if ($request.cancelPath -and (Test-Path -LiteralPath $request.cancelPath)) { break }
      $folder = $phone.GetFolder
      $segments = @($file.segments)
      if ($segments.Count -eq 0) { throw '手机原片路径无效。' }
      for ($i=0; $i -lt $segments.Count; $i++) {
        $segment = [string]$segments[$i]
        if ($segment -eq '..' -or $segment -eq '.' -or $segment.Contains('\') -or $segment.Contains('/')) { throw '手机原片路径无效。' }
        $part = @($folder.Items()) | Where-Object { (Item-Name $_) -eq $segment } | Select-Object -First 1
        if (-not $part) { throw '手机原片已不可读取，请保持手机解锁后重新扫描。' }
        if ($i -lt $segments.Count-1) { $folder = $part.GetFolder }
      }
      $targetDir = Join-Path $destinationRoot ([string]$index)
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
      $targetDir = [IO.Path]::GetFullPath($targetDir)
      if (-not $targetDir.StartsWith($destinationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '目标目录无效。' }
      $originalName = Item-Name $part
      $targetPath = Join-Path $targetDir ([IO.Path]::GetFileName($originalName))
      $expected = File-Size $part
      if ($expected -le 0) { throw '无法确认这份手机原片的大小，请解锁手机、下载原片后重试。' }
      Emit @{type='progress';message=('正在复制手机原片：' + $originalName)}
      $shell.Namespace($targetDir).CopyHere($part, (4 + 16 + 512 + 1024))
      $ready = $false
      $previousSize = -1
      $stable = 0
      for ($wait=0; $wait -lt 600; $wait++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $targetPath) {
          $actual = (Get-Item -LiteralPath $targetPath).Length
          if ($actual -eq $expected) { $stable++ } else { $stable=0 }
          $previousSize=$actual
          if ($stable -ge 3) { $ready=$true; break }
        }
      }
      if (-not $ready) { throw '复制原片超时。请解锁手机，并检查 iCloud 原片是否已下载到手机。' }
      Emit @{type='copied';index=$index;path=$targetPath;name=$originalName;size=(Get-Item -LiteralPath $targetPath).Length}
      $index++
    }
  } else { throw '未知的手机操作。' }
  Emit @{type='done'}
} catch {
  Emit @{type='error';message=$_.Exception.Message}
  exit 1
}
