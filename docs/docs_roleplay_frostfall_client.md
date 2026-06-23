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

## Key bindings (all configurable in client settings)

| Key | Service | Setting | Purpose |
| --- | --- | --- | --- |
| `H` | HousingService | `housingMenuKeyCode` | Property panel → `/property …` |
| `Y` | PlayerActionService | `interactMenuKeyCode` | Crosshair a player → justice/captivity/combat/staff commands |
| `U` | PersonalMenuService | `personalMenuKeyCode` | Self hub → help/skills/bounty/property/lecture/training/faction-docs |
| `F6` | BrowserService | `freeCursorKeyCode` | Free / lock the mouse cursor |
| `Enter`, `T` | BrowserService | `chatFocusKeyCodes` | Focus the chat box to type |

Chat channel selector (Say / OOC `/ooc` / Me `/me` / Faction `/f`) lives above
the chat input. Quit-to-desktop button is on the login menu.

---

## What each menu fires

### Housing (`H`)
Hold picker → property picker (SkyMP's 16-property registry is embedded so
the list is real). Buttons:
- `request` → `/property request <id>`
- `approve` / `deny` / `revoke` → `/property <action> <id>` (leader/staff)
- "show my hold" → `/property list`

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

### Personal hub (`U`)
- `/help`, `/skill`, `/bounty`, `/property list`
- Lectures: `/lecture start|end`
- Training: `/train start <skill>` (destruction, restoration, alteration,
  conjuration, illusion, smithing, enchanting, alchemy), `/train end`
- Faction docs: `/faction bbb <factionId>` (collegeOfWinterhold, companions,
  eastEmpireCompany, thievesGuild, bardsCollege)

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
