# Roleplay Client — SkyMP Integration

The live backend is the **SkyMP Roleplay** gamemode (a full fork with its
own client/server contracts). This repo's client was therefore aligned to drive
SkyMP through its existing **chat-command** contract rather than inventing
new packets. Each in-game menu builds a SkyMP `/command` and sends it the
same way the chat box does — a customPacket the gamemode reads as
`{ type: 'cef::chat:send', data: '<text>' }`. Results come back through chat.

All menus render as `form` widgets and **preserve SkyMP's chat widget**
(SkyMP's chat `updateOwner` keeps non-chat widgets), so they coexist.

---

## Key bindings (configurable in client settings unless noted)

| Key | Service | Setting | Purpose |
| --- | --- | --- | --- |
| `E` | PlayerActionService | game control `Activate` (Settings > Controls or launcher Game Hotkeys, applies immediately) | Crosshair a player character → interaction menu (follows the game's Activate control on any input device; engine activation of the clone is blocked). Everything else keeps normal activation, so doors still open |
| `X` | PlayerActionService | `altInteractKeyCode` (launcher Server Hotkeys > Interact / Menus; `0` or missing reads as `X`) | Interact / Menus: the one menu key, routed by what the crosshair is on (see below). With the chat settings' "hold the interact key" on, every menu the press opens (player and carried-load `pa:` menus, Personal, housing, pet, the bounty board strongbox and the search window on a body, both engine container windows closed with their Tab key, `closeContainerMenu`) closes when the key is released, which the client reads with an `Input.isKeyPressed` poll while the menu is open (`armHeldMenu` / `claimHeldMenu` in `widgetMenuUtil.ts`). A menu that starts taking typed text (the housing menu's Cut a key prompt, or its rename field taking focus, `housing:typing`) lets go of the key (`releaseHeldMenus`) and stays open until closed. A menu that waits for the server (the player menu's 500 ms `playerMenuState` wait, the housing, pet, strongbox and search replies) stays shut when the key was let go before it could open, unless it was pressed again during the player menu's wait |
| `F6` | BrowserService | `freeCursorKeyCode` | Free / lock the mouse cursor. Focusing the page opens the vanilla cursor when no menu has it; the unfocus that follows keeps it while a vanilla menu that draws the cursor (inventory, container, magic, map, message box and the like) opened in between, and that menu hides it when it closes (SkyrimPlatform `BrowserApiTilted::SetFocused`, logged `Browser unfocused under <menu>, cursor kept` in `skyrim-platform.log`), so a page menu that led into a vanilla one no longer leaves it without a mouse |
| `Enter`, `T` | BrowserService | `chatFocusKeyCodes` | Focus the chat box to type |
| `F1` | BrowserService | `hideUiKeyCode` | Hide every overlay (chat, prompts, nametags, voice banner, open menus) and the vanilla HUD (compass, health, magicka and stamina bars, crosshair, messages, SkyUI widgets; see Vanilla menus); press again to show. The toggle fires on the press edge only, so another key pressed while F1 is still held (push-to-talk, say) leaves the interface as it is. Menu hotkeys and chat focus are inert while hidden; push-to-talk is not: the mic opens as usual, only the banner that shows it is hidden. Every mic open and close writes a `VoiceService: mic open/closed (<why>): ui hidden, page focused, console, key reads down` line to `skyrim-platform.log`, as does a `voice::error` from the page (a new error text at once, the same text again at most every 10 minutes with the count of repeats, and one `voice connected again` line when the room comes back). Server screens (death, trade, consent prompts, character select) bring the interface back |
| `B` | EmoteService | `emoteWheelKeyCode` (launcher Server Hotkeys > Emote Wheel) | Open the emote wheel; the same key closes it again, as do Esc and a right-click. The open wheel holds browser focus, so the front forwards the press and the client matches it with `domKeyCode`: that works for scan codes up to 88 except Num Lock, not for extended keys (arrows, the Insert/Home/Page block, Right Ctrl/Alt, Numpad Enter and /, Windows keys) or mouse buttons. With the chat settings' "hold the emote wheel key" on, the wheel stays open while the key is held (an `Input.isKeyPressed` poll, so any key) and the release plays the emote the wheel last reported as hovered (`emote:hover`) or just closes it. W, A, S, D and Space cancel a playing emote, and drawing a weapon or spell ends it |

Every `...KeyCode` setting also takes a mouse button as DxScanCode 256 + n
(258 middle, 259 Mouse 4, 260 Mouse 5); the launcher's Settings tab captures them.
The chat settings' Controls tab rebinds the same keys in game: an override stored under `keys`
in `Data/Platform/PluginsNoLoad/chat-settings-no-load.js` wins over the
launcher's value as soon as it is saved (`ChatService.applyChatSettings` pushes
it into each service's setter); a missing or `0` entry falls back to the launcher
key read at start, and "Use launcher defaults" clears them all. Each save stamps
the launcher's keys as `keysLauncherSaved`; at start an override whose launcher
key no longer matches that stamp is dropped, so a later launcher change wins
(saves from before the stamp keep their overrides). For the chat key
the override replaces `T` and Enter stays. While a row waits for a press the page
sends `cef::browser:keyCapture` `1` (`0` when it ends), and BrowserService leaves
Esc and the free-cursor key to the page until they are released, so cancelling
or binding one of them does not close the settings panel. A capture only counts
while the page holds browser focus, so a menu that drops focus mid-capture
(trade, death screen, character select) leaves the free-cursor key working.
Like the launcher, the tab warns when a row's key is also another row's,
a fixed client key's (Esc, Tab, Enter, the emote-cancel keys) or one of the
controlmap's game keys (Activate, Jump, Sprint, Sneak, Shout, Toggle POV, which
the client reads with `Input.getMappedKey` and sends inside `keysLauncher`), with
its own line for Interact / Menus on the Activate key. Shared keys still save.

The interact key replaced the Housing (`H`, `housingMenuKeyCode`), Faction
(`G`, `factionMenuKeyCode`), Personal (`U`, `personalMenuKeyCode`), Admin
(`Insert`, `adminMenuKeyCode`) and Mastery (`K`, `masteryMenuKeyCode`) keys;
those settings are no longer read. `PlayerActionService` routes one press:

| Crosshair on | Interact key (`X`) |
| --- | --- |
| anything, while a housing hand-over or faction add-member pick is pending | completes the pick with the player under the crosshair (anything else cancels it); nothing opens |
| a living player character | player interaction menu (same as `E`) |
| a dead player character | the body's inventory through the server search (same as `E`) |
| a door or container | property menu (HousingService); a reference the server does not treat as property shows "That cannot be claimed." |
| anything else or nothing (world NPC, furniture, an item, empty air) | Personal Menu |

When `X` is also the Activate key, the Activate rules win. Menus close with
Escape or their Close button, not with a second `X`.

Chat channel selector (Say / OOC `/ooc` / Me `/me` / Faction `/f`) lives above
the chat input. Quit-to-desktop button is on the login menu.

---

## What each menu fires

### Housing (`X` on a door or container)
The `housing` widget (HousingService). `X` sends `propertyInfoRequest` and
renders the server's `propertyMenu` view: `claimable` (claim), `owner` (rename,
keys, lock, transfer, abandon), `manager` (grant, revoke, rename, and lock when
`canLock`), `keyholder` (lock / unlock), or "You don't own this". A reference
the server does not treat as property shows "That cannot be claimed." instead.
Transfer and grant-container finish with a second `X` on the recipient. See
`docs_roleplay_property_factions.md` for the packets.

