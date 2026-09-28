<#
  Alduinak Test Server setup. RUN THIS YOURSELF in an elevated PowerShell.
  Creates the test profile next to the live server: build\dist\testserver and
  build\dist\testclient, the AlduinakMongoTest, AlduinakLiveKitTest and
  AlduinakTestServer services, a test server-settings.json derived from the
  live one, and the backend's test manifest set. Safe to re-run: every step
  skips what already exists. It never stops, edits or restarts a live service
  or file. See deploy/testserver/README.md and docs/docs_test_server.md.

  Claude does not run this (registering services, firewall rules and writing
  the backend data are operator actions).

  Usage (elevated):
    powershell -ExecutionPolicy Bypass -File deploy\testserver\setup-testserver.ps1 -MongoPassword "YourStrongPassword"
#>
param(
  [Parameter(Mandatory = $true)] [string] $MongoPassword,
  [string] $MasterKey = "",
  [int] $Port = 7787,
  [int] $MaxPlayers = 20,
  [string] $DataDir = "C:\GOG Games\Skyrim Anniversary Edition - Test\Data",
  [string] $LogDir = "C:\logs\test",
  [string] $Repo = ""
)

$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script elevated (Administrator); it registers services and firewall rules."
}
if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$Repo = (Resolve-Path $Repo).Path

$liveServer   = Join-Path $Repo "build\dist\server"
$testServer   = Join-Path $Repo "build\dist\testserver"
$liveClient   = Join-Path $Repo "build\dist\client"
$testClient   = Join-Path $Repo "build\dist\testclient"
$testSettings = Join-Path $testServer "server-settings.json"
$backendEnv   = Join-Path $Repo "skymp5-backend\.env"
$backendData  = Join-Path $Repo "skymp5-backend\data"
$mongoCfg     = Join-Path $Repo "deploy\mongodb\mongod-test.cfg"
$livekitSrc   = Join-Path $Repo "deploy\livekit\livekit-test.yaml"
$livekitLive  = "C:\Alduinak\livekit"
$livekitRoot  = "C:\Alduinak\livekit-test"
$livekitCfg   = Join-Path $livekitRoot "livekit.yaml"
$mongoRoot    = "C:\Alduinak\mongodb-test"
$MongoUser    = "skympuser"

function Say($msg) { Write-Host "[testserver] $msg" }

# KEY=value lines of a .env file, quotes stripped
function Read-EnvValue([string] $file, [string] $key) {
  if (-not (Test-Path $file)) { return "" }
  $line = Get-Content $file | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -Last 1
  if (-not $line) { return "" }
  return ($line -replace "^\s*$key\s*=", "").Trim().Trim('"').Trim("'")
}

