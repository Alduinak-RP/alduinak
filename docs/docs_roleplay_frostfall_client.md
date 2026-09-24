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
| `X` | PlayerActionService | `altInteractKeyCode` (launcher Server Hotkeys > Interact / Menus; `0` or missing reads as `X`) | Interact / Menus: the one menu key, routed by what the crosshair is on (see below). With the chat settings' "hold the interact key" on, every menu the press opens (player and carried-load `pa:` menus, Personal, housing, pet, and the bounty board strongbox, which is closed with its Tab key) closes when the key is released, which the client reads with an `Input.isKeyPressed` poll while the menu is open (`armHeldMenu` / `claimHeldMenu` in `widgetMenuUtil.ts`). A menu that starts taking typed text (the housing menu's Cut a key prompt, or its rename field taking focus, `housing:typing`) lets go of the key (`releaseHeldMenus`) and stays open until closed. A menu that waits for the server (the player menu's 500 ms `playerMenuState` wait, the housing, pet and strongbox replies) stays shut when the key was let go before it could open |
| `F6` | BrowserService | `freeCursorKeyCode` | Free / lock the mouse cursor |
| `Enter`, `T` | BrowserService | `chatFocusKeyCodes` | Focus the chat box to type |
| `F1` | BrowserService | `hideUiKeyCode` | Hide every overlay (chat, prompts, nametags, voice banner, open menus); press again to show. Menu hotkeys and chat focus are inert while hidden; server screens (death, trade, consent prompts, character select) bring the interface back |
| `B` | EmoteService | `emoteWheelKeyCode` (launcher Server Hotkeys > Emote Wheel) | Open the emote wheel; the same key closes it again, as do Esc and a right-click. The open wheel holds browser focus, so the front forwards the press and the client matches it with `domKeyCode`: that works for scan codes up to 88 except Num Lock, not for extended keys (arrows, the Insert/Home/Page block, Right Ctrl/Alt, Numpad Enter and /, Windows keys) or mouse buttons. With the chat settings' "hold the emote wheel key" on, the wheel stays open while the key is held (an `Input.isKeyPressed` poll, so any key) and the release plays the emote the wheel last reported as hovered (`emote:hover`) or just closes it. W, A, S, D and Space cancel a playing emote, and drawing a weapon or spell ends it |

Every `...KeyCode` setting also takes a mouse button as DxScanCode 256 + n
(258 middle, 259 Mouse 4, 260 Mouse 5); the launcher's Settings tab captures them.
The chat settings' Controls tab rebinds the same keys in game (plus the bounty
board's `bountyBoardMenuKeyCode`, default `N`): an override stored under `keys`
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
or binding one of them does not close the settings panel.

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
