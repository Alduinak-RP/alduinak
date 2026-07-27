<#
  Alduinak MongoDB finish-setup for the box as it stands (2026-07-27):
  MongoDB 8.0 was installed via the MSI with its bundled "MongoDB" service,
  config at C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg, and data/log
  already on X: (X:\Program Files\MongoDB\Server\8.0\...). Auth is OFF and no
  app user exists yet. RUN THIS YOURSELF in an elevated PowerShell.

  Stage 1 (default) does, in order:
    1. Backs up build\dist\server\world to X:\Alduinak\backups.
    2. Creates the skympuser app user (while auth is still off).
    3. Enables authorization in the service's mongod.cfg and restarts MongoDB.
    4. Verifies authenticated login works.
    5. Patches server-settings.json with the MIGRATION driver block.
  Then: start AlduinakGameServer once. It migrates file->mongo and exits.

  Stage 2:  re-run with -Finalize. It verifies mongo has the migrated docs and
  flips server-settings.json to the plain mongodb driver. Then start the
  game service normally.

  Requires mongosh (not installed by the server MSI):
    https://downloads.mongodb.com/compass/mongosh-2.9.2-x64.msi

  Usage (elevated):
    powershell -ExecutionPolicy Bypass -File deploy\mongodb\finish-mongodb-x.ps1 -Password "YourStrongPassword"
    powershell -ExecutionPolicy Bypass -File deploy\mongodb\finish-mongodb-x.ps1 -Password "YourStrongPassword" -Finalize
#>
param(
  [Parameter(Mandatory = $true)] [string] $Password,
  [string] $User = "skympuser",
  [string] $MongoCfg = "C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg",
  [switch] $Finalize
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$settingsPath = Join-Path $repoRoot "build\dist\server\server-settings.json"
$encPassword = [uri]::EscapeDataString($Password)
$uri = "mongodb://${User}:${encPassword}@127.0.0.1:27017/skymp?authSource=admin"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script elevated (Administrator)."
}
$mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
if (-not $mongosh) {
  $found = Get-ChildItem "C:\Program Files\mongosh*\mongosh.exe", "C:\Program Files\MongoDB\mongosh*\mongosh.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $mongosh = $found.FullName }
}
if (-not $mongosh) {
  throw "mongosh not found. Install it first: https://downloads.mongodb.com/compass/mongosh-2.9.2-x64.msi"
}
if ((Get-Service MongoDB).Status -ne "Running") { Start-Service MongoDB; Start-Sleep -Seconds 3 }

function Patch-Settings([string]$newText) {
  Copy-Item $settingsPath "$settingsPath.pre-mongo.bak" -Force
  Set-Content -Path $settingsPath -Value $newText -Encoding UTF8 -NoNewline
  try { Get-Content $settingsPath -Raw | ConvertFrom-Json | Out-Null }
  catch {
    Copy-Item "$settingsPath.pre-mongo.bak" $settingsPath -Force
    throw "Patched settings failed to parse; restored backup. $_"
  }
  Write-Host "[mongo] patched $settingsPath (backup: $settingsPath.pre-mongo.bak)"
}

# The game server must not run while we rewrite its database settings.
$gameSvc = Get-Service AlduinakGameServer -ErrorAction SilentlyContinue
if ($gameSvc -and $gameSvc.Status -eq "Running") {
  Write-Host "[mongo] stopping AlduinakGameServer"
  Stop-Service AlduinakGameServer -Force
}

if (-not $Finalize) {
  # 1. Backup the file-driver world before anything touches it.
  $stamp = Get-Date -Format "yyyyMMdd-HHmm"
  $backup = "X:\Alduinak\backups\world-$stamp"
  $world = Join-Path $repoRoot "build\dist\server\world"
  if (Test-Path $world) {
    Write-Host "[mongo] backing up world -> $backup"
    robocopy $world $backup /E /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "world backup failed (rc=$LASTEXITCODE)" }
  } else {
    Write-Warning "world dir not found at $world; nothing to back up or migrate."
  }

  # 2. Create the app user while auth is still off (idempotent).
  Write-Host "[mongo] creating user $User"
  $js = "try { db.getSiblingDB('admin').createUser({ user: '$User', pwd: '$Password', roles: [ { role: 'readWrite', db: 'skymp' }, { role: 'dbAdmin', db: 'skymp' } ] }); print('CREATED'); } catch (e) { print('CREATEUSER: ' + e.message); }"
  & $mongosh "mongodb://127.0.0.1:27017/admin" --quiet --eval $js

  # 3. Enable authorization in the service config and restart.
  $cfg = Get-Content $MongoCfg -Raw
  if ($cfg -notmatch "(?m)^\s*authorization:\s*enabled") {
    Copy-Item $MongoCfg "$MongoCfg.bak" -Force
    if ($cfg -match "(?m)^#security:") {
      $cfg = $cfg -replace "(?m)^#security:.*$", "security:`r`n  authorization: enabled"
    } else {
      $cfg += "`r`nsecurity:`r`n  authorization: enabled`r`n"
    }
    Set-Content -Path $MongoCfg -Value $cfg -Encoding ascii
    Write-Host "[mongo] enabled authorization in $MongoCfg (backup: $MongoCfg.bak)"
    Restart-Service MongoDB
    Start-Sleep -Seconds 5
  } else {
    Write-Host "[mongo] authorization already enabled"
  }

  # 4. Verify the credentials actually work before wiring the server to them.
  $ping = & $mongosh $uri --quiet --eval "db.runCommand({ ping: 1 }).ok"
  if ("$ping" -notmatch "1") { throw "Authenticated ping failed; check user/password. Output: $ping" }
  Write-Host "[mongo] authenticated ping OK"

  # 5. Insert the migration driver block into server-settings.json.
  $text = Get-Content $settingsPath -Raw
  if ($text -match '"databaseDriver"') {
    Write-Warning "server-settings.json already has databaseDriver; not patching again."
  } else {
    $block = @"
{
  "databaseDriver": "migration",
  "databaseOld": {
    "databaseDriver": "file",
    "databaseName": "world"
  },
  "databaseNew": {
    "databaseDriver": "mongodb",
    "databaseName": "skymp",
    "databaseUri": "$uri"
  },
"@
    Patch-Settings ($text -replace '^\s*\{', $block)
  }

  Write-Host ""
  Write-Host "[mongo] stage 1 done. NEXT:"
  Write-Host "  1. Start AlduinakGameServer once (manager Start button). It migrates and exits."
  Write-Host "  2. Re-run this script with -Finalize (same -Password)."
  exit 0
}

# ---- Stage 2: -Finalize ----
$count = & $mongosh $uri --quiet --eval "db.getSiblingDB('skymp').changeForms.countDocuments()"
Write-Host "[mongo] skymp.changeForms has $count docs"
if ([int]"$count" -le 0) { throw "No migrated docs found; run the migration first (start the game server once after stage 1)." }

$text = Get-Content $settingsPath -Raw
$pattern = '(?s)"databaseDriver":\s*"migration",\s*"databaseOld":\s*\{.*?\},\s*"databaseNew":\s*\{.*?\},'
if ($text -notmatch $pattern) { throw "Migration block not found in server-settings.json; nothing to finalize." }
$final = "`"databaseDriver`": `"mongodb`",`r`n  `"databaseName`": `"skymp`",`r`n  `"databaseUri`": `"$uri`","
Patch-Settings ($text -replace $pattern, $final)

Write-Host ""
Write-Host "[mongo] finalized. Start AlduinakGameServer normally; it now runs on MongoDB."
Write-Host "[mongo] Keep the world backup until a few sessions have saved/loaded cleanly."
