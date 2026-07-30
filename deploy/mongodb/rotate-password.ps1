# Rotates the skympuser MongoDB password and updates the live server-settings.json.
#
# setup-mongodb.ps1 creates only skympuser (readWrite + dbAdmin on skymp). That
# account cannot change its own password, so with no admin user the rotation
# needs a brief auth-disabled window. The script restores authorization and
# restarts the service even if a step fails.
#
# Run ELEVATED:
#   powershell -ExecutionPolicy Bypass -File deploy\mongodb\rotate-password.ps1 -NewPassword '<password>'
#
# Optional: -CreateAdmin '<adminPassword>' also creates a root user
# (alduinakAdmin) so later rotations need no downtime at all.

param(
  [Parameter(Mandatory = $true)][string]$NewPassword,
  [string]$CreateAdmin = '',
  [string]$User = 'skympuser',
  [string]$MongoCfg = 'C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg',
  [string]$ServiceName = 'MongoDB',
  [string]$Settings = 'C:\Users\Administrator\Desktop\alduinak\build\dist\server\server-settings.json'
)

$ErrorActionPreference = 'Stop'

function Get-Mongosh {
  $candidates = @(
    'X:\Program Files\mongosh\mongosh.exe',
    'C:\Program Files\mongosh\mongosh.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command mongosh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'mongosh not found'
}

function Invoke-Mongo($uri, $js) {
  $out = & $mongosh $uri --quiet --eval $js 2>&1
  if ($LASTEXITCODE -ne 0) { throw "mongosh failed: $out" }
  return ($out | Out-String).Trim()
}

$mongosh = Get-Mongosh
Write-Host "[rotate] mongosh: $mongosh"

# JSON string escape so quotes or backslashes in the password cannot break the eval
$pwJs = ($NewPassword | ConvertTo-Json)

$updateJs = "db.getSiblingDB('admin').updateUser('$User', { pwd: $pwJs }); print('UPDATED');"
$rotated = $false

# Fast path: works when an admin account exists or changeOwnPassword was granted
try {
  $settingsJson = Get-Content $Settings -Raw | ConvertFrom-Json
  $currentUri = $settingsJson.databaseUri
  Write-Host '[rotate] trying rotation with the current credentials'
  $res = Invoke-Mongo $currentUri $updateJs
  if ($res -match 'UPDATED') { $rotated = $true; Write-Host '[rotate] rotated without downtime' }
} catch {
  Write-Host "[rotate] authenticated rotation not permitted: $($_.Exception.Message)"
}

if (-not $rotated) {
  Write-Host '[rotate] falling back to a brief auth-disabled window'
  $original = Get-Content $MongoCfg -Raw
  if ($original -notmatch 'authorization:\s*enabled') {
    throw "authorization: enabled not found in $MongoCfg, aborting"
  }
  try {
    # Disable auth, restart, rotate on the localhost connection
    ($original -replace 'authorization:\s*enabled', 'authorization: disabled') |
      Set-Content $MongoCfg -Encoding ascii
    Restart-Service $ServiceName
    Start-Sleep -Seconds 3
    $res = Invoke-Mongo 'mongodb://127.0.0.1:27017/admin' $updateJs
    if ($res -notmatch 'UPDATED') { throw "updateUser did not confirm: $res" }
    if ($CreateAdmin) {
      $adminPwJs = ($CreateAdmin | ConvertTo-Json)
      $adminJs = "try { db.getSiblingDB('admin').createUser({ user: 'alduinakAdmin', pwd: $adminPwJs, roles: [ { role: 'root', db: 'admin' } ] }); print('ADMIN_CREATED'); } catch (e) { print('ADMIN_SKIPPED: ' + e.message); }"
      Write-Host ('[rotate] ' + (Invoke-Mongo 'mongodb://127.0.0.1:27017/admin' $adminJs))
    }
    $rotated = $true
  } finally {
    # Always restore authorization, even if the rotation threw
    Set-Content $MongoCfg -Value $original -Encoding ascii
    Restart-Service $ServiceName
    Start-Sleep -Seconds 3
    Write-Host '[rotate] authorization restored and service restarted'
  }
}

if (-not $rotated) { throw 'rotation failed' }

# Point the live settings at the new password. Written with .NET so no BOM is
# added: the server's JSON.parse rejects a BOM.
$raw = Get-Content $Settings -Raw
$escaped = [uri]::EscapeDataString($NewPassword)
$updated = [regex]::Replace(
  $raw,
  '("databaseUri"\s*:\s*")mongodb://([^:]+):([^@]+)@',
  { param($m) $m.Groups[1].Value + 'mongodb://' + $m.Groups[2].Value + ':' + $escaped + '@' }
)
if ($updated -eq $raw) { throw "databaseUri not updated in $Settings, update it by hand" }
[System.IO.File]::WriteAllText($Settings, $updated, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[rotate] databaseUri updated in $Settings"

# The merged dump is regenerated at boot and still holds the old secret
$merged = Join-Path (Split-Path $Settings) 'server-settings-merged.json'
if (Test-Path $merged) { Remove-Item $merged -Force; Write-Host '[rotate] removed stale server-settings-merged.json' }

# Confirm the new credentials work with authorization back on
$newUri = "mongodb://${User}:${escaped}@127.0.0.1:27017/skymp?authSource=admin"
$count = Invoke-Mongo $newUri "print(db.getSiblingDB('skymp').changeForms.countDocuments({}))"
Write-Host "[rotate] verified: changeForms docs = $count"
Write-Host '[rotate] DONE. Restart AlduinakGameServer so it picks up the new password.'
