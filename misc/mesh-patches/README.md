# mesh-patches

Byte patches for third-party meshes that ship inside a BSA. A script reads the original from the archive, checks its
sha256 and the bytes it expects, applies the patch and checks the result. It writes a loose NIF under `--out`, which then
ships with the client files in `build/dist/testclient/Data`. The archive is only read and never changed. `meshpatch.py`
holds the steps the scripts share.

A loose NIF overrides the archive copy whatever the mod order, and keeps doing so after the mod ships a new archive.
After any update of a patched mod, run its script with a staging `--out`. If the source hash check fails, the loose NIF
now hides a changed mesh: delete it (see Deploy) and diagnose the new mesh before you patch it again.

## arena_parapet.py: Windhelm arena stairs work both ways

Capital Windhelm Expansion pens the Windhelm arena pit with invisible collision planes that face inward
(`SurWindhelmCustomMeshes/Experimental/ArenaTestv2Exp.nif`, node `temparenaobject1`, REFR `WindhelmSSE:0501A3FC`).
Graves's staircase (`AlduinakAdditions:2A001F83`) climbs through the north plane at world y 43822. Its landing sits at
z -12078, and the plane's upper band stands 117 units above that. Players walking in pass through the back of the plane.
Players walking out hit its front face and cannot get past.

The script moves the band's two top vertices (block 351 `bhkCompressedMeshShapeData`, chunk 1, vertices 104 and 106,
quantized z 4003 to 2386) down to about 4 units above the landing. This opens the full 504-unit north segment,
x 136750 to 137254. Fighters in the pit are still held by the 129-unit pit wall below it, grate `051685EB` and the pillars.

```bash
python misc/mesh-patches/arena_parapet.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
```

It refuses to write anything unless all of these hold:

- the source sha256 is `8c9b17e7...f8f7`
- the four uint16 values sit at the offsets the NIF structure gives
- the top vertices belong to triangles 12 and 13 only
- exactly 4 bytes change
- no other triangle moves
- both triangles keep their facing and area
- the result sha256 is `1664cae0...37a1`

Leave the stairs and the disabled grate `051685EA` as they are in the plugin, because the mesh is the fix. If a Creation
Kit save drops the grate override, restore it before deploying, or the grate closes the stairs again.

## mopp_restore.py: MOPP code bytes left in the build-type byte

Some meshes of the modlist share one authoring fault: the tool that built their MOPP collision tree wrote the last MOPP
code byte into the build-type byte (the byte just before the code, where 0 to 2 is valid) and left a stray value in its
place. That last byte is the low byte of a final chunk jump or the key of a last leaf, so the tree jumps off the 16-byte
chunk grid, emits a key past the triangle arrays, or emits a key that starts no triangle. Triangles that only the lost
path reached have no collision. `hkpCompressedMeshShape::getChildShape` (id 80699) does not check the key, so a key out
of range reads past an array: that is how the Windhelm market roof crashed a job thread (phoenix6364, 2026-09-29). Stray
keys and holes are memory-safe but still wrong collision.

The script puts the build-type byte back as the last code byte. That restores the tree the tool built: in every file
below, no bad key, stray key, unaligned jump or unreachable triangle is left, and no other byte changes.
`python misc/mopp-check.py <nif|folder|bsa>...` finds this fault and names the byte in its `HINT` line.

The 2026-09-29 scan covered every BSA and loose NIF of the 86 enabled MO2 mods plus the BSAs and loose `Meshes` of the
test Data folder: 50624 NIFs, 9134 MOPP shapes, 19 flagged, all with this fault, 18 distinct paths. The table patches 17
of them. Each result is written to `build/dist/testclient/Data/<path>`. No enabled MO2 mod, test or live Data folder or
`build/dist/client` ships a loose copy of any of these paths, so the game loads the patched copy.

