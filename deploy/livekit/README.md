# LiveKit media server for Alduinak voice chat

LiveKit is the WebRTC SFU that would relay in-game voice audio. This kit stands
up the **media server only**.

> **Important:** in-game voice also needs the client-side WebRTC/LiveKit
> integration, which does **not** exist in this fork yet. Running LiveKit alone
> produces no in-game voice. Read
> [`docs/alduinak_voice_chat.md`](../../docs/alduinak_voice_chat.md) for the full
> picture and the remaining client work before investing in this.

## Files here

- `livekit.yaml` - server config (signaling 7880, TCP 7881, UDP media
  50000-50200). Key placeholders are filled in by the setup script.
- `setup-livekit.ps1` - **run yourself, elevated.** Downloads the LiveKit
  binary, generates API keys into a live config copy at `X:\Alduinak\livekit`,
  opens the firewall ports, and registers the `AlduinakLiveKit` service.

## Steps

1. Run the setup (elevated PowerShell):
   ```
   powershell -ExecutionPolicy Bypass -File deploy\livekit\setup-livekit.ps1
   ```
2. Note the generated API key/secret in `X:\Alduinak\livekit\livekit.yaml` -
   the client token endpoint and the in-game voice client will need them.
3. Verify the server is reachable on `127.0.0.1:7880` (and externally if you
   forward the ports at your host/router).

## Ports

- TCP 7880 - signaling / WebSocket
- TCP 7881 - TURN over TLS fallback
- UDP 50000-50200 - RTC media

nginx is not involved (it only serves TCP 443 for the game UI). Media is UDP
straight to LiveKit.
