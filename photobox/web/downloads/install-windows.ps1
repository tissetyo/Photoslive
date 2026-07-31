$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "Photoslive"
$Archive = Join-Path $env:TEMP "photoslive-agent.zip"
$Extract = Join-Path $InstallDir "source"
$RuntimeDir = Join-Path $InstallDir "runtime"
$UvInstaller = Join-Path $env:TEMP "photoslive-uv-installer.ps1"
$UvDir = Join-Path $InstallDir "bootstrap"
$UvExe = Join-Path $UvDir "uv.exe"
$ManagedPythonDir = Join-Path $InstallDir "python"
$UvVersion = "0.11.32"
$AgentArchiveSource = if ($env:PHOTOSLIVE_AGENT_ARCHIVE) { $env:PHOTOSLIVE_AGENT_ARCHIVE } else { "https://photoslive.vercel.app/downloads/photoslive-agent.zip" }

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

function Get-CompatiblePython {
  foreach ($Name in @("python", "python3")) {
    $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $Command) { continue }
    try {
      $Version = & $Command.Source -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)" 2>$null
      if (($LASTEXITCODE -eq 0) -and ([int]$Version -ge 310)) {
        return [PSCustomObject]@{ Executable = $Command.Source; Arguments = @() }
      }
    } catch {}
  }

  $Launcher = Get-Command "py" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $Launcher) {
    try {
      $Version = & $Launcher.Source -3 -c "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)" 2>$null
      if (($LASTEXITCODE -eq 0) -and ([int]$Version -ge 310)) {
        return [PSCustomObject]@{ Executable = $Launcher.Source; Arguments = @("-3") }
      }
    } catch {}
  }

  return $null
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (Test-Path $AgentArchiveSource) {
  Copy-Item -Force $AgentArchiveSource $Archive
} else {
  Invoke-DownloadWithRetry -Uri $AgentArchiveSource -OutFile $Archive
}
Remove-Item -Recurse -Force $Extract -ErrorAction SilentlyContinue
Expand-Archive -Path $Archive -DestinationPath $Extract -Force
$SourceDir = Join-Path $Extract "photobox"
if (-not (Test-Path (Join-Path $SourceDir "agent.py"))) { throw "Paket Photoslive Agent tidak valid." }
if (-not (Test-Path (Join-Path $SourceDir "updater.py"))) { throw "Paket Photoslive tidak lengkap (updater.py tidak ditemukan)." }
if (-not (Test-Path (Join-Path $SourceDir "requirements-controller.txt"))) { throw "Daftar dependency Controller tidak ditemukan." }

$RuntimeReady = $false
$SystemPython = if ($env:PHOTOSLIVE_FORCE_MANAGED_PYTHON -eq "1") { $null } else { Get-CompatiblePython }
if ($null -ne $SystemPython) {
  $SystemPythonExecutable = $SystemPython.Executable
  $PythonArguments = @($SystemPython.Arguments)
  $SystemPythonVersion = & $SystemPythonExecutable @PythonArguments --version 2>&1
  Write-Host "Menggunakan Python kompatibel: $SystemPythonVersion"
  Remove-Item -Recurse -Force $RuntimeDir -ErrorAction SilentlyContinue
  & $SystemPythonExecutable @PythonArguments -m venv $RuntimeDir
  if ($LASTEXITCODE -eq 0) {
    $RuntimeReady = $true
  } else {
    Write-Warning "Virtual environment sistem gagal. Photoslive akan menyiapkan runtime Python sendiri."
  }
}

