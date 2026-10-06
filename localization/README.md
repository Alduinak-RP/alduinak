# Localization

`en_loc.json` holds every line of text the game, the launcher and the Server Manager
show to people. Reword a line here and rebuild the component that owns its section:

| Section | Used by | Rebuild |
|---|---|---|
| `gamemode` | `gamemode_extensions` | manager "Build gamemode only" (inlined into `gamemode.js`; a bundle built without that prelude uses the table "Build server" compiled into the server) |
| `server` | `skymp5-server/ts` | manager "Build server", restart the server |
| `client` | `skymp5-client/src` | client build (new client version) |
| `front` | `skymp5-front/src` | client build (new client version) |
| `launcher` | `skymp5-launcher-tauri` (UI and Rust) | launcher build (new launcher version) |
| `manager` | `server-manager/src` | restart the manager |

Keys are nested by system and looked up with a dotted path relative to the section:
`loc("pet.summoned", { name })` in server code reads `server.pet.summoned`.
`{name}` in a line is replaced by the value passed under that name; a placeholder
with no value is left as is. A missing key shows the key itself, so a typo is
visible in game instead of a blank line.

In plain HTML (launcher, Server Manager) an element with `data-loc="key"` gets its
text from the table on load; `data-loc-title`, `data-loc-placeholder` and
`data-loc-html` (for lines that carry markup) do the same for those attributes and
for inner HTML.

Logs, data catalogs (location, race and item names) and protocol strings stay in code.

`node localization/check-keys.js` lists every `loc("key")` and `data-loc` key in the code
that is missing from `en_loc.json`; add `--unused` to also list keys nothing uses
(keys built at run time, like `loc(\`pet.mode.${mode}\`)`, show as unused).
