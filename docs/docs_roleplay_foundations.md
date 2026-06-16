# Roleplay Foundations — Client/Server Contracts

This document describes the **client-side** roleplay features that ship in this
repository (`skymp5-client`, `skymp5-front`) and the **server-side contracts**
the gamemode (`gamemode.js`) must implement for them to work end to end.

The client pieces are already implemented here. The server pieces live in the
private gamemode repo and are referenced below as "gamemode TODO".

---

## 1. Quit Game (main menu)

Fully client-side — **no gamemode work required.**

The login/authorization menu (`skymp5-client` → `authService.ts`,
`browsersideWidgetSetter`) now has a **"quit game"** button. Clicking it sends
the `quitGame` browser event, which the client handles by calling
`win32.exitProcess()` (a graceful process exit exposed by Skyrim Platform).

Localised strings: `quitGame`, `quitGameHint` (en/ru).

---

## 2. Chat channels (`/say`, `/looc`, `/me`, `/admin`)

### Client behaviour (implemented)

The in-game chat (`skymp5-front` → `constructorComponents/chat`) has a channel
selector above the input. Channels and their outgoing prefixes:

| Channel | Button | Prefix prepended to the message |
| ------- | ------ | ------------------------------- |
| Say (default) | `Say`   | *(none — sent verbatim)* |
| LOOC    | `LOOC`  | `/looc ` |
| Me      | `Me`    | `/me ` |
| Admin   | `Admin` | `/admin ` |

Rules:
- **Say is the default** and is sent unprefixed, preserving existing behaviour
  (the server already treats unprefixed chat as in-character speech).
- If the player types an explicit slash-command (text starts with `/`), the
  selected channel prefix is **not** applied — the typed command wins. So
  `/me waves`, `/roll`, `/looc hi` typed by hand keep working.
- The selected channel persists between messages.

Definition: `skymp5-front/src/constructorComponents/chat/channels/index.tsx`
(`CHAT_CHANNELS`, `applyChannel`). To add/rename a channel, edit that array.

### Gamemode TODO (server side, `chatSystem`)

The `ChatSystem` must parse these leading commands on incoming
`cef::chat:send` text and route/format accordingly:

- `/say <text>` — in-character speech, range-limited (default behaviour for
  unprefixed text). Render with the existing default colour.
- `/looc <text>` — local out-of-character. Should be marked so the chat's
  "non-rp" filter can hide it (the front-end hides messages whose styled spans
  carry the `nonrp` type / `plain` category — see `chat/index.js`
  `getMessageSpans`). Suggested colour `#8fb7ff`.
- `/me <text>` — emote / action. The front-end already styles action text with
  the `.action` class (`#c37bdd`); send the message spans with a matching
  `type` so it renders purple. Conventionally rendered as
  `<CharacterName> <text>`.
- `/admin <text>` — admin/staff channel. The front-end already has an `.admin`
  class (`#ce3131`). Restrict who may send and/or receive this server-side.

The colours above are the active-channel colours in
`chat/channels/styles.scss` and mirror the message colours already present in
`chat/styles.scss`, so the selector colour matches the resulting message.

---

## 3. Character selection (up to 3 characters)

### Client behaviour (implemented)

`skymp5-client` → `characterSelectService.ts` renders a character-selection
menu and reports the player's choice. **It is inert until the server opens the
menu**, so it has zero effect on servers that don't use it.

All messages use `MsgType.CustomPacket` with a JSON dump in `contentJsonDump`.

#### Server → Client: open the menu

```json
{
  "customPacketType": "characterSelectMenu",
  "maxCharacters": 3,
  "characters": [
    { "name": "Lydia",  "info": "Level 3 Nord — Whiterun" },
    null,
    null
  ]
}
```

- `maxCharacters` — number of slots to show (defaults to `characters.length`).
- `characters[i]` — a `{ name, info }` summary for a filled slot, or `null`
  for an empty slot. `info` is an optional one-line description.

On receipt the client shows the menu and makes the browser visible/focused.
Filled slots offer **play** and **delete** (delete asks for confirmation);
empty slots offer **create**.

#### Server → Client: close the menu without a choice (optional)

```json
{ "customPacketType": "characterSelectMenuClose" }
```

#### Client → Server: the player's choice

```json
{ "customPacketType": "characterSelectResult", "action": "play",   "slot": 0 }
{ "customPacketType": "characterSelectResult", "action": "create", "slot": 1 }
{ "customPacketType": "characterSelectResult", "action": "delete", "slot": 2 }
```

After the player picks `play`/`create`/`delete`, the client closes the menu
and returns input focus to the game. The gamemode is then responsible for the
follow-up (spawn the chosen character, start character creation, delete and
re-open the menu, etc.).

### Gamemode TODO (server side)

1. **Persistence** — store up to `maxCharacters` characters per player profile
   (custom properties, e.g. `private.characters`). A "character" is the set of
   per-character data you want to swap: appearance, inventory, location,
   skills, faction membership, owned houses, etc.
2. **On login** (after `connectionAccepted` / before handing the player a body)
   send `characterSelectMenu` with the player's saved characters.
3. **Handle `characterSelectResult`**:
   - `play` → load that character's saved state onto the actor and spawn.
   - `create` → run your character-creation flow for that slot, then save.
   - `delete` → remove the saved character in that slot; you may re-send
     `characterSelectMenu` to refresh the list.
4. Enforce the 3-character limit and validate `slot` server-side (never trust
   the client).

### Customising the menu UI

The slot layout is built in `characterSelectService.ts`
(`browsersideWidgetSetter`) using the existing widget form system (`text` and
`button` elements). Adjust there to add fields (e.g. portraits via `icon`
elements) or change labels. Localised strings live in the `translations` map
in the same file.