### Player actions (`Y`) — look at a player first
| Group | Buttons → command |
| --- | --- |
| Justice | Arrest `/arrest <n>`, Sentence release/banish `/sentence <n> release|banish` |
| Captivity | Capture `/capture <n>`, Release `/release <n>` |
| Combat | Down `/down <n>`, Rise `/rise <n>` |
| Info | Check bounty `/bounty check <n>`, Faction slots `/faction slots <n>` |
| Staff | Sober `/sober <n>`, Feed `/feed <n>`, Clear NVFL `/nvfl clear <n>` |

`<n>` is the targeted actor's name. (SkyMP matches a player by the **first
whitespace token**, so only single-word character names resolve.)

### Personal Menu (`X` on nothing)
The `adminPanel` widget (AdminMenuService), four tabs in this order:
- **Admin**: staff only, once the server confirms a tier. Sub-tabs Players,
  Teleport, Modes, NPCs and Item Spawner, each shown only when the server
  grants its cap; the server enforces the same caps on every action.
- **Faction**: a placeholder for hold management.
- **Skills**: the mastery menu (take up a profession, see rank and hours).
- **Debug**: account, character, ids, position, cell, target, actor values,
  game time and tracked effects, refreshed every 5 s while it is the visible tab.

The main tab row ends in the same knotwork rule as the header; every sub row
(Admin, Faction, and Zones / Add / Pets / Jobs inside NPCs) sits under a thin
gold line with a gap above and below it.

