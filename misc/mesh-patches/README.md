# mesh-patches

Byte patches for third-party meshes that ship inside a BSA. A script reads the original from the archive, checks its
sha256 and the bytes it expects, applies the patch and checks the result. It writes a loose NIF under `--out`, which then
ships through the `Alduinak Mesh Fixes` MO2 mod. The archive is only read and never changed.

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

If Capital Windhelm Expansion ships a new `WindhelmSSE.bsa`, the source hash check fails. Diagnose the new mesh before
you patch it again.

### Deploy

1. Run the script with `--out "C:/MO2/mods/Alduinak Mesh Fixes"`, or copy the `meshes` folder from a staging run
   into that mod.
2. Stop the backend. It holds `install-manifest.json` open, and that blocks the swap.
3. Run manager Update manifest. Expect `mods ~1, files +1`.
4. Start the backend again. The manifest route reads the file on every request, so nothing else needs a restart.
5. Run Sync Data.

No build, plugin run or game service restart is needed. The launcher reinstalls only `Alduinak Mesh Fixes` on each
player's next launch.

To roll back, delete the loose NIF, then repeat steps 2 to 5.

Leave the stairs and the disabled grate `051685EA` as they are in the plugin, because the mesh is the fix. If a Creation
Kit save drops the grate override, restore it before deploying, or the grate closes the stairs again.
