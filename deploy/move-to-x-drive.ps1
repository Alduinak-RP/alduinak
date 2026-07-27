<#
  Alduinak X-drive migration. RUN THIS YOURSELF in an elevated PowerShell.
  Frees ~77 GB on C: by moving the three big Skyrim content folders to X:
    C:\skyrim install  (24 GB, GOG offline installers, referenced by nothing)
    C:\MO2             (15 GB, portable Mod Organizer 2)
    C:\GOG Games       (37 GB, the game the LIVE server reads its plugins from)
  and updating every path reference:
    - GOG registry keys (HKLM ...\GOG.com\Games\*)
    - ModOrganizer.ini (gamePath + custom executables)
    - build\dist\server\server-settings.json loadOrder (backup written first)

  It does NOT touch Program Files. Installed (MSI) programs cannot be moved by
  copying + registry edits; that breaks servicing. Everything moved here is
  portable file data.

  The game server is STOPPED for the GOG move (it holds those files) and
  restarted afterward if it was running.

  Usage (elevated):
    powershell -ExecutionPolicy Bypass -File deploy\move-to-x-drive.ps1
#>
param(
  [string] $XRoot = "X:"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script elevated (Administrator)."
}
if (-not (Test-Path $XRoot)) { throw "$XRoot not found." }

# robocopy /MOVE = per-file copy-then-delete, safe with only 0.2 GB free on C:
function Move-Tree([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) {
    if (Test-Path $dst) { Write-Host "[move] $src already moved to $dst, skipping"; return }
    throw "Source $src not found and destination $dst missing."
  }
  Write-Host "[move] $src -> $dst"
  robocopy $src $dst /E /MOVE /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL /NP /MT:8 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $src (rc=$LASTEXITCODE)" }
  # /MOVE with /MT can leave empty source dirs behind
  if ((Test-Path $src) -and -not (Get-ChildItem $src -Recurse -File -ErrorAction SilentlyContinue)) {
    Remove-Item $src -Recurse -Force
  }
  if (Test-Path $src) { Write-Warning "$src still has files left; investigate before deleting." }
}

# Swap the drive letter in front of a known folder name, all slash styles
function Update-PathsInFile([string]$file, [string[]]$folderNames) {
  if (-not (Test-Path $file)) { Write-Warning "$file not found, skipping"; return }
  $text = Get-Content $file -Raw
  $orig = $text
  foreach ($name in $folderNames) {
    $text = $text -replace "C:(?=[\\/]+$([regex]::Escape($name)))", $XRoot
  }
  if ($text -ne $orig) {
    Copy-Item $file "$file.pre-x-move.bak" -Force
    Set-Content -Path $file -Value $text -Encoding UTF8 -NoNewline
    Write-Host "[paths] updated $file (backup: $file.pre-x-move.bak)"
  } else {
    Write-Host "[paths] no references in $file"
  }
}

# 1. The two folders nothing running depends on.
Move-Tree "C:\skyrim install" "$XRoot\skyrim install"
Move-Tree "C:\MO2" "$XRoot\MO2"

# 2. GOG Games: stop the game server first, it reads plugins from here.
$svc = Get-Service AlduinakGameServer -ErrorAction SilentlyContinue
$wasRunning = $svc -and $svc.Status -eq "Running"
if ($wasRunning) {
  Write-Host "[svc] stopping AlduinakGameServer"
  Stop-Service AlduinakGameServer -Force
  $svc.WaitForStatus("Stopped", (New-TimeSpan -Seconds 60))
}
Move-Tree "C:\GOG Games" "$XRoot\GOG Games"

# 3. Registry: rewrite any GOG value that points at the old location.
foreach ($hive in "HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games", "HKLM:\SOFTWARE\GOG.com\Games") {
  Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
    $key = $_.PSPath
    ($_ | Get-ItemProperty).PSObject.Properties | Where-Object {
      $_.Value -is [string] -and $_.Value -match "C:[\\/]+GOG Games"
    } | ForEach-Object {
      $new = $_.Value -replace "C:(?=[\\/]+GOG Games)", $XRoot
      Set-ItemProperty -Path $key -Name $_.Name -Value $new
      Write-Host "[reg] $key $($_.Name) -> $new"
    }
  }
}

# 4. MO2 ini (now on X:) still points at C: for the game and its own tools.
Update-PathsInFile "$XRoot\MO2\ModOrganizer.ini" @("GOG Games", "MO2")

# 5. Live server settings: loadOrder paths.
Update-PathsInFile (Join-Path $repoRoot "build\dist\server\server-settings.json") @("GOG Games")

# 6. Restart the game server if we stopped it.
if ($wasRunning) {
  Write-Host "[svc] starting AlduinakGameServer"
  Start-Service AlduinakGameServer
}

$free = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 1)
Write-Host ""
Write-Host "[done] C: now has $free GB free."
Write-Host "[done] Watch the game server log for a clean start (it must load the espm files from $XRoot)."