Permissions are enforced **server-side** — unauthorized buttons just reply
"No permission" in chat.

---

## Vanilla menus

`VanillaMenuService` trims the vanilla menus the browser menus replace. It
works at runtime through SKSE's UI natives (`Ui.get*`, `Ui.set*`,
`Ui.invoke*`) on the menus' own ActionScript, read from the SWFs that win in
this load order: SkyUI's `quest_journal.swf` and `hudmenu.swf` inside
`SkyUI_SE.bsa` (plugin archives load over
`Skyrim - Interface.bsa`; no loose copy exists in the MO2 mods). A path that
is not there leaves the menu as it is and writes one `VanillaMenuService: ...`
line to `skyrim-platform.log`.

- **Journal (Esc and J)**: opens on the System page only. The service calls
  `_root.QuestJournalFader.Menu_mc.ShiftTab` to leave the page the engine
  restored (so that page's bottom bar listeners end) and, once `iCurrentTab`
  reads the System tab, sets `bTabsDisabled`, `QuestsTab.disabled` and
  `StatsTab.disabled`, the members `RestoreSavedSettings` sets for the
  engine's own tabs-disabled mode, in which `ShiftTab` and `onTabClick` do
  nothing. The members are written one by one because SkyrimPlatform takes no
  array argument: the `Ui.invokeBoolA(..., [true, true])` call of the first
  version threw on every pass, and the journal was left as it was
  (`Journal Menu left as it is: stays on tab 2`). `QuestsTab`, `StatsTab`, `TabButtonHelp` and the pages behind
  the two tabs (`QuestsFader`, `StatsFader`) are hidden and `SystemTab` moves
  to the middle slot on the first pass that finds `SystemTab`, which runs in
  the `menuOpen` task itself, before the queued invokes land; so neither the
  other tabs nor J's Quests page show while the menu fades in. `SystemTab` is
  centred again once selected (a selected tab can draw at another width), and
  a switch that never lands puts all of them back. J therefore lands where
  Esc does.
- **System page**: lists Settings, Controls and Quit (and anything else the
  engine adds that is not dropped). Quicksave, Save, Load, Installed Content,
  Creations (`$MOD MANAGER`), Mod Configuration and Help get `filterFlag = 0`
  on their entry objects in the `EntriesA` array of
  `...SystemFader.Page_mc.CategoryList_mc.List_mc`, a
  `Shared.CenteredScrollingList` whose `ListFilterer` then neither draws them
  nor lets the keys, mouse wheel or pointer land on them
  (`CalculateMaxScrollPosition`, `UpdateList` and the next/previous match all
  go through `EntryMatchesFilter`). The write goes through SkyrimPlatform's
  `hideMenuListEntries(menu, arrayPath, texts)` (`MenuListApi.cpp`), which
  reads the array with `GFxMovie::GetVariable` on the clip member and sets the
  member on each entry object with `GFxValue::SetMember`. The first version
  (r22) wrote it with SKSE's `UI.SetInt` on
  `...List_mc.entryList.<i>.filterFlag`, a path through the `entryList`
  getter and an array index to a member the entry does not have yet; the
  entries stayed on screen in game. With an older `SkyrimPlatformImpl.dll`
  the service still falls back to that path and logs
  `hideMenuListEntries missing`. The list's `InvalidateData` redraws it with
  `bRecenterSelection` set (on PC it otherwise keeps the selection on
  Quicksave at index 0, and no entry is drawn highlighted), and
  `bAllowUpToTabs` is cleared, so Up on the top entry no longer focuses the
  hidden tab row (Down from there would select `entryList[scrollPosition]`, a
  dropped entry). Should the selection still land on a dropped entry, the
  next update recentres it the same way. The entries stay in `entryList`, so
  `SystemPage.UpdateIndices`, its `IDX_*` members and the engine's
  `SetSaveDisabled` still line up with them (splicing them out would make
  Settings run Quicksave, and `SetSaveDisabled` would get `undefined` for
  the dropped ones). The page adds Installed Content and Creations when it
  first starts, so the list is kept at `_alpha` 0 until a pass finds its
  entries unchanged; a later change trims it again. While unseen the list
  also takes no input: `bDisableInput` is set at once and a
  `setInteractive(false)` is queued after the service's own invokes (the
  page's `startPage`, run by a queued `ShiftTab`, makes the list interactive
  again), so Enter, Right, a gamepad A or a click in the first frames cannot
  run Quicksave or open Load on entries the player cannot see.
  `setInteractive(true)` gives input back once it shows, when the page is in
  `MAIN_STATE` (in its other states the page keeps the list disabled itself).
  Log lines, once a session each: `System page keeps $SETTINGS, $CONTROLS,
  $QUIT, hid ... (native)`, then `System list reaches 3 of N entries` read
  from the list's `iMaxScrollPosition` (a mismatch adds `the hidden entries
  still show`), and `Papyrus paths through entryList read X of N entries, a
  member written to entry 0 reads back Y`, which shows whether SKSE's UI
  natives reach the entry objects at all.
- **Skills menu (StatsMenu)**: vanilla. The Tween menu (Tab) offers Skills
  on Up and the Quick Stats key (`/` by default) opens it; the service only
  logs `Skills menu (StatsMenu) opened` the first time it shows. The Personal
  menu's Skills tab is a separate browser page.
- **HUD with the hide UI key (`F1`)**: `BrowserService.setUiHidden` emits
  `uiHiddenChanged`, and on the next update the service sets `_visible` on
  `_root.HUDMovieBaseInstance` (hudmenu.swf's whole HUD: compass, the three
  bars, crosshair, stealth meter, subtitles, messages) and
  `_root.WidgetContainer` (SkyUI's widgets) in the `HUD Menu` movie. The HUD's
  ActionScript only toggles that clip's children, so the value holds through
  menus opening and closing. The HUD Menu opening again or a load screen
  closing writes it again, and while hidden a check every second writes it
  again should the movie show it (a new HUD movie after a load). Showing the
  interface restores both clips; nothing is written while the interface was
  never hidden.
- **Magicka bar while crafting**: the Crafting Menu pushes the HUD's
  `InventoryMode` (the engine's `CraftingMenu` destructor, id 51303, pops it
  again), and `HUDMenu.ShowElements` hides `Health`, `Magica` and `Stamina` in
  it, as none of them carries an `InventoryMode` flag. While a Crafting Menu is
  open the service keeps `_root.HUDMovieBaseInstance.Magica`, which carries the
  red fatigue end, visible in the health bar's place at the bottom centre (the
  owner's 2026-10-01 request; it stood on the stamina bar's side before): its
  `_x` becomes `Health._x - 193` (the centre of the meter art lies 192.4 px
  right of the magicka origin and 0.6 px left of the health origin, the same in
  SkyUI's and the vanilla `hudmenu.swf`) and its `_y` `Health._y - 48`. At the
  health bar's own height it would cover SkyUI's crafting bottom bar, whose
  top sits 58 px above the visible bottom whatever the safe zone (74.95 px art,
  `_y += safeRect.y - _height + 17`); the magicka art ends 15.5 px above its
  origin, so the lift keeps it above the bar for any safe zone. A health bar
  that shows while the menu is open is hidden (`Health._visible`, checked
  every update) and shown again at the close. The check runs only while
  `Ui.isMenuOpen("Crafting Menu")` holds: SkyrimPlatform sends the update
  before it runs the queued `menuClose`, so one more update follows the
  close, by when the HUD may have shown the health bar again on its own, and
  the line below would then report a health bar the menu never had.
  The clips are found by their
  `_name`, compared without case: Papyrus pools strings without case, so
  `Health` can come back as another script first wrote it. A
  full, idle bar fades out, so the clip is held on frame 40 (`Pause`,
  `METER_PAUSE_FRAME`, the first fully faded in frame of its 200-frame fade)
  through queued `PlayForward(40)` and `gotoAndStop(40)` invokes whenever it
  stands elsewhere. The Crafting Menu does not pause the game and
  `HUDMenu::AdvanceMovie` polls the Survival globals every frame, so the fill
  and the red end are expected to follow each craft at once (from fatigue
  stage 2); the close line below shows whether they did. On close the bar
  goes back to its own place and plays on from frame 40, fading a few seconds
  later as after any other change. Log lines: `Crafting Menu: magicka bar
  moved from x=<a> y=<b> to the health bar's place above the bottom bar, x=<c>
  y=<d>` once a session, `Crafting Menu: the health bar was showing, hidden
  until the menu closes` once a session when that happened, and on
  every close `Crafting Menu closed: HUD magicka <p>% penalty <q>%, player
  magicka <r>% at open, ... at close`: the HUD's own last values beside the
  player's magicka, where a close penalty equal to the `exhaustion=` of the
  last `NeedsService: survival hud` line means the bar followed the crafts;
  `magicka bar left hidden, _root.HUDMovieBaseInstance.Health._name reads
  "<a>" and _root.HUDMovieBaseInstance.Magica._name "<b>"` when the clips are
  not found. The owner's test of 2026-10-01 logged the older `magicka bar left
  hidden, ... Magica or ... Stamina not found` at the first forge, so the bar
  never showed there. That check compared `Stamina` by exact case, the likely
  cause (not proven: the old line did not print what it read).

---

## Loading in

What the client does from the server's `createActor` for the player to a
dressed player with a full pack, and the `skyrim-platform.log` lines that time
it.

**Startup.** The client script starts right after the engine's data load
(`skse message type 8`); `EngineFixes.log` prints `time to main menu <ms>` for
the engine load before it (25.8 s on a 2026-09-30 player log, against about
0.2 s for the client script). `RemoteServer: startup: client services ready N
ms after the client script started` covers the bundle and every service
constructor, `startup: front page loaded N ms after ...` the CEF login page.

**Spawn outfit** (`remoteServer.ts`, `sync/equipment.ts`). The first spawn
pass strips the player once (`removeAllItems`, `unequipAll`), dresses the
saved worn pieces through `setInventory` and applies the server inventory.
Tempered (health above 1) and poisoned pieces stay out of that dress:
`setInventory` can only add a plain copy, which the inventory apply then
swapped for the server's copy, taking the piece off the player again. The
second pass (0.3 s after a load, 1.3 s after an in-game move) does not strip:
it applies the inventory again, and one frame after an apply has landed (its
adds run at the end of the frame) a top-up equips the saved pieces still
unworn, tempered ones included. The strip's apply waits one update so the
dress (queued, it lands at the end of the strip's frame) is in the pack before
the apply compares against it, whichever update callback runs first; applied
in the strip's own frame it would add every dressed piece a second time. The
spawn's applies also run past the 2 s hold that `CraftedExtrasService` arms on
every change between the player and nowhere: the strip and the dress are such
changes, so the hold used to keep the pack down to the worn pieces for about
2 s (and while an inventory menu opened in that window stayed up), and right
after a strip there is no local craft or consume left to protect. Equipment
reports wait for the spawn's apply and top-up (at most 10 s after the strip),
so a tempered or poisoned piece that arrives with the apply is worn before
the first report saves the outfit. The settle check 2.5 s after the last pass
re-dresses once, as before; its line adds `worn as another copy <base ids>`
when a saved piece is worn only as a different copy (the top-up equips by
base form, so with a plain and a tempered sword in the pack the engine may
pick the plain one). The second pass used to strip everything again and skip
its own inventory apply (the first pass had bumped the counter it compared),
and the outfit came on only at the settle re-dress (owner's log 2026-09-22:
both passes 78 ms apart, `3 of 3 saved not worn, worn 0, re-dressing` 2.5 s
later, 26 entries back only after that). An own
`createActor` drops the stored inventory of the previous character, so no
inventory apply can add that pack to the new character before its own
arrives, and a pass of an older spawn does nothing. `applyInventory` no
longer prints each `TESModPlatform.addItemEx` call to the console and queues
one 3D rebuild per apply.

**Timing lines.** Once per spawn, when the outfit settles:
`RemoteServer: spawn timing (spawn N): createActor A ms after the client
script started; load requested +B ms, loaded +C ms, outfit applied +D ms,
inventory applied +E ms, settled +F ms[, race menu open G ms of it]; S
strip(s), T top-up(s) equipping U, I inventory apply(ies) adding X and
removing Y stack(s), Q equip and R unequip event(s); after the outfit apply
F frames, longest L ms, K over 250 ms; inventory N entries, worn W`. One
strip, two inventory applies, `inventory applied` a few frames after `outfit
applied` and nothing removed is the expected shape;
removals mean the local pack held items the server does not have, and many
more unequip events than worn pieces mean something took the outfit off
again. `load requested none` is a spawn by an in-game move. The race menu
close line ends with `open N ms, R race switch(es), F frames, longest L ms,
K over 250 ms`, frames counted on `tick`, which runs in every menu: one long
frame per race switch is the engine building the new race's head and body.

**Own inventory** (`remoteServer.ts`). The player's pack goes back to the
server's last inventory at once when a SetInventory arrives, when a service
asks for it (a refused craft, a repair, a spawn pass) and after a load. A local
change (any `containerChanged` with the player on one side) waits until 5 s
after the last such change, so the server's answer to it lands first; nothing
re-applies on a timer while the pack is untouched, apart from a safety apply
60 s after the last one when no other apply is waiting. The craft hold (2 s)
and the consume hold (10 s) still delay any apply but a spawn's, a SetInventory that comes
within 5 s of a crossbow shot goes on when that block ends, and no apply runs
while an inventory, favourites, magic, container or crafting menu is open. The
applies read the pack through one per-update memo (`getPlayerInventory` in
`sync/inventory.ts`), so readers in the same update share one read.

An `inventoryPatch` custom packet (`entries`) carries, for each item that
changed, every server copy of it, matched by `sameItem` (the server's
`SameItemAs`); a copy with count 0 only names an item now gone. The client puts
those copies in place of its own copies of the item in the server's last full
inventory (`patchInventory`) and handles the result as a SetInventory, so the
spawn check, the crafted-extras check and the emote props see it the same way.
The own CreateActor's inventory is a full one too. A patch with nothing to
apply to (after a reconnect, before the first full inventory) is dropped with an
`inventory patch dropped` line in the platform log. Only a server with the
inventory patch setting on sends them.

---

## Frame rate and script time

`FrameStatsService` (`skymp5-client/src/services/services/frameStatsService.ts`,
built first in `index.ts`) measures what a "low FPS" report needs and writes it
to `skyrim-platform.log`: one line for the first minute of play, one for every
minute that averaged under 30 fps (marked `slow`), and one in five minutes
otherwise.

```
FrameStatsService: frame stats 60 s: 58.9 fps (17.0 ms a frame, worst 212 ms, 3 over 100 ms, 1.2% over 33 ms);
client script 2.31 ms a frame (update 1.94, worst 18.2; tick 0.37, worst 3.1; hooks and native events not counted); 41 server forms
```

- A frame is the time between two `update` events; a gap over 1 s (a load, a
  pause) is left out, and so is a gap with more than two `tick` events in it:
  ticks go on while a menu pauses the Papyrus-driven updates, so a menu visit of
  any length is never counted as a frame. `worst` is the longest frame of the
  minute.
- `client script` is the time the controller's `update` and `tick` dispatch
  takes in an average frame, and the worst single dispatch. `SpApiInteractor`
  times the whole dispatch, so every service's `on` callbacks and every `once`
  callback queued for that frame (spawns, appearance and equipment applies,
  inventory and property applies) are in it. At 60 fps a frame has 16.7 ms, so 2
  ms of script is 12% of it. Outside the measure: the `sendAnimationEvent` and
  Papyrus hooks, native event handlers (hit, equip, menu events) and the few
  callbacks registered on the native `sp.on`/`sp.once` directly (`formView.ts`,
  `remoteServer.ts`).
- `server forms` is how many actors and references the server streams to this
  client at that moment; the per-frame view work grows with it.
- Reading it: low fps with a small script share is the game, the machine or the
  hooks (graphics, mods, the browser overlay); a script share that grows with the
  server forms is the per-frame view code; a large `worst` beside a small
  average is a hitch from a single step.
- The cost is two clock reads per update and per tick.

For a function by function profile, upstream's `ProfilingService` can record a
V8 CPU profile from the client's start: `"enableProfiling": true` and
`"profilingDurationMs": 600000` in the client settings
(`Data/Platform/Plugins/skymp5-client-settings.txt`) write
`profile<number>.cpuprofile` into the game folder when the time is up; Chrome's
DevTools opens it. It is untested on this build.

**Survival, needs and diseases on the client** (`survivalService.ts`,
`needsService.ts`), by reading the code at each version; a native is one call
into the engine:

| Path | Live clients (0.9, before Stage 2) | Release A (1.0.1-b6) | From 2026-10-05 |
|---|---|---|---|
| Every frame | one time compare | the same | the same |
| Every 500 ms | 12 natives: the player, the Loading menu, `isSwimming`, three flame cloak effects at 3 each | 2: the player and `isSwimming`; the cloak after its `effectStart` only | none outside a freezing water area; 2 there, 11 while swimming there, plus one `FrostResist` read when a swim starts |
| Disease guard | 369 natives in one frame every 10 s (123 disease spells at 3 each) | the same 369 every 60 s, and 2 s and 12 s after a hit or effect on the player | 1 + 2 per added spell (about 31), same schedule |
| Contagion check | 5 natives and a pass over the server forms every 60 s | the same | the same |
| A `survivalState` (on change, 6 s apart at most) | about 21: three globals set and read back, the health penalty | the same | about 15: two globals |
| A `needsState` (on change) | about 30: three globals, two penalties, the log line's reads | the same | the same |
| Engine events | `equip`, `unequip`: 1 each | also `effectStart`, `hit`, `magicEffectApply`: 1 each at most | `effectStart` gone |
| Browser widget | pushed only when its content changes; no animation | the same | the same, cold line only |
| Steady rate | about 60 natives a second | about 10 | under 1 |

For scale, the Stage 1 map counted 65 to 70 natives per frame with nobody in
view (about 4,000 a second at 60 fps), 10 more per NPC copy and 15 to 27 per
player copy every frame, and 20 per remote actor at 7.5 Hz for movement: a busy
street is tens of thousands a second. The owner's release A log of 2026-10-05
shows the whole client creating 4,600 to 7,700 engine objects a second, of
which survival's poll made 2. Survival was never more than about 0.2% of the
client's script work, and its one visible cost on the live clients was the
369 call guard run in a single frame every 10 s.

---

## Engine crash guards

**Occlusion plane sets** (`Hooks.cpp` `InstallCompoundFrustumStateGuard`, 1.6
only): for each node it culls, the engine saves one dword per compound-frustum
plane set (`SaveState`, id 76843) into a 256-dword stack buffer and puts them
back afterwards (`RestoreState`, 76844), with no bound, so a view with more
than 255 plane sets (most likely from the dense occlusion planes Warbirds
Whiterun Metropolis adds around Whiterun's outskirts) overwrote a return
address and crashed a culling job thread. Both functions are replaced by
copies that fill the buffer only up to the size its caller passes and keep the
rest on a per-thread stack keyed by the buffer, which the matching restore
applies and drops; with 255 plane sets or fewer they do exactly what the
engine did. `skyrim-platform.log` shows
`Compound frustum save guard installed` at start (or why it was skipped: not
1.6, or the function bytes differ) and `Compound frustum holds N plane sets`
the first time a view goes past the buffer. Stack dumps of later culling
crashes (ids 76553, 32189, 108600) can hold stale SkyrimPlatformImpl.dll
addresses from these copies; that alone does not point at the guard.

**Detached face nodes** (`Hooks.cpp` `InstallFaceMorphJobGuard`, 1.6 only,
2026-10-05): the Face morphing frame stage queues one job (id 26999) per
`BSFaceGenNiNode` the downward pass saw and runs the per-head morph update
(26988) on a job thread. For a dead actor whose eyes are closing that update
reads `node->parent->AsFadeNode()` with no null check, and the job holds only
the node, so a head rebuilt (`DoReset3D` detaches the old face node) or
destroyed between the queueing and the job crashed the thread with a null
read (`SkyrimSE.exe+04328E9`, a dead male Khajiit player copy, crash report
of 2026-10-02). Our client rebuilt dead copies far more often than vanilla:
the on-screen head and tint rebuild, the 3D rebuild after any worn change
(looting a corpse) and the respawn. The guard wraps the call in the job and
skips a node that has no parent any more (a detached node is not drawn, so
nothing is lost), one pointer test per face job; `Face morph job guard
installed` in `skyrim-platform.log`, or why it was skipped. The client also
stops asking for the 3D of a dead copy to be rebuilt (`FormView`
`updateTagAndTint` and `verifyCopyOutfit`, `applyInventory`), which is less
work per frame on a battlefield as well.

**DirectInput device lifetime** (`DInputHook.cpp`, 2026-10-05): the engine's
window procedure recreates the mouse device on every `WM_ACTIVATE`
(`BSInputDeviceManager::ReinitializeMouse`: Unacquire, Release, CreateDevice)
while a loading screen polls input on its serving thread, and SkyrimPlatform's
wrapper around each device deleted itself in `Release` and called the real
device with no lifetime protection, so a poll that had just entered
`GetDeviceState` (which also runs the browser's `OnUpdate` and a log line in
`Acquire`) used a freed device: `RtlEnterCriticalSection` on a destroyed
section, 28 s after launch, in the crash of 2026-10-03 while the owner was
alt-tabbed to Discord during the startup load. The wrapper now keeps a
recursive mutex around every call into the real device, is never deleted
(`Release` drops the real device and nulls the pointer; the few bytes leak
once per activation), answers `DIERR_INPUTLOST` once its device is gone (the
engine zeroes the state and acquires again), and knows from its creation
whether it is the keyboard, which removes the two `GetDeviceInfo` calls every
poll made. The browser update, the hook's task queue and the log lines stay
outside the lock, so the main thread's `Release` never waits on CEF or disk.

**Papyrus update watchdog** (`PapyrusTESModPlatform.cpp`
`TESModPlatform::Update`): SkyrimPlatform's `update` event, and with it every
client step that needs Papyrus (spawn, race menu, needs request, load
handling), runs inside one `TESModPlatform.Add` call dispatched into the
Papyrus VM per frame, and the next one is dispatched only after the last has
run or a load event arrives. A dispatch the VM refuses, or a queued call it
drops, used to stop `update` for the rest of the game session while the game
kept running: a new character on 2026-09-30 loaded into the world with no
race menu and no sync until the game was restarted (only native input lines
were logged after its postLoadGame, so whether `tick` still ran is not known).
A refused dispatch is now retried the next frame, and a call that has not run
after 5 s of continuous unpaused frames is dispatched again; a duplicate runs
as a no-op. The wait starts over while a loading screen or the main menu is
open, while the game is paused or not the active window, and after any gap of
more than 1 s between frames (a hitch or an alt-tab), so those never count as
a stall. `skyrim-platform.log` shows
`TESModPlatform: first Papyrus update N ms after the load event` once per
load, `TESModPlatform: no Papyrus update for N s of game time after M updates,
dispatching TESModPlatform.Add again (re-dispatch K)` (K = 1, 2, 4, ...) and
`TESModPlatform: Papyrus update resumed after K re-dispatch(es)` when it
recovers, and `TESModPlatform: the VM refused the TESModPlatform.Add dispatch
(stack creation failure or queue full)` once a session (the engine's own
wording; a full queue right after a load is the likeliest cause). Reading a
recurrence: a postLoadGame line with no `first Papyrus update` line and no
stall warning after it means `TESModPlatform::Update` itself stopped running
(the SKSE task chain that calls it each frame), which this watchdog does not
cover; a stall warning with no `resumed` line after it means the VM never ran
the re-dispatched call either.

---

## Gamemode patch (leadership bridge)

Stock SkyMP never turns the dashboard's `private.skympAccess` into the
in-game `isLeader` / `isStaff` / `holdId` flags, so every leader/staff command
was denied for everyone. A small `applyAccessToPlayer()` function was added to
the gamemode bundle (called on connect) to do that translation. It logs the raw
`skympAccess` it sees (`[access] …`) so the role-matching checks can be
tuned to the dashboard's actual encoding. (Provided as a patched `gamemode.js`,
not committed — bundle edits are a stopgap; the clean fix belongs in SkyMP's
source.)

---

## Known limitations

- **SkyMP is a fork.** Its structured client packets (`propertyList`,
  `playerDowned`, `playerCaptured`, …) use a 3-arg `sendCustomPacket(actorId,
  name, data)` native that the stock client doesn't have. So the menus can fire
  commands, but SkyMP's rich client-side **visuals** (down/capture poses,
  live property lists) need SkyMP's own client.
- **Disabled services** (kept in tree, unregistered): `ChatService`,
  `CharacterSelectService`, `RestraintService`, `FactionService`. They used
  contracts of our own design that conflict with SkyMP. Re-enable only with
  the matching gamemode, or after rewiring them to SkyMP like Housing.
- **Faction management menu** (assign/transfer Jarl) needs the hold/faction/slot
  IDs from the backend `gamemode.json` to fire the right `/faction` command.
