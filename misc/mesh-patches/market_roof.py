# Puts back the last MOPP code byte of the Windhelm market roof collision so it stops emitting big triangle 134 of 64.
#   python misc/mesh-patches/market_roof.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
import importlib

from meshpatch import arguments, check, read_source, write_loose

mopp = importlib.import_module('mopp-check')

ARCHIVE = 'WindhelmSSE.bsa'
MESH = 'meshes/SurWindhelmCustomMeshes/windhelmUVTweaks/WHMarketRoofCollsion.nif'
SOURCE_SHA256 = 'f96b7539127b6bf1a83740fc87b73335113b3f5085ad36a7973ca6d46b9619ca'
PATCHED_SHA256 = '159499160f232540298de75684ce76f89182596e6581be70e98774cf73168341'

# bhkMoppBvTreeShape of WHmarket04Roof; its final chunk jump 70 00 00 12 32 lands on the leaf emitting key 0x86
BLOCK, BAD_KEYS, UNREACHABLE = 4, [0x86], 35
RESTORE = (0x4D6C, 0x32, 0xA0)


def main():
    args = arguments(ARCHIVE)
    source = read_source(args.data, ARCHIVE, MESH, SOURCE_SHA256)
    shapes = list(mopp.mopp_shapes(source))
    check([s[0] for s in shapes] == [BLOCK] and shapes[0][2] is not None,
          f'expected MOPP block {BLOCK} with compressed mesh data as the only shape, got {[s[0] for s in shapes]}')
    _block, _ref, c, code, build, base = shapes[0]
    before = mopp.verdict(c, code)
    check(sorted(before['bad']) == BAD_KEYS and len(before['unreachable']) == UNREACHABLE,
          f'bad keys {[hex(k) for k in sorted(before["bad"])]} and {len(before["unreachable"])} unreachable triangles, '
          f'expected {[hex(k) for k in BAD_KEYS]} and {UNREACHABLE}')
    restore = mopp.restore_byte(c, code, build, base)
    check(restore == RESTORE, f'mopp-check restores {restore}, expected {RESTORE}')

    offset, old, new = restore
    patched = source[:offset] + bytes([new]) + source[offset + 1:]
    lines, count = mopp.check_nif(patched)
    check(count == 1 and not lines, 'mopp-check still flags the result: ' + ' / '.join(x.strip() for x in lines))
    after = mopp.verdict(c, code[:-1] + bytes([new]))
    target = write_loose(args.out, MESH, patched, PATCHED_SHA256)

    print(f'source  {ARCHIVE}:{MESH} sha256 {SOURCE_SHA256}')
    print(f'changed 1 byte: 0x{offset:X} {old:02X} -> {new:02X}, the last MOPP code byte the build-type byte held')
    print(f'MOPP block {BLOCK}: {len(before["keys"])} keys with bad key 0x{BAD_KEYS[0]:X} and {UNREACHABLE} unreachable '
          f'triangles -> {len(after["keys"])} keys, none bad, none unreachable')
    print(f'wrote   {target} sha256 {PATCHED_SHA256}')


if __name__ == '__main__':
    main()
