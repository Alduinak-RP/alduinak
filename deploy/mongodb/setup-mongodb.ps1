<#
  Alduinak MongoDB setup. RUN THIS YOURSELF in an elevated PowerShell.
  It installs MongoDB Community Server, registers it as a Windows service
  using deploy/mongodb/mongod.cfg, and creates the skymp app user.

  Claude does not run this for you (installing system services and
  downloading installers is an operator action).

  Usage (elevated):
    powershell -ExecutionPolicy Bypass -File deploy\mongodb\setup-mongodb.ps1 -Password "YourStrongPassword"

  After it finishes, follow docs/alduinak_mongodb_migration.md to run the
  one-shot file->mongo migration and switch the server driver to mongodb.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Password,
  # 8.0.x is the current LTS track (recommended for a production Windows Server box)
  [string] $MongoVersion = "8.0.28",
  [string] $MongoshVersion = "2.10.0",
  [string] $ToolsVersion = "100.18.0",
  [string] $Root = "C:\Alduinak\mongodb",
  [string] $User = "skympuser"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfg = Join-Path $PSScriptRoot "mongod.cfg"

Write-Host "[mongo] creating folders under $Root"
New-Item -ItemType Directory -Force -Path "$Root\data", "$Root\log", "$Root\bin" | Out-Null

# 1. Download + silently install MongoDB Community Server.
# Verify the version at https://www.mongodb.com/try/download/community if this 404s.
$msi = "$env:TEMP\mongodb-$MongoVersion.msi"
$url = "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-$MongoVersion-signed.msi"
$installed = (Get-Command mongod -ErrorAction SilentlyContinue) -or (Get-ChildItem "C:\Program Files\MongoDB\Server\*\bin\mongod.exe" -ErrorAction SilentlyContinue)
if (-not $installed) {
  if (-not (Test-Path $msi)) {
    Write-Host "[mongo] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $msi
  }
  Write-Host "[mongo] installing (server binaries only, no bundled service)"
  # The 8.x MSI has no Client feature (mongosh ships separately); an unknown feature fails the whole install (MSI error 2711)
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet ADDLOCAL=ServerNoService SHOULD_INSTALL_COMPASS=0" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "MongoDB MSI install failed (msiexec exit $($p.ExitCode)); see the Application event log" }
}

# mongosh (needed below to create the user) and the Database Tools (mongodump/mongorestore) are separate MSIs
# The mongosh MSI installs per user unless ALLUSERS=1; the shell that ran it does not see the PATH change yet
function Find-Mongosh {
  $c = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
  if ($c) { return $c }
  foreach ($cand in @("$env:LOCALAPPDATA\Programs\mongosh\mongosh.exe", "C:\Program Files\mongosh\mongosh.exe")) { if (Test-Path $cand) { return $cand } }
  return $null
}
$mongosh = Find-Mongosh
if (-not $mongosh) {
  $shMsi = "$env:TEMP\mongosh-$MongoshVersion.msi"
  if (-not (Test-Path $shMsi)) {
    Write-Host "[mongo] downloading mongosh $MongoshVersion"
    Invoke-WebRequest -Uri "https://downloads.mongodb.com/compass/mongosh-$MongoshVersion-x64.msi" -OutFile $shMsi
  }
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$shMsi`" /quiet ALLUSERS=1" -Wait -PassThru
  if ($p.ExitCode -ne 0) { Write-Warning "mongosh MSI failed (exit $($p.ExitCode)); the app user will not be created" }
  $mongosh = Find-Mongosh
}
$tools = (Get-Command mongodump -ErrorAction SilentlyContinue) -or (Get-ChildItem "C:\Program Files\MongoDB\Tools\*\bin\mongodump.exe" -ErrorAction SilentlyContinue)
if (-not $tools) {
  $tMsi = "$env:TEMP\mongodb-database-tools-$ToolsVersion.msi"
  if (-not (Test-Path $tMsi)) {
    Write-Host "[mongo] downloading Database Tools $ToolsVersion"
    Invoke-WebRequest -Uri "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-$ToolsVersion.msi" -OutFile $tMsi
  }
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$tMsi`" /quiet" -Wait -PassThru
  if ($p.ExitCode -ne 0) { Write-Warning "Database Tools MSI failed (exit $($p.ExitCode)); mongodump/mongorestore unavailable" }
}

# Resolve the mongod / mongosh paths (installed under Program Files by default).
$mongod  = (Get-ChildItem "C:\Program Files\MongoDB\Server\*\bin\mongod.exe"  -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $mongod)  { throw "mongod.exe not found after install; check the MongoDB install." }
if (-not $mongosh) { throw "mongosh not found; install the MongoDB Shell and re-run, the app user has not been created" }

# 2. Register the service against our config (nssm if present, else sc/mongod).
$nssm = Join-Path $repoRoot "server-manager\tools\nssm.exe"
if (-not (Test-Path $nssm)) { $nssm = "C:\tools\nssm\nssm.exe" }
Write-Host "[mongo] registering AlduinakMongo service"
Start-Process $mongod -ArgumentList "--config `"$cfg`" --install --serviceName AlduinakMongo --serviceDisplayName `"Alduinak MongoDB`"" -Wait -ErrorAction SilentlyContinue
Start-Service AlduinakMongo -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
if ((Get-Service AlduinakMongo -ErrorAction SilentlyContinue).Status -ne 'Running') { throw "AlduinakMongo is not running; check $Root\log\mongod.log" }

# 3. Create the app user. authorization is enabled, but the localhost
#    exception lets the FIRST user be created without auth.
if ($mongosh) {
  $userJs = $User | ConvertTo-Json -Compress
  $pwJs = $Password | ConvertTo-Json -Compress
  $js = @"
try {
  db = db.getSiblingDB('admin');
  db.createUser({ user: $userJs, pwd: $pwJs, roles: [ { role: 'readWrite', db: 'skymp' }, { role: 'dbAdmin', db: 'skymp' } ] });
  print('[mongo] created user ' + $userJs);
} catch (e) { print('[mongo] createUser: ' + e.message); }
"@
  & $mongosh "mongodb://127.0.0.1:27017/admin" --eval $js
}

Write-Host ""
Write-Host "[mongo] done. Next:"
Write-Host "  1. URL-encode any reserved chars in the password for the URI (see the migration doc)."
Write-Host "  2. Follow docs\alduinak_mongodb_migration.md to migrate file->mongo and switch the driver."
Write-Host "  3. Run 'npm install' in server-manager so its Mongo-aware character reader works."
