# Voice chat (VOIP): current state and realistic path

## IMPLEMENTED 2026-07-28 - proximity voice is now in this fork

The integration described as "future work" below has been built:

- **SkyrimPlatform (C++)**: CEF media switches unlock mic capture
  (`MyChromiumApp.cpp` / `MyBrowserProcessHandler.cpp`). **Needs a CI flatrim
  rebuild**; until the new `SkyrimPlatform.dll` ships, players can hear but not
  speak.
- **Server**: `skymp5-server/ts/systems/voiceSystem.ts` mints LiveKit HS256
  tokens (identity = the player's actor id in hex, unspoofable). Config =
  `voiceChat` object in `server-settings.json` (enabled/url/apiKey/apiSecret/
  room/rangeUnits; range falls back to `chatRanges.say`). Already built into
  `dist_back` on the box.
- **Front (CEF)**: `skymp5-front/src/utils/VoiceManager.js` + `livekit-client`.
  Joins the room, attaches remote audio, per-participant volume falloff by
  distance, unsubscribes tracks beyond ~1.15x range.
- **Client**: `skymp5-client/src/services/services/voiceService.ts`. Push-to-
  talk on `voicePushToTalkKeyCode` (default V, DX 47), suppressed while chat is
  focused; requests a token per actor assignment; pushes peer distances
  (same world only) every 400ms.
- **Talk range**: V + mousewheel picks the speaker's audible range between
  chatRanges.whisper (150u) and chatRanges.shout (10000u), default say (2000u).
  The range is published to the room over LiveKit's data channel, so LISTENERS
  attenuate by the speaker's chosen loudness (whisperers audible at ~2m,
  shouters at ~143m). A bottom-center meter (chat-tier label + log-scale bar)
  shows while PTT is held or the wheel moves; the choice persists across
  relaunches via `voice-settings-no-load`.
- **Launcher**: "Voice Push-to-Talk" picker in Server Hotkeys; the hotkey-wipe
  bug in `writeClientSettings` is fixed so rebinds survive launches.

Rollout order: (1) CI flatrim rebuild -> new SkyrimPlatform.dll into the client
dist, (2) server manager "Build Client" (front + client logic + repackage),
(3) launcher rebuild/redistribute, (4) players re-download via launcher.
LiveKit server + firewall are already live on the box (`AlduinakLiveKit`).

### Trust model and accepted limitations

- **Range gating is client-side.** Every token grants publish+subscribe to the
  one shared room; distance-based volume and unsubscription happen in the CEF
  page. A modified client (or the raw token in any LiveKit web client) can hear
  every speaker server-wide regardless of distance, which partially undermines
  the Stranger/mask anonymity system. Accepted for v1; the fix is a server-side
  range enforcer driving LiveKit's admin API from authoritative positions.
- **Revocation = token expiry.** Tokens live 1 hour and nothing calls the
  LiveKit admin API on kick/ban, so a banned player's existing token keeps
  working against the voice room until it expires.
- **Voice is inherently identifying.** Nothing in the UI ties a LiveKit
  identity to a character name (identities are actor ids, never rendered), but
  a recognizable voice defeats /mask on its own - an RP-rules matter. The
  front emits `voice::speaking` (actor ids); any future speaking-indicator UI
  built on it must gate names through ff_knownIds or it will leak masks.
- **Dead players can talk and hear.** No isDead gate on PTT or listening yet.
- **~200 concurrent voice users max**: the UDP media range is 50000-50200 (one
  port per participant). Widen the range or switch LiveKit to single-port UDP
  mux before the server approaches that.

The historical analysis below is kept for context.

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
