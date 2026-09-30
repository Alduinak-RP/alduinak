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

## market_roof.py: the Windhelm market roof stops reading past its arrays

Capital Windhelm Expansion's market roof collision (`SurWindhelmCustomMeshes/windhelmUVTweaks/WHMarketRoofCollsion.nif`,
keep the `Collsion` spelling) belongs to STAT `WHmarket04Roof` (`WindhelmSSE.esp` `15C7EE`), placed once as REFR `15C7F9`
in WindhelmWorld (31, 9). Its MOPP ends with the chunk jump `70 00 00 12 32` to code `0x1232`, off the 16-byte chunk
grid, onto a leaf that then emits key `0x86`: big triangle 134 of 64. `hkpCompressedMeshShape::getChildShape` (id 80699)
does not check the index, so any Havok query that reaches the top of the roof's south wall (world x 130380..130600,
y 36640..36700) reads past the big-triangle array. The vanilla puddle decal `Skyrim.esm:000F3C1F` re-applies on every
load of the market and its box query gets there, so each visit could crash a job thread (phoenix6364, 2026-09-29).

The authoring tool wrote the last code byte into the MOPP build-type field (file `0x316C` holds `0xA0`, where 0 to 2 is
valid) and left `0x32` in its place. The script puts it back: file byte `0x4D6C` goes from `0x32` to `0xA0`. The jump
then reaches the chunk at `0x12A0`, which no path ran before. That chunk emits exactly the 35 wall-top triangles (x
130595..130853) that had no collision, and key `0x86` is gone.

`python misc/mopp-check.py "C:/GOG Games/Skyrim Anniversary Edition/Data/WindhelmSSE.bsa"` shows the defect and names
this byte in its `HINT` line. It prints the same kind of hint for other meshes of the modlist with this signature; only
the roof is patched.

```bash
python misc/mesh-patches/market_roof.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
```

It refuses to write anything unless all of these hold:

- the source sha256 is `f96b7539...19ca`
- block 4 is the NIF's only MOPP compressed-mesh shape
- its MOPP emits only the bad key `0x86` and leaves 35 triangles unreachable
- mopp-check restores exactly file byte `0x4D6C`, `0x32` to `0xA0`
- mopp-check reports the result clean: no bad key, stray key, unaligned jump or unreachable triangle
- the result sha256 is `15949916...8341`

Staged on 2026-09-29 in `build/dist/testclient/Data`. To test it in game, load the Windhelm market (WindhelmWorld (31, 8)
and (31, 9)) several times, then stand on or shoot at the south wall top around x 130600..130850, y 36670, z -11800,
which has collision now. A visit without a crash proves little, since the old file crashed only when the heap past the
array held a bad value.

## Deploy

1. Run the script with `--out build/dist/testclient/Data`, or copy the `meshes` folder from a staging run there.
   `testclient/Data` is gitignored. If it is ever recreated before Migrate client (the manager seeds a missing one from
   `build/dist/client`, or a CI dist is extracted there), run the scripts into it again.
2. Client box: set a new Test client version and press Build client. It leaves loose meshes alone.
3. Package `build/dist/testclient/Data` as the Alduinak Client Files Nexus mod (check the NIF is in it), install it into
   MO2, then Update Modlist and Update Version. Testers re-download through the launcher.
4. Live: Migrate client, then the Migrate box Live row (Copy test build, Save).

No server build, plugin run or game service restart is needed.

To roll back, delete the loose NIF from `build/dist/testclient/Data` and repeat steps 2 to 4.