| Mod (archive) | Path | What was wrong | Byte | Placed in game |
|---|---|---|---|---|
| Capital Windhelm Expansion (`WindhelmSSE.bsa`) | `meshes/surwindhelmcustommeshes/windhelmuvtweaks/whmarketroofcollsion.nif` | **out of range**: final jump to 0x1232 emits big triangle 134 of 64; 35 triangles without collision | `0x4D6C` 32 -> A0 | STAT `WHmarket04Roof`, 1 ref, WindhelmWorld (31, 9) |
| Capital Windhelm Expansion (`WindhelmSSE.bsa`) | `meshes/surwindhelmcustommeshes/architecture/newpitcollsion.nif` | final jump to 0x4E32 off the chunk grid; 532 triangles without collision | `0x30116` 32 -> 20 | STAT `WHprison01IntCol`, 1 ref, WindhelmWorld (32, 10) |
| JK's Whiterun Outskirts (`JK's Whiterun's Outskirts.bsa`) | `meshes/xjk womeshes/xjkwowrwalltowercap01.nif` | final jump to 0x102E off the chunk grid; 188 triangles without collision | `0x40E1` 2E -> C0 | STAT `XJKWOWRWallTowerCap01`, 27 refs on the Whiterun walls (Tamriel, WhiterunWorld and WhiterunDragonsreachWorld cells (8, 3), (2, -4), (8, -2)) |
| JK's Riften Outskirts (`JK's Riften Outskirts.bsa`) | `meshes/xjk riftomeshes/xjkriftowoodgatefull.nif` | final jump to 0xD2E off the chunk grid; 28 triangles without collision | `0x4E3B` 2E -> 90 | STAT `XJKRiftGateRoof`, 7 refs at the Riften gates, Tamriel (39..44, -27..-22) |
| Riften Extension - Northshore District (`RiftenExtensionNorth.bsa`) | `meshes/kelretu/rtfarmhouse03.nif` | stray key 0x200003; 1 triangle without collision | `0x579E` 03 -> 79 | STAT `rtfarmhouse03` of both Riften Extension plugins, 2 refs, Tamriel (41, -22), (40, -23) |
| Riften Extension - Southwoods District (`RiftenExtension.bsa`) | `meshes/oaristys/candles/candlebox_off.nif` | stray key 0x100048; 1 triangle without collision | `0x5D06` 15 -> 59 | STAT `CandleBox_Off`, 1 ref, RiftenExtPelts |
| Riften Extension - Southwoods District (`RiftenExtension.bsa`) | `meshes/oaristys/candles/candlebox_on.nif` | stray key 0x100048; 1 triangle without collision | `0x5DF4` 15 -> 59 | STAT `CandleBox_On`, 0 refs |
| Riften Extension - Southwoods District (`RiftenExtension.bsa`) | `meshes/oaristys/clutter/emptywoodbox.nif` | stray key 0xC0015; 1 triangle without collision | `0x3DEA` 15 -> 24 | STAT `EmptyWoodBox`, 1 ref, RiftenExtDun01 |
| Riften Extension - Southwoods District (`RiftenExtension.bsa`) | `meshes/oaristys/dishes/nordgobletset01a.nif` | final jump to 0x3C15 off the chunk grid; 960 triangles without collision | `0xA688` 15 -> 20 | STAT `NordGobletSet01a`, 1 ref, RiftenExtPelts |
| Riften Extension - Southwoods District (`RiftenExtension.bsa`) | `meshes/oaristys/dishes/nordgobletset02b.nif` | final jump to 0x4015 off the chunk grid; 976 triangles without collision | `0xBBC7` 15 -> D0 | STAT `NordGobletSet02b`, 0 refs |
| Winterhold Restored (`Winterhold Restored.bsa`) | `meshes/resources/tueffelachtein/craftingtable/clutterarcheryl.nif` | **out of range**: key 0x60034 reads chunk 0 index 52 of 48; 1 triangle without collision | `0x662` 34 -> 25 | CONT `MWRClutterArcheryL`, 0 refs |
| Winterhold Restored (`Winterhold Restored.bsa`) | `meshes/resources/tueffelachtein/craftingtable/craftingtableendrrack.nif` | stray key 0x80045; 1 triangle without collision | `0x1760` 34 -> 30 | STAT `MWRCraftingTableEndRRack`, 4 refs: MWRBYOHHouse02Int01, MWRBYOHHouse03Int01, MWRMeadHallBasement, MWRJhunalTempleInt |
| Skyrim AE (`Skyrim - Meshes0.bsa`) | `meshes/creationclub/_shared/dungeons/ayleidruins/interior/arceilingwelkydgreen01.nif` | **out of range**: key 0x40068 reads chunk 0 index 104 of 36; 1 triangle without collision | `0x63B` 68 -> 18 | Update.esm STAT `ccBGS_ARCeilingWelkyndGreen01`, 0 refs |
| Skyrim AE (`Skyrim - Meshes0.bsa`) | `meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall01.nif` | stray key 0x40068; 1 triangle without collision | `0xFF1` 68 -> 2E | Update.esm STAT `ccBGS_ARNHall01`, 0 refs |
| Skyrim AE (`Skyrim - Meshes0.bsa`) | `meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall02.nif` | stray key 0x40068; 1 triangle without collision | `0xFEE` 68 -> 2E | Update.esm STAT `ccBGS_ARNHall02`, 0 refs |
| Skyrim AE (`Skyrim - Meshes0.bsa`) | `meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall3way01.nif` | stray key 0x40068; 1 triangle without collision | `0x1FC2` 68 -> 00 | Update.esm STAT `ccBGS_ARNHall3way01`, 0 refs |
| Skyrim AE (`Skyrim - Meshes0.bsa`) | `meshes/creationclub/_shared/dungeons/ayleidruins/interior/arrmcorneroutside01.nif` | stray key 0x40068; 1 triangle without collision | `0x102B` 68 -> 82 | Update.esm STAT `ccBGS_ARRmCornerOutside01`, 0 refs |

Paths are as the archives store them (lower case). "0 refs" means nothing in the load order places the base today; a
script or a later plugin still can, so those are patched too. `RiftenExtension.bsa` ships the same `rtfarmhouse03.nif`
byte for byte; `RiftenExtensionNorth.esp` loads after `RiftenExtension.esp`, so its archive is the one the game uses and
the pinned source. The loose copy replaces both.

Not patched: `meshes/oaristys/clutter/propertysign°.nif` (Riften Extension - Southwoods District; 1 triangle without
collision, `0x3B58` 15 -> 81 would clean it). Its name holds byte `0xB0`, which the game maps to a loose file name
through the player's ANSI code page, so a loose copy would not match on every machine, and no record in the load order
uses the mesh.

```bash
python misc/mesh-patches/mopp_restore.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
```

Each row is handled on its own. The script writes nothing for a row, and exits with an error after the others, unless
all of these hold:

- the archive in `--data` holds the path and its sha256 is the pinned source
- mopp-check flags exactly one MOPP shape and restores it with exactly the pinned byte
- mopp-check reports the patched NIF clean: no bad key, stray key, unaligned jump or unreachable triangle
- the result sha256 is the pinned result

The loose copies must be regenerated after a mod update. After any update of a mod in the table, or a game update that
changes `Skyrim - Meshes0.bsa`, run the script with a staging `--out` before the next client build. A refused row means
the archive now ships a different mesh that the loose copy in `testclient/Data` hides: delete that loose NIF, run
mopp-check on the new archive, and pin new bytes only if it still shows this fault. After a modlist change, rerun
mopp-check over the new or updated archives to find new rows.

The market roof (`WindhelmSSE.esp` STAT `15C7EE`, REFR `15C7F9`; keep the `Collsion` spelling) was staged first under
`meshes/SurWindhelmCustomMeshes/windhelmUVTweaks/WHMarketRoofCollsion.nif` and keeps that name, since file names match
case-insensitively. Its final chunk jump `70 00 00 12 32` landed on a leaf that emits key `0x86`; with `0xA0` restored
it reaches the chunk at `0x12A0`, which emits exactly the 35 wall-top triangles (x 130595..130853) that had no collision.

To test the market roof in game, load the Windhelm market (WindhelmWorld (31, 8) and (31, 9)) several times; the vanilla
puddle decal `Skyrim.esm:000F3C1F` re-applies on every load and its box query reached the bad key. Then stand on or shoot
at the south wall top around x 130600..130850, y 36670, z -11800, which has collision now. A visit without a crash
proves little, since the old file crashed only when the heap past the array held a bad value. The largest holes this
closes are the Whiterun wall tower caps, the Riften gate roofs and `WHprison01IntCol` next to the Palace of the Kings.

## Deploy

1. Run the script with `--out build/dist/testclient/Data`, or copy the `meshes` folder from a staging run there.
   `testclient/Data` is gitignored. If it is ever recreated before Migrate client (the manager seeds a missing one from
   `build/dist/client`, or a CI dist is extracted there), run the scripts into it again.
2. Client box: set a new Test client version and press Build client. It leaves loose meshes alone.
3. Package `build/dist/testclient/Data` as the Alduinak Client Files Nexus mod (check the NIFs are in it), install it into
   MO2, then Update Modlist and Update Version. Testers re-download through the launcher.
4. Live: Migrate client, then the Migrate box Live row (Copy test build, Save).

No server build, plugin run or game service restart is needed.

To roll back, delete the loose NIFs of that script from `build/dist/testclient/Data` and repeat steps 2 to 4.

## freeze_havok.py: object meshes never simulate

Placed and dropped objects keep the pose the server gives them, with no runtime freeze. The script reads the world
model of every MISC, WEAP, ARMO (ground models), BOOK, INGR, ALCH, KEYM, SLGM, SCRL, LIGH, MSTT, ACTI, FURN and CONT
record in the `--data` plugins. A mesh any AMMO record uses is left alone, so arrows still fly and fall. Anchored
client-only pieces (`ANCHORED`: signs, bone alarms, nooses, chandeliers, meat hooks, hanging lanterns) keep their
physics, so they still swing when bumped. In each
`bhkRigidBody(T)` whose motion system is dynamic, it writes motion system fixed (offset 224 = 5), quality fixed
(227 = 0) and mass 0 (180). Keyframed and fixed bodies, layers and shapes stay as they are. A loose mesh in `--client`
wins over the same path in `--data` or its archives, so meshes we already patched are frozen on top of their patch.
Every written mesh, with its source and result sha256, is listed in `freeze_havok.json` under `--out`.

```bash
python misc/mesh-patches/freeze_havok.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition - Test/Data"]
```

The server places a dropped item at the dropper's feet, raised by the lowest point of the item's OBND
(`MpActor::DropItem`), since the item no longer falls into place. Rerun the script after any mod list change.
