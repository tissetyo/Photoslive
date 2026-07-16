$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "Photoslive"
$Archive = Join-Path $env:TEMP "photoslive-agent.zip"
$Extract = Join-Path $InstallDir "source"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Install Python 3 terlebih dahulu dan aktifkan Add Python to PATH." }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "https://photoslive.vercel.app/downloads/photoslive-agent.zip" -OutFile $Archive
Remove-Item -Recurse -Force $Extract -ErrorAction SilentlyContinue
Expand-Archive -Path $Archive -DestinationPath $Extract -Force
$SourceDir = Join-Path $Extract "photobox"
if (-not (Test-Path (Join-Path $SourceDir "agent.py"))) { throw "Paket Photoslive Agent tidak valid." }
$Python = (Get-Command python).Source

schtasks /Delete /TN "Photoslive Controller" /F 2>$null | Out-Null
schtasks /Delete /TN "Photoslive Agent" /F 2>$null | Out-Null
schtasks /Create /TN "Photoslive Controller" /SC ONLOGON /TR "`"$Python`" `"$SourceDir\server.py`"" /F | Out-Null
schtasks /Create /TN "Photoslive Agent" /SC ONLOGON /TR "`"$Python`" `"$SourceDir\agent.py`"" /F | Out-Null
schtasks /Run /TN "Photoslive Controller" | Out-Null
Start-Sleep -Seconds 3
schtasks /Run /TN "Photoslive Agent" | Out-Null
Start-Sleep -Seconds 3
& $Python "$SourceDir\agent.py" --status
Write-Host "Photoslive Agent terpasang dan otomatis berjalan saat login."
