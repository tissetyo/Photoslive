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
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName "Photoslive Controller" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Photoslive Agent" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName "Photoslive Controller" `
  -Action (New-ScheduledTaskAction -Execute $Python -Argument "`"$SourceDir\server.py`"" -WorkingDirectory $SourceDir) `
  -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Register-ScheduledTask `
  -TaskName "Photoslive Agent" `
  -Action (New-ScheduledTaskAction -Execute $Python -Argument "`"$SourceDir\agent.py`"" -WorkingDirectory $SourceDir) `
  -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null

Start-ScheduledTask -TaskName "Photoslive Controller"
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName "Photoslive Agent"
Start-Sleep -Seconds 3
& $Python "$SourceDir\agent.py" --status
Write-Host "Photoslive Agent diperbarui. Windows akan menjalankannya saat login dan mengulang otomatis setelah gagal."
& $Python "$SourceDir\agent.py" --setup-code
