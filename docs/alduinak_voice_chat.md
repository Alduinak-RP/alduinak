# Voice chat (VOIP): current state and realistic path

## TL;DR

Voice chat does **not** exist in this codebase, and it does not exist in
mainline skymp either. It exists only as **unmerged, low-maturity pull
requests** on the upstream skymp project. The build flags in the circulating
"SkyMP Build Instructions" note are **fictional** and one of them actively
breaks the build:

- `-DSKYMP_VOICE_CHAT=ON` - there is no such CMake option; nothing reads it, so
  it is silently ignored.
- `-DVCPKG_MANIFEST_FEATURES=voice-chat` - there is no `voice-chat` feature in
  `vcpkg.json` (only `skyrim-flatrim`, `skyrim-vr`, `build-nodejs`,
  `prebuilt-nodejs`). Passing this makes vcpkg **abort** the configure step with
  an unknown-feature error.

Do not pass either flag. Enabling voice is a port-plus-new-infrastructure
project, not a configuration change.

## What voice chat actually is in the skymp ecosystem

It is **browser-based WebRTC** running inside the game's embedded CEF/Chromium
UI, with a **LiveKit** SFU (media server) relaying audio - **not** a native C++
opus codec. Audio capture, opus encoding, and transport all happen inside the
in-game browser via `getUserMedia` + WebRTC; the repo carries no audio library.

The relevant upstream work (all CLOSED / UNMERGED):

- skymp PR #2423 "feat: Add Voice Chat" (branch `skyrim-roleplay:feat/voice-chat`).
  Enables the media stream by injecting Chromium command-line switches in
  `MyChromiumApp.cpp` / `MyBrowserProcessHandler.cpp`, and bundles a server API
  + Discord OAuth login. Its front-end voice UI/signaling client is largely
  **absent** from the diff.
- skymp PRs #2778 / #2779 / #2780 "feat(cef): release mic for in-game voice chat
  (WebRTC)" - the isolated ~28-line CEF mic-enable patch (the clean part).

## What it would take to enable it here

This fork descends from an older skymp via SkyrimRoleplay/skyrp and has its own
auth/roleplay stack, so a blind port would collide with our authentication.
Realistic pieces:

1. **CEF mic enable (small, clean).** Apply the ~28-line switch injection into
   `skyrim-platform/src/tilted/ui/MyChromiumApp.cpp`
   (`OnBeforeCommandLineProcessing`, currently an empty stub) and
   `MyBrowserProcessHandler.cpp`. Our files match the pre-patch upstream base, so
   this cherry-picks cleanly. Note the switches include `disable-web-security`
   and `allow-file-access-from-files` - a real relaxation of the in-game
   browser, acceptable only for a trusted first-party UI. Requires a CI rebuild.
2. **Front-end voice module (large).** Author/port the LiveKit WebRTC client
   (mic capture, room join, proximity attenuation) and an in-game voice UI into
   `skymp5-front`. This is the biggest gap - it is not in the upstream PR diff
   and would have to be written or sourced from a LiveKit-based fork.
3. **Server signaling (medium).** A small server-info / token endpoint plus
   settings keys, and npm deps (LiveKit server SDK). Cherry-pick ONLY the voice
   parts of PR #2423 - drop its Discord/auth churn, which conflicts with ours.
4. **A separate media server.** Stand up a standalone **LiveKit** SFU (or coturn
   TURN) - external to this repo entirely.

## Infrastructure / ports

Voice needs its own transport, independent of the game's UDP 7777:

- LiveKit defaults: TCP 7880 (signaling/WS), TCP 7881 (TURN/TLS), a UDP media
  range (e.g. 50000-60000), optional UDP 3478 STUN/TURN.
- Windows Firewall: inbound rules for the signaling TCP port and the UDP media
  range.
- nginx (`setup_nginx.bat`) is TCP/443 only and cannot carry the UDP media; it
  could optionally reverse-proxy the LiveKit WSS signaling, but media must reach
  LiveKit/TURN directly over UDP.

## Recommendation

Treat voice chat as its own project: (i) cherry-pick the CEF mic patch, (ii)
port/author the LiveKit front-end voice module, (iii) add the server signaling
endpoint + settings + deps, (iv) deploy a LiveKit media server with its own
ports/firewall rules. It is a multi-day effort with a new always-on service to
operate, not something to flip on before launch. When you want to commit to it,
that is a good candidate for its own focused work session.
