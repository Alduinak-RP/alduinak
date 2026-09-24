# Voice chat (VOIP): current state and realistic path

## IMPLEMENTED 2026-07-28 - proximity voice is now in this fork

The integration described as "future work" below has been built:

- **SkyrimPlatform (C++)**: CEF media switches unlock mic capture
  (`MyChromiumApp.cpp` / `MyBrowserProcessHandler.cpp`). **Needs a CI flatrim
  rebuild**; until the new `SkyrimPlatform.dll` ships, players can hear but not
  speak.
- **Keyboard guard**: opening the mic makes Chromium register raw keyboard
  input for its key press monitor, which silences DirectInput until alt-tab;
  `DInputHook.cpp` refuses libcef.dll's raw keyboard and mouse registrations
  and logs "refused CEF raw ... input registration".
- **Server**: `skymp5-server/ts/systems/voiceSystem.ts` mints LiveKit HS256
  tokens (identity = the player's actor id in hex, unspoofable). Config =
  `voiceChat` object in `server-settings.json` (enabled/url/apiKey/apiSecret/
  room/rangeUnits; range falls back to `chatRanges.say`). Already built into
  `dist_back` on the box.
- **Front (CEF)**: `skymp5-front/src/utils/VoiceManager.js` + `livekit-client`.
  Joins the room, attaches remote audio, per-participant volume falloff by
  distance, unsubscribes tracks beyond ~1.15x range.
- **Client**: `skymp5-client/src/services/services/voiceService.ts`. Push-to-
  talk on `voicePushToTalkKeyCode` (default V, DX 47, or the in-game rebind
  from the chat Controls tab). The game reads the key while the browser is
  unfocused; while a menu or the chat has focus the game sees no keys, so the
  front reads the same key (`setPttKey`, `KeyboardEvent.code` from
  `domKeyCode`) and reports `voice::ptt` `1`/`0` back, which keeps the
  game-side state and the AFK ping in step. A press while typing in an input
  or the chat line is ignored and a release always closes the mic. A key held
  from a menu into the game reaches neither side's key-up, so the game polls
  it (`Input.isKeyPressed`) and releases once the key is up, or at the latest
  when the menu closes; an engine hold whose release was lost cannot reopen it
  while the key reads up, and the AFK ping goes out at most once a minute. The
  console and a despawned actor force a release. No key-up follows once the
  game loses the foreground and the off-screen page never gets a blur, so on
  `WM_ACTIVATE`/`WA_INACTIVE` SkyrimPlatform (SkyrimPlatformImpl.dll)
  dispatches `skymp5-client:windowInactive` to the page on its next input
  update, and the page closes the mic itself and reports `voice::ptt` `0`; an
  Alt+Tab the page sees in a menu does the same. Mouse buttons and keys with
  no DOM code (Right Ctrl/Alt,
  arrows, Home/End/Ins/Del, Numpad Enter/Divide, Num Lock, Pause) never reach
  the page, so while a menu has focus the game polls them itself and opens the
  mic on a press edge (not while Alt is down or the console is open); the
  typing guard covers DOM keys only. A focused menu hides mouse buttons from
  the engine, so the key-up it sends for a button held as a menu opens is
  ignored while `Input.isKeyPressed` still reads the key down, and the poll
  closes the mic on the real release. Alt+V mode cycling is game-side only;
  a Left or Right Alt bound to push-to-talk is plain push-to-talk and only
  the other Alt cycles.
  Requests a token per actor assignment; pushes peer distances (same world
  only) every 400ms.
- **Talk range**: V + mousewheel picks the speaker's audible range between
  chatRanges.whisper (150u) and chatRanges.shout (10000u), default say (2000u).
  The range is published to the room over LiveKit's data channel, so LISTENERS
  attenuate by the speaker's chosen loudness (whisperers audible at ~2m,
  shouters at ~143m). A bottom-center meter (chat-tier label + log-scale bar)
  shows while PTT is held or the wheel moves; the choice persists across
  relaunches via `voice-settings-no-load`.
