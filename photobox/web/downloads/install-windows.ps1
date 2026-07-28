$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "Photoslive"
$Archive = Join-Path $env:TEMP "photoslive-agent.zip"
$Extract = Join-Path $InstallDir "source"

function Invoke-DownloadWithRetry {
  param([string]$Uri, [string]$OutFile, [int]$Attempts = 6)
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -TimeoutSec 180
      return
    } catch {
      if ($Attempt -eq $Attempts) { throw }
      Write-Warning "Download belum stabil. Coba lagi $($Attempt + 1)/$Attempts dalam 3 detik..."
      Start-Sleep -Seconds 3
    }
  }
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Install Python 3 terlebih dahulu dan aktifkan Add Python to PATH." }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-DownloadWithRetry -Uri "https://photoslive.vercel.app/downloads/photoslive-agent.zip" -OutFile $Archive
Remove-Item -Recurse -Force $Extract -ErrorAction SilentlyContinue
Expand-Archive -Path $Archive -DestinationPath $Extract -Force
$SourceDir = Join-Path $Extract "photobox"
if (-not (Test-Path (Join-Path $SourceDir "agent.py"))) { throw "Paket Photoslive Agent tidak valid." }
$Python = (Get-Command python).Source
$PythonVersion = [int](& $Python -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)")
if ($PythonVersion -lt 310) { throw "Photoslive memerlukan Python 3.10 atau lebih baru." }
if (-not (Test-Path (Join-Path $SourceDir "requirements-controller.txt"))) { throw "Daftar dependency Controller tidak ditemukan." }
& $Python -m venv (Join-Path $InstallDir "runtime")
$RuntimePython = Join-Path $InstallDir "runtime\Scripts\python.exe"
& $RuntimePython -m pip install --disable-pip-version-check --no-input -r (Join-Path $SourceDir "requirements-controller.txt")
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
  -Action (New-ScheduledTaskAction -Execute $RuntimePython -Argument "`"$SourceDir\server.py`"" -WorkingDirectory $SourceDir) `
  -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Register-ScheduledTask `
  -TaskName "Photoslive Agent" `
  -Action (New-ScheduledTaskAction -Execute $RuntimePython -Argument "`"$SourceDir\agent.py`"" -WorkingDirectory $SourceDir) `
  -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null

Start-ScheduledTask -TaskName "Photoslive Controller"
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName "Photoslive Agent"
Start-Sleep -Seconds 3
Write-Host "Photoslive Agent diperbarui. Windows akan menjalankannya saat login dan mengulang otomatis setelah gagal."
$AgentHelp = (& $RuntimePython "$SourceDir\agent.py" --help 2>&1 | Out-String)
$SetupArgument = if ($AgentHelp -match "--setup-link") { "--setup-link" } else { "--setup-code" }
if ($SetupArgument -eq "--setup-code") {
  Write-Host "Paket Agent memakai opsi setup lama; installer akan melanjutkan secara kompatibel."
}
& $RuntimePython "$SourceDir\agent.py" $SetupArgument --open-setup
Write-Host "Status lokal terakhir:"
try { & $RuntimePython "$SourceDir\agent.py" --status } catch { Write-Warning $_.Exception.Message }
