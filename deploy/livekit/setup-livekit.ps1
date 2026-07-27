<#
  Alduinak LiveKit media-server setup. RUN THIS YOURSELF, elevated.
  Deploys the LiveKit server binary (reusing X:\Downloads if present),
  generates API keys into livekit.yaml, registers a Windows service, and
  opens the firewall ports. Safe to re-run: keys are only generated once.

  Claude does not run this (downloading binaries, registering services, and
  changing firewall rules are operator actions).

  IMPORTANT: LiveKit is only the media server. In-game voice also needs the
  client-side WebRTC/LiveKit integration, which does NOT exist in this fork yet.
  See docs/alduinak_voice_chat.md before relying on this. Standing up LiveKit
  alone will not produce in-game voice.

  Usage (elevated):
    powershell -ExecutionPolicy Bypass -File deploy\livekit\setup-livekit.ps1
#>
param(
  [string] $Version = "1.13.4",
  [string] $Root = "X:\Alduinak\livekit"
)

$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script elevated (Administrator); it registers a service and firewall rules."
}
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfgSrc = Join-Path $PSScriptRoot "livekit.yaml"
$cfgDst = Join-Path $Root "livekit.yaml"

New-Item -ItemType Directory -Force -Path $Root | Out-Null

# 1. Get the LiveKit server binary: reuse an already-downloaded copy from
#    X:\Downloads if present, otherwise download the release zip. Verify the
#    latest at https://github.com/livekit/livekit/releases if the URL 404s.
$exe = Join-Path $Root "livekit-server.exe"
if (-not (Test-Path $exe)) {
  if (Test-Path "X:\Downloads\livekit-server.exe") {
    Write-Host "[livekit] using existing X:\Downloads\livekit-server.exe"
    Copy-Item "X:\Downloads\livekit-server.exe" $exe
  } else {
    $zip = "$env:TEMP\livekit_$Version.zip"
    $url = "https://github.com/livekit/livekit/releases/download/v$Version/livekit_${Version}_windows_amd64.zip"
    Write-Host "[livekit] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $Root -Force
    if (-not (Test-Path $exe)) {
      $found = Get-ChildItem $Root -Recurse -Filter "livekit-server.exe" | Select-Object -First 1
      if ($found) { Copy-Item $found.FullName $exe -Force }
    }
  }
}
# lk.exe (LiveKit CLI, token generation) rides along if it was downloaded too.
if ((Test-Path "X:\Downloads\lk.exe") -and -not (Test-Path (Join-Path $Root "lk.exe"))) {
  Copy-Item "X:\Downloads\lk.exe" (Join-Path $Root "lk.exe")
}

# 2. Generate API keys once and write them into a copy of the config.
#    Re-runs keep the existing livekit.yaml so credentials never rotate silently.
if (Test-Path $cfgDst) {
  Write-Host "[livekit] $cfgDst already exists; keeping its keys"
} else {
  Write-Host "[livekit] generating API keys"
  # No stderr redirection: generate-keys prints to stdout, and 2>&1 on a native
  # command under EAP=Stop turns any future stderr logging into a fatal error.
  $keys = & $exe generate-keys | Out-String
  if ($LASTEXITCODE -ne 0) { throw "generate-keys failed (exit $LASTEXITCODE)" }
  # generate-keys prints lines like "API Key:  APIxxxx" / "API Secret: yyyy"
  $apiKey    = ([regex]::Match($keys, "(?im)^\s*API Key:\s*(\S+)")).Groups[1].Value
  $apiSecret = ([regex]::Match($keys, "(?im)^\s*API Secret:\s*(\S+)")).Groups[1].Value
  if (-not $apiKey -or -not $apiSecret) { throw "Could not parse generated keys; run '$exe generate-keys' manually and edit livekit.yaml." }

  $cfg = Get-Content $cfgSrc -Raw
  $cfg = $cfg -replace "REPLACE_API_KEY", $apiKey -replace "REPLACE_API_SECRET", $apiSecret
  Set-Content -Path $cfgDst -Value $cfg -Encoding UTF8
  Write-Host "[livekit] wrote $cfgDst with a fresh key/secret (keep them secret)"
}

# 3. Firewall: signaling TCP 7880/7881 + UDP media range 50000-50200 (skip if present).
foreach ($rule in @(
  @{ Name = "Alduinak LiveKit TCP"; Proto = "TCP"; Ports = "7880,7881" },
  @{ Name = "Alduinak LiveKit UDP"; Proto = "UDP"; Ports = "50000-50200" }
)) {
  netsh advfirewall firewall show rule name="$($rule.Name)" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[livekit] firewall rule '$($rule.Name)' already exists"
  } else {
    netsh advfirewall firewall add rule name="$($rule.Name)" dir=in action=allow protocol=$($rule.Proto) localport=$($rule.Ports) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "netsh failed adding rule '$($rule.Name)' (exit $LASTEXITCODE)" }
    Write-Host "[livekit] opened $($rule.Proto) $($rule.Ports)"
  }
}

# 4. Register as a service via nssm (repo tools copy, else the box's C:\tools).
$nssm = Join-Path $repoRoot "server-manager\tools\nssm.exe"
if (-not (Test-Path $nssm)) { $nssm = "C:\tools\nssm\nssm.exe" }
if (Test-Path $nssm) {
  $existing = Get-Service AlduinakLiveKit -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "[livekit] registering AlduinakLiveKit service"
    & $nssm install AlduinakLiveKit $exe "--config" $cfgDst
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)" }
    & $nssm set AlduinakLiveKit AppDirectory $Root
  }
  if ((Get-Service AlduinakLiveKit).Status -eq "Running") {
    Write-Host "[livekit] AlduinakLiveKit service already running"
  } else {
    & $nssm start AlduinakLiveKit
    Write-Host "[livekit] AlduinakLiveKit service started"
  }
} else {
  Write-Warning "nssm not found (server-manager\tools or C:\tools\nssm); run manually: `"$exe`" --config `"$cfgDst`""
}

Write-Host ""
Write-Host "[livekit] done. Server listening on 7880 (signaling), media UDP 50000-50200."
Write-Host "[livekit] REMEMBER: in-game voice still needs the client integration (docs/alduinak_voice_chat.md)."
