<#
  Alduinak LiveKit media-server setup. RUN THIS YOURSELF, elevated.
  Downloads the LiveKit server binary, generates API keys into livekit.yaml,
  registers a Windows service, and opens the firewall ports.

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
  [string] $Version = "1.8.0",
  [string] $Root = "C:\Alduinak\livekit"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfgSrc = Join-Path $PSScriptRoot "livekit.yaml"
$cfgDst = Join-Path $Root "livekit.yaml"

New-Item -ItemType Directory -Force -Path $Root | Out-Null

# 1. Download the LiveKit server release. Verify the latest at
#    https://github.com/livekit/livekit/releases if this 404s.
$exe = Join-Path $Root "livekit-server.exe"
if (-not (Test-Path $exe)) {
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

# 2. Generate real API keys and write them into a copy of the config.
Write-Host "[livekit] generating API keys"
$keys = & $exe generate-keys 2>&1 | Out-String
# generate-keys prints lines like "API Key:  APIxxxx" / "API Secret: yyyy"
$apiKey    = ([regex]::Match($keys, "(?im)^\s*API Key:\s*(\S+)")).Groups[1].Value
$apiSecret = ([regex]::Match($keys, "(?im)^\s*API Secret:\s*(\S+)")).Groups[1].Value
if (-not $apiKey -or -not $apiSecret) { throw "Could not parse generated keys; run '$exe generate-keys' manually and edit livekit.yaml." }

$cfg = Get-Content $cfgSrc -Raw
$cfg = $cfg -replace "REPLACE_API_KEY", $apiKey -replace "REPLACE_API_SECRET", $apiSecret
Set-Content -Path $cfgDst -Value $cfg -Encoding UTF8
Write-Host "[livekit] wrote $cfgDst with a fresh key/secret (keep them secret)"

# 3. Firewall: signaling TCP 7880/7881 + UDP media range 50000-50200.
Write-Host "[livekit] opening firewall ports"
netsh advfirewall firewall add rule name="Alduinak LiveKit TCP" dir=in action=allow protocol=TCP localport=7880,7881 | Out-Null
netsh advfirewall firewall add rule name="Alduinak LiveKit UDP" dir=in action=allow protocol=UDP localport=50000-50200 | Out-Null

# 4. Register as a service via nssm (bundled with the server manager).
$nssm = Join-Path $repoRoot "server-manager\tools\nssm.exe"
if (Test-Path $nssm) {
  Write-Host "[livekit] registering AlduinakLiveKit service"
  & $nssm install AlduinakLiveKit $exe "--config" $cfgDst
  & $nssm set AlduinakLiveKit AppDirectory $Root
  & $nssm start AlduinakLiveKit
} else {
  Write-Warning "nssm not found; run manually: `"$exe`" --config `"$cfgDst`""
}

Write-Host ""
Write-Host "[livekit] done. Server listening on 7880 (signaling), media UDP 50000-50200."
Write-Host "[livekit] REMEMBER: in-game voice still needs the client integration (docs/alduinak_voice_chat.md)."