if (-not $RuntimeReady) {
  Write-Host "Python sistem belum kompatibel. Menyiapkan runtime Python 3.12 khusus Photoslive..."
  New-Item -ItemType Directory -Force -Path $UvDir, $ManagedPythonDir | Out-Null
  Invoke-DownloadWithRetry -Uri "https://astral.sh/uv/$UvVersion/install.ps1" -OutFile $UvInstaller
  $env:UV_INSTALL_DIR = $UvDir
  $env:UV_NO_MODIFY_PATH = "1"
  Invoke-Expression (Get-Content -Raw $UvInstaller)
  if (-not (Test-Path $UvExe)) { throw "Runtime bootstrap Photoslive gagal dipasang." }

  Remove-Item -Recurse -Force $RuntimeDir -ErrorAction SilentlyContinue
  $env:UV_MANAGED_PYTHON = "1"
  $env:UV_PYTHON_INSTALL_DIR = $ManagedPythonDir
  $env:UV_PYTHON_NO_REGISTRY = "1"
  $env:UV_CACHE_DIR = (Join-Path $InstallDir "cache")
  & $UvExe venv --python 3.12 $RuntimeDir
  if ($LASTEXITCODE -ne 0) { throw "Runtime Python 3.12 Photoslive gagal disiapkan." }
}

$RuntimePython = Join-Path $RuntimeDir "Scripts\python.exe"
if (-not (Test-Path $RuntimePython)) { throw "Runtime Python Photoslive tidak terbentuk." }
if (Test-Path $UvExe) {
  $env:UV_CACHE_DIR = (Join-Path $InstallDir "cache")
  & $UvExe pip install --python $RuntimePython -r (Join-Path $SourceDir "requirements-controller.txt")
  if ($LASTEXITCODE -ne 0) { throw "Dependency Photoslive gagal dipasang." }
  Remove-Item -Recurse -Force $env:UV_CACHE_DIR -ErrorAction SilentlyContinue
} else {
  & $RuntimePython -m pip install --disable-pip-version-check --no-input -r (Join-Path $SourceDir "requirements-controller.txt")
  if ($LASTEXITCODE -ne 0) { throw "Dependency Photoslive gagal dipasang." }
}

if ($env:PHOTOSLIVE_INSTALLER_RUNTIME_ONLY -eq "1") {
  Write-Host "Runtime Python Photoslive siap: $(& $RuntimePython --version 2>&1)"
  exit 0
}

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

$ControllerReady = $false
for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/health" -Method Get -TimeoutSec 2 | Out-Null
    $SetupPage = Invoke-WebRequest -Uri "http://127.0.0.1:8080/setup?local=1" -Method Get -TimeoutSec 3 -UseBasicParsing
    if ($SetupPage.StatusCode -ne 200 -or $SetupPage.Content -notmatch "<title>Setup Photoslive</title>") {
      throw "Halaman setup lokal tidak lengkap."
    }
    $ControllerReady = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ControllerReady) {
  $Task = Get-ScheduledTaskInfo -TaskName "Photoslive Controller" -ErrorAction SilentlyContinue
  if ($null -ne $Task) { $Task | Format-List | Out-Host }
  throw "Photoslive Controller atau halaman setup lokal gagal dijalankan. Browser tidak akan dibuka."
}
if ($env:PHOTOSLIVE_HELPER_BOOTSTRAP) {
  & $RuntimePython "$SourceDir\agent.py" --helper-bootstrap $env:PHOTOSLIVE_HELPER_BOOTSTRAP
  if ($LASTEXITCODE -ne 0) { throw "Photoslive Helper gagal dihubungkan ke photobox." }
  Start-ScheduledTask -TaskName "Photoslive Agent"
  Write-Host "Photoslive Helper terpasang dan akan hidup otomatis bersama komputer."
} else {
  Start-ScheduledTask -TaskName "Photoslive Agent"
  Write-Host "Photoslive Helper terpasang tanpa booth aktif. Hubungkan dari Admin sebelum digunakan."
  & $RuntimePython "$SourceDir\agent.py" --setup-link --open-setup
}
Write-Host "Status lokal terakhir:"
try { & $RuntimePython "$SourceDir\agent.py" --status } catch { Write-Warning $_.Exception.Message }
