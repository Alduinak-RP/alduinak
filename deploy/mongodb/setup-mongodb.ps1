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
if (-not (Get-Command mongod -ErrorAction SilentlyContinue)) {
  Write-Host "[mongo] downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $msi
  Write-Host "[mongo] installing (server binaries only, no bundled service)"
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet ADDLOCAL=ServerNoService,Client SHOULD_INSTALL_COMPASS=0" -Wait
}

# Resolve the mongod / mongosh paths (installed under Program Files by default).
$mongod  = (Get-ChildItem "C:\Program Files\MongoDB\Server\*\bin\mongod.exe"  -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
if (-not $mongod)  { throw "mongod.exe not found after install; check the MongoDB install." }
if (-not $mongosh) { Write-Warning "mongosh not found on PATH; install the MongoDB Shell to create the user, or do it manually per the migration doc." }

# 2. Register the service against our config (nssm if present, else sc/mongod).
$nssm = Join-Path $repoRoot "server-manager\tools\nssm.exe"
if (-not (Test-Path $nssm)) { $nssm = "nssm" }
Write-Host "[mongo] registering AlduinakMongo service"
Start-Process $mongod -ArgumentList "--config `"$cfg`" --install --serviceName AlduinakMongo --serviceDisplayName `"Alduinak MongoDB`"" -Wait -ErrorAction SilentlyContinue
Start-Service AlduinakMongo -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

# 3. Create the app user. authorization is enabled, but the localhost
#    exception lets the FIRST user be created without auth.
if ($mongosh) {
  $js = @"
try {
  db = db.getSiblingDB('admin');
  db.createUser({ user: '$User', pwd: '$Password', roles: [ { role: 'readWrite', db: 'skymp' }, { role: 'dbAdmin', db: 'skymp' } ] });
  print('[mongo] created user $User');
} catch (e) { print('[mongo] createUser: ' + e.message); }
"@
  & $mongosh "mongodb://127.0.0.1:27017/admin" --eval $js
}

Write-Host ""
Write-Host "[mongo] done. Next:"
Write-Host "  1. URL-encode any reserved chars in the password for the URI (see the migration doc)."
Write-Host "  2. Follow docs\alduinak_mongodb_migration.md to migrate file->mongo and switch the driver."
Write-Host "  3. Run 'npm install' in server-manager so its Mongo-aware character reader works."