# The game server and node read JSON as UTF-8 without a BOM, which Set-Content cannot write
function Write-Utf8NoBom([string] $path, [string] $text) {
  [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# Runs JS from a temp file with its inputs in the environment: PowerShell 5.1 strips double quotes from native args
function Invoke-NodeScript([string] $js, [hashtable] $vars) {
  $tmp = Join-Path $env:TEMP ("alduinak-testserver-" + [guid]::NewGuid().ToString("n") + ".js")
  Write-Utf8NoBom $tmp $js
  foreach ($k in $vars.Keys) { Set-Item -Path "Env:$k" -Value ([string] $vars[$k]) }
  try {
    & $node $tmp
    if ($LASTEXITCODE -ne 0) { throw "node exited with $LASTEXITCODE" }
  } finally {
    foreach ($k in $vars.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

function Add-FirewallRule([string] $name, [string] $proto, [string] $ports) {
  netsh advfirewall firewall show rule name="$name" | Out-Null
  if ($LASTEXITCODE -eq 0) { Say "firewall rule '$name' already exists"; return }
  netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=$proto localport=$ports | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "netsh failed adding rule '$name' (exit $LASTEXITCODE)" }
  Say "opened $proto $ports ($name)"
}

# Tools
$nssm = Join-Path $Repo "server-manager\tools\nssm.exe"
if (-not (Test-Path $nssm)) { $nssm = "C:\tools\nssm\nssm.exe" }
if (-not (Test-Path $nssm)) { throw "nssm not found (server-manager\tools or C:\tools\nssm)" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "node.exe not found; install Node.js or put it on PATH" }
$mongod = (Get-ChildItem "C:\Program Files\MongoDB\Server\*\bin\mongod.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $mongod) { throw "mongod.exe not found under C:\Program Files\MongoDB\Server; run deploy\mongodb\setup-mongodb.ps1 first" }
$mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
if (-not $mongosh) {
  foreach ($cand in @("$env:LOCALAPPDATA\Programs\mongosh\mongosh.exe", "C:\Program Files\mongosh\mongosh.exe")) { if (Test-Path $cand) { $mongosh = $cand; break } }
}
if (-not $mongosh) { throw "mongosh not found; install the MongoDB Shell (deploy\mongodb\setup-mongodb.ps1 does) and re-run" }

if (-not (Test-Path (Join-Path $liveServer "server-settings.json"))) { throw "live server not found at $liveServer" }
if (-not (Test-Path $DataDir)) {
  throw "Test Data folder $DataDir does not exist. Copy the live one first, e.g.:`n  robocopy `"C:\GOG Games\Skyrim Anniversary Edition\Data`" `"$DataDir`" /E /MT:16"
}
if (-not $MasterKey) {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $MasterKey = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLower()
}

# 1. Folders
Say "1/6 folders"
if (Test-Path $testServer) {
  Say "$testServer already exists; keeping it"
} else {
  Say "copying $liveServer to $testServer (no world, writings, settings, state registries or the live service installer)"
  # install-services.bat stops and re-registers the live services against build\dist\server
  robocopy $liveServer $testServer /E /XD world writings /XF "server-settings*.json" "server-settings.json.*" "purged-changeforms-*.json" housing.json zone-spawns.json companions.json pets.json starter-grants.json gathering-picks.json weather-state.json bodies.json install-services.bat /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying the server folder (exit $LASTEXITCODE)" }
}
# The registries the game server reads as empty (docs/docs_test_server.md section 2.1)
$empty = [ordered]@{
  'housing.json'         = '[]'
  'zone-spawns.json'     = '[]'
  'companions.json'      = '{"active":[],"corpses":[],"stored":[]}'
  'pets.json'            = '{"active":[],"released":[]}'
  'starter-grants.json'  = '{}'
  'gathering-picks.json' = '{}'
  'weather-state.json'   = '{}'
}
foreach ($name in $empty.Keys) {
  $f = Join-Path $testServer $name
  if (-not (Test-Path $f)) { Write-Utf8NoBom $f $empty[$name]; Say "created empty $name" }
}
New-Item -ItemType Directory -Force -Path (Join-Path $testServer "writings") | Out-Null
if (Test-Path $testClient) {
  Say "$testClient already exists; keeping it"
} elseif (Test-Path $liveClient) {
  Say "copying $liveClient to $testClient"
  robocopy $liveClient $testClient /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying the client folder (exit $LASTEXITCODE)" }
} else {
  Write-Warning "$liveClient is missing; the manager's Build client seeds $testClient later"
}
New-Item -ItemType Directory -Force -Path $LogDir, "$mongoRoot\data", "$mongoRoot\log", $livekitRoot | Out-Null

# 2. MongoDB test service
Say "2/6 MongoDB (AlduinakMongoTest on 27018)"
if (-not (Get-Service AlduinakMongoTest -ErrorAction SilentlyContinue)) {
  Say "registering AlduinakMongoTest from $mongoCfg"
  $p = Start-Process $mongod -ArgumentList "--config `"$mongoCfg`" --install --serviceName AlduinakMongoTest --serviceDisplayName `"Alduinak MongoDB (test)`"" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "mongod --install failed (exit $($p.ExitCode)); see $mongoRoot\log\mongod.log" }
}
if ((Get-Service AlduinakMongoTest).Status -ne 'Running') { Start-Service AlduinakMongoTest; Start-Sleep -Seconds 5 }
if ((Get-Service AlduinakMongoTest).Status -ne 'Running') { throw "AlduinakMongoTest is not running; check $mongoRoot\log\mongod.log" }
# The localhost exception lets the first user be created without auth; the JS uses no double quotes and reads the password from the environment
$js = @"
try {
  db = db.getSiblingDB('admin');
  db.createUser({ user: '$MongoUser', pwd: process.env.ALDUINAK_MONGO_PWD, roles: [ { role: 'readWrite', db: 'skymp' }, { role: 'dbAdmin', db: 'skymp' } ] });
  print('CREATED');
} catch (e) {
  if (/already exists/.test(e.message)) { print('EXISTS'); }
  else if (/requires authentication/.test(e.message)) { print('SKIPPED'); }
  else { print('FAILED: ' + e.message); quit(1); }
}
"@
$env:ALDUINAK_MONGO_PWD = $MongoPassword
try { $out = & $mongosh "mongodb://127.0.0.1:27018/admin" --quiet --eval $js }
finally { Remove-Item Env:ALDUINAK_MONGO_PWD -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { throw "mongosh failed during 'createUser' (exit $LASTEXITCODE): $out" }
switch ("$out".Trim()) {
  'CREATED' { Say "created user $MongoUser on the test mongod" }
  'EXISTS'  { Say "user $MongoUser already exists on the test mongod" }
  'SKIPPED' { Say "skipped creating ${MongoUser}: auth is on and a user already exists (localhost exception closed)" }
  default   { throw "createUser did not succeed: $out" }
}

# 3. LiveKit test service
Say "3/6 LiveKit (AlduinakLiveKitTest on 7890/7891, UDP 50300-50500)"
$lkExe = Join-Path $livekitRoot "livekit-server.exe"
foreach ($bin in 'livekit-server.exe', 'lk.exe') {
  $dst = Join-Path $livekitRoot $bin
  $src = Join-Path $livekitLive $bin
  if ((-not (Test-Path $dst)) -and (Test-Path $src)) { Copy-Item $src $dst; Say "copied $bin from $livekitLive" }
}
if (-not (Test-Path $lkExe)) { throw "$lkExe is missing and $livekitLive has no livekit-server.exe; run deploy\livekit\setup-livekit.ps1 first" }
if (Test-Path $livekitCfg) {
  Say "$livekitCfg already exists; keeping its keys"
} else {
  Say "generating LiveKit API keys"
  # No stderr redirection: generate-keys prints to stdout, and 2>&1 under EAP=Stop turns stderr logging into a fatal error
  $keys = & $lkExe generate-keys | Out-String
  if ($LASTEXITCODE -ne 0) { throw "generate-keys failed (exit $LASTEXITCODE)" }
  $apiKey    = ([regex]::Match($keys, "(?im)^\s*API Key:\s*(\S+)")).Groups[1].Value
  $apiSecret = ([regex]::Match($keys, "(?im)^\s*API Secret:\s*(\S+)")).Groups[1].Value
  if (-not $apiKey -or -not $apiSecret) { throw "Could not parse generated keys; run '$lkExe generate-keys' manually and edit $livekitCfg" }
  $cfg = Get-Content $livekitSrc -Raw
  $cfg = $cfg -replace "REPLACE_API_KEY", $apiKey -replace "REPLACE_API_SECRET", $apiSecret
  Set-Content -Path $livekitCfg -Value $cfg -Encoding UTF8
  Say "wrote $livekitCfg with a fresh key/secret (keep them secret)"
}
# The key pair under keys:, skipping comment lines
$m = [regex]::Match((Get-Content $livekitCfg -Raw), "(?m)^keys:\s*\r?\n(?:\s*#[^\r\n]*\r?\n)*\s+(\S+):\s*(\S+)")
if (-not $m.Success) { throw "cannot read the API key pair from $livekitCfg" }
$lkKey = $m.Groups[1].Value
$lkSecret = $m.Groups[2].Value
Add-FirewallRule "Alduinak LiveKit Test TCP" TCP "7890,7891"
Add-FirewallRule "Alduinak LiveKit Test UDP" UDP "50300-50500"
if (-not (Get-Service AlduinakLiveKitTest -ErrorAction SilentlyContinue)) {
  Say "registering AlduinakLiveKitTest service"
  & $nssm install AlduinakLiveKitTest $lkExe "--config" $livekitCfg | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm install AlduinakLiveKitTest failed (exit $LASTEXITCODE)" }
  & $nssm set AlduinakLiveKitTest AppDirectory $livekitRoot | Out-Null
  & $nssm set AlduinakLiveKitTest DisplayName "Alduinak LiveKit (test)" | Out-Null
}
if ((Get-Service AlduinakLiveKitTest).Status -eq 'Running') {
  Say "AlduinakLiveKitTest already running"
} else {
  & $nssm start AlduinakLiveKitTest | Out-Null
  Say "AlduinakLiveKitTest started"
}

# 4. Test server-settings.json, derived from the live file
Say "4/6 server-settings.json"
if (Test-Path $testSettings) {
  Say "$testSettings already exists; keeping it"
} else {
  $address = Read-EnvValue $backendEnv "SERVER_ADDRESS"
  if (-not $address) { Write-Warning "SERVER_ADDRESS is empty in $backendEnv; the voice URL falls back to the live voiceChat host" }
  $derive = @'
const fs = require('fs');
const e = process.env;
const live = JSON.parse(fs.readFileSync(e.ALDUINAK_TS_LIVE, 'utf8'));
const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const testData = norm(e.ALDUINAK_TS_DATADIR);
// The live Data folder: the dataDir key, else the folder of the first plugin
let prefix = live.dataDir ? norm(live.dataDir) : '';
if (!/^[a-z]:\//i.test(prefix) && Array.isArray(live.loadOrder) && live.loadOrder.length) prefix = norm(live.loadOrder[0]).replace(/\/[^/]*$/, '');
const swap = list => (Array.isArray(list) ? list : []).map(p => {
  const n = norm(p);
  if (prefix && n.toLowerCase().startsWith(prefix.toLowerCase() + '/')) return testData + n.slice(prefix.length);
  console.warn('[settings] not under the live Data folder, kept as is: ' + p);
  return p;
});
const liveVoice = live.voiceChat || {};
const address = e.ALDUINAK_TS_ADDRESS || String(liveVoice.url || '').replace(/^wss?:\/\//, '').replace(/[:/].*$/, '') || '127.0.0.1';
const out = Object.assign({}, live, {
  name: 'Test Server',
  gamemodePath: 'gamemode.js',
  port: Number(e.ALDUINAK_TS_PORT),
  maxPlayers: Number(e.ALDUINAK_TS_MAXPLAYERS),
  playerSlots: Number(e.ALDUINAK_TS_MAXPLAYERS),
  logDir: norm(e.ALDUINAK_TS_LOGDIR),
  masterKey: e.ALDUINAK_TS_MASTERKEY,
  databaseDriver: 'mongodb',
  databaseName: 'skymp',
  databaseUri: 'mongodb://skympuser:' + encodeURIComponent(e.ALDUINAK_MONGO_PWD) + '@127.0.0.1:27018/skymp?authSource=admin',
  dataDir: testData,
  loadOrder: swap(live.loadOrder),
  archives: swap(live.archives),
  voiceChat: Object.assign({}, liveVoice, { url: 'ws://' + address + ':7890', apiKey: e.ALDUINAK_TS_LK_KEY, apiSecret: e.ALDUINAK_TS_LK_SECRET, room: 'alduinak-test' }),
  securityAlertChannelId: '',
  dailyRestartAt: 'off',
  access: { locked: false, lockedRoleIds: [], lockedDiscordIds: [], whitelistRoleId: '', bannedRoleId: '', staffOnlyRoleIds: ['1521259484859863190', '1521259396481421475'] },
});
if (out.discordAuth && Array.isArray(out.discordAuth.guilds)) {
  out.discordAuth = Object.assign({}, out.discordAuth, { guilds: out.discordAuth.guilds.map(g => Object.assign({}, g, { eventLogChannelId: '' })) });
}
const missing = out.loadOrder.filter(p => !fs.existsSync(p));
for (const p of missing) console.warn('[settings] plugin missing from the test Data folder: ' + p);
fs.writeFileSync(e.ALDUINAK_TS_OUT, JSON.stringify(out, null, 2) + '\n');
console.log('[settings] ' + out.loadOrder.length + ' plugins, ' + out.archives.length + ' archives, ' + missing.length + ' missing from ' + testData);
'@
  Invoke-NodeScript $derive @{
    ALDUINAK_TS_LIVE = (Join-Path $liveServer "server-settings.json"); ALDUINAK_TS_OUT = $testSettings
    ALDUINAK_TS_PORT = $Port; ALDUINAK_TS_MAXPLAYERS = $MaxPlayers; ALDUINAK_TS_LOGDIR = $LogDir
    ALDUINAK_TS_MASTERKEY = $MasterKey; ALDUINAK_MONGO_PWD = $MongoPassword; ALDUINAK_TS_DATADIR = $DataDir
    ALDUINAK_TS_ADDRESS = $address; ALDUINAK_TS_LK_KEY = $lkKey; ALDUINAK_TS_LK_SECRET = $lkSecret
  }
  Say "wrote $testSettings (master key $MasterKey)"
}

# 5. Game service
Say "5/6 game service (AlduinakTestServer on UDP $Port)"
$wsPortTest = Read-EnvValue $backendEnv "WS_PORT_TEST"
if (-not $wsPortTest) { $wsPortTest = "7779" }
if (-not (Get-Service AlduinakTestServer -ErrorAction SilentlyContinue)) {
  Say "registering AlduinakTestServer"
  & $nssm install AlduinakTestServer $node "dist_back\skymp5-server.js" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm install AlduinakTestServer failed (exit $LASTEXITCODE)" }
}
& $nssm set AlduinakTestServer AppDirectory $testServer | Out-Null
& $nssm set AlduinakTestServer DisplayName "Alduinak Test Server" | Out-Null
& $nssm set AlduinakTestServer AppStdout (Join-Path $LogDir "gameserver.log") | Out-Null
& $nssm set AlduinakTestServer AppStderr (Join-Path $LogDir "gameserver-err.log") | Out-Null
& $nssm set AlduinakTestServer AppRotateFiles 1 | Out-Null
& $nssm set AlduinakTestServer AppRotateBytes 10485760 | Out-Null
& $nssm set AlduinakTestServer AppEnvironmentExtra "WS_PORT=$wsPortTest" "ALDUINAK_LOG_DIR=$LogDir" | Out-Null
& $nssm set AlduinakTestServer Start SERVICE_DEMAND_START | Out-Null
& $nssm set AlduinakTestServer AppThrottle 5000 | Out-Null
Say "AlduinakTestServer configured (manual start, WS_PORT=$wsPortTest, logs in $LogDir)"
Add-FirewallRule "Alduinak Test Game UDP $Port" UDP "$Port"

# 6. Backend seeds
Say "6/6 backend seeds in $backendData"
$clientFiles = Read-EnvValue $backendEnv "CLIENT_FILES_DIR"
if (-not $clientFiles) { $clientFiles = Join-Path $Repo "build\client-files" }
$manifest = Join-Path $backendData "manifest.json"
$manifestTest = Join-Path $backendData "manifest-test.json"
if (Test-Path $manifestTest) {
  Say "manifest-test.json already exists; keeping it"
} elseif (Test-Path $manifest) {
  # -Encoding UTF8: PowerShell 5.1 reads a BOM-less file as ANSI and would double-encode non-ASCII names
  Write-Utf8NoBom $manifestTest ((Get-Content $manifest -Raw -Encoding UTF8) -replace '/files/extras/', '/files/extras-test/')
  Say "wrote manifest-test.json from manifest.json"
} else {
  Write-Warning "$manifest is missing; Update modlist on the Test Server creates manifest-test.json"
}
$extras = Join-Path $clientFiles "extras"
$extrasTest = Join-Path $clientFiles "extras-test"
if (Test-Path $extrasTest) {
  Say "extras-test already exists; keeping it"
} elseif (Test-Path $extras) {
  robocopy $extras $extrasTest /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying $extras (exit $LASTEXITCODE)" }
  Say "copied extras to extras-test"
} else {
  Say "no extras folder at $extras; nothing to copy"
}
$modlist = Join-Path $backendData "modlist.json"
$modlistTest = Join-Path $backendData "modlist-test.json"
if (Test-Path $modlistTest) { Say "modlist-test.json already exists; keeping it" }
elseif (Test-Path $modlist) { Copy-Item $modlist $modlistTest; Say "copied modlist.json to modlist-test.json" }
$versions = Join-Path $backendData "versions.json"
if (Test-Path $versions) {
  $seedVersions = @'
const fs = require('fs');
const file = process.env.ALDUINAK_TS_VERSIONS;
const v = JSON.parse(fs.readFileSync(file, 'utf8'));
if (v.test && typeof v.test === 'object') {
  console.log('[versions] test block already present: ' + JSON.stringify(v.test));
} else {
  v.test = { client: v.client || '', server: v.server || '' };
  fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
  console.log('[versions] added test block ' + JSON.stringify(v.test));
}
'@
  Invoke-NodeScript $seedVersions @{ ALDUINAK_TS_VERSIONS = $versions }
} else {
  Write-Warning "$versions is missing; the manager's version fields create it"
}

Write-Host ""
Say "done. Next:"
Write-Host "  1. Restart AlduinakBackend: it lists the Test Server and opens the test console relay on port $wsPortTest (WS_PORT_TEST in skymp5-backend\.env)."
Write-Host "  2. Restart the Server Manager, then start the Test Server from its Console tab (Test Server > Start all)."
Write-Host "  3. Delete the stale $Repo\testserver folder if it still exists; the backend reads build\dist\testserver now."
Write-Host "  4. Bump the launcher version and Build launcher so players get per-server manifests."
Write-Host "  Master key of the test server: $MasterKey (in $testSettings)."