- **Launcher**: "Voice Push-to-Talk" picker in Server Hotkeys; the hotkey-wipe
  bug in `writeClientSettings` is fixed so rebinds survive launches. The chat
  settings Controls tab rebinds it in game too, and that override wins until
  the key is changed in the launcher again.

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
  front emits `voice::speaking` (`[{id, level}]` of actor ids, own id
  included while the mic is live, every 150 ms while anyone talks); the
  client's `LipSyncService` turns it into face phonemes on those actors.
  No speaking state crosses the game server: the talker sends nothing
  about its mouth, each viewer animates the copies it can hear from its
  own LiveKit room, so a mouth stuck on your screen is never seen by
  anyone else, and a copy's mouth on your screen depends only on your
  client. A speaker who leaves the report (release, out of range, track
  gone) or whose reports stop for 600 ms gets the phonemes zeroed and a
  full expression reset (`resetExpressionOverrides`), repeated 400 ms
  later. The front also sends `voice::stopped <identity>` the moment a
  voice ends (track muted or unsubscribed, participant left, gain dropped
  to 0, own PTT released), and the client closes that mouth at once.
  Every expression native (`setExpressionPhoneme`, `resetExpressionOverrides`)
  is SKSE's, and SKSE does not run it in place: it queues a task from a
  fixed pool of 10 that refills once per game frame, and when the pool is
  empty the write is dropped silently, no error, no exception. So the
  service never hands SKSE natives directly: every write goes into one
  queue drained at most 8 per update (two slots left for other mods), a
  close goes to the front of the queue and drops whatever was queued for
  that face, and a close that knows the mouth's last phoneme queues only
  that zero plus the reset (2 tasks) instead of the seven-slot pass, which
  stays for faces whose state is unknown (a sweep, a first-person close, a
  queued animation write that never landed). `resetExpressionOverrides`
  is SKSE's `Reset(1.0, expression, modifiers and phonemes)` with a 1 s
  timer, a full face reset, not only an override clear. Every face the
  service ever wrote is kept in a touched list and re-closed by a 1 s
  sweep three more times after its mouth left, then trusted shut; a cell
  change, a camera flip between first and third person, a game load or a
  reconnect re-closes every touched face again, because a face not being
  updated at the moment of a close (own body in first person, a copy
  off-screen or with its 3D unloaded) keeps the last phoneme. The camera's
  transition state between the two views counts as first person, so the
  own face's owed close waits for a real third-person frame. A copy
  re-created under a new local id gets the re-closes on its new face and
  its old id is dropped after one close; a copy that despawned, or a
  talker who left, is forgotten after one close. On top of that, every
  1.5 s the service zeroes the seven mouth phonemes on one visible copy of
  a player that has no talk report at that moment, round robin over them
  (`sweepAll`: every world-model form with an appearance and a loaded 3D
  that is not the local player's own clone, plus the own face outside
  first person), whatever wrote to it and whether this service ever
  touched it; no `resetExpressionOverrides` there, so nothing else is
  fought, and no other service writes expressions today. Cost: seven
  queued writes per 1.5 s. A native that throws on one face no longer
  aborts that tick's lip work on the others: every write is guarded per
  face and each of the three failure lines below is logged once per local
  id. The engine rebuilds a copy's 3D when it comes back on screen, so a
  mouth stuck on a copy heals when the viewer looks away and back: a
  useful check when it happens. Evidence goes to `skyrim-platform.log`
  through `logToPlatformLog`: `sweep re-close <id> ... actor present/gone,
  first/third person`, `copy of <remote id> changed <old> -> <new>`,
  `close <id>: no actor` (or `phoneme write`, `reset`; once per face and
  kind, a queued write whose actor was gone when its frame came), `owed
  player close in third person`,
  `expression writes queued <n>, draining 8 per frame` (once per session,
  when more than 10 writes wait at the start of an update: the burst
  happened), `phoneme write failed <id>: <err>`, `close failed <id>:
  <err>` and `reset failed <id>: <err>` for a native that threw on that
  face, `report names <id> with no local actor for over 2000 ms` for a
  talker this client has no copy of, and `report keeps <id> at level 0`
  for a report that lingers on a silent talker (that one mumbles, it does
  not stick). When a mouth sticks anyway, the next report needs three
  things: whose face it was (your own in third person, or another
  player's copy on your screen), whether looking away and back closed it,
  and both machines' `skyrim-platform.log`. MfgFix is deliberately not on
  the client mod list and would not help here: it hooks the engine's
  keyframe update, not SKSE's task pool, so a dropped write stays dropped
  with or without it, and the SKSE phoneme values already persist frame to
  frame until a zero write or a reset lands.
  The same feed
  puts the VOIP glyph (U+E000 in the Tavern font, `misc/voip-glyph`) in front
  of a talking remote player's name tag for 500 ms after each report; the tag
  already reads "Stranger" for unknown characters. With **show player names**
  off (the default) the glyph is drawn alone over the talker, never a name or
  id. It is only ever drawn over other players: the local player has no name
  tag and `LipSyncService` never marks it as speaking. Any other
  speaking-indicator UI built on it must gate names through ff_knownIds or
  it will leak masks.
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
