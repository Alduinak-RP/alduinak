# Puts back the last MOPP code byte the authoring tool left in the build-type byte, per pinned NIF (see README.md).
#   python misc/mesh-patches/mopp_restore.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
import importlib

from meshpatch import arguments, check, read_source, write_loose

mopp = importlib.import_module('mopp-check')

# archive, path inside it, source sha256, file offset, old byte, new byte, result sha256
PATCHES = [
    # Capital Windhelm Expansion
    ('WindhelmSSE.bsa', 'meshes/surwindhelmcustommeshes/windhelmuvtweaks/whmarketroofcollsion.nif',
     'f96b7539127b6bf1a83740fc87b73335113b3f5085ad36a7973ca6d46b9619ca', 0x4D6C, 0x32, 0xA0,
     '159499160f232540298de75684ce76f89182596e6581be70e98774cf73168341'),
    ('WindhelmSSE.bsa', 'meshes/surwindhelmcustommeshes/architecture/newpitcollsion.nif',
     'edeaee0bceebf27ab0d7d0be4acb22a44597f7ace2ed344b591d450394574af4', 0x30116, 0x32, 0x20,
     'e3ef5328a7c379a4e7b0ddc4b2a44adca9fdd9b403ead291b3f6243dec1be02d'),
    # JK's Whiterun Outskirts
    ("JK's Whiterun's Outskirts.bsa", 'meshes/xjk womeshes/xjkwowrwalltowercap01.nif',
     '7595662f2a459a52fe690f9318cdfc2146929f37c6f075a7572a37bf016817db', 0x40E1, 0x2E, 0xC0,
     '79a2792152fe8f0c1f5b3b04eace3cabb20d8968bf9d61c2f877f988f1727028'),
    # JK's Riften Outskirts
    ("JK's Riften Outskirts.bsa", 'meshes/xjk riftomeshes/xjkriftowoodgatefull.nif',
     '2eea784e8e6e2b9bc2165863d94f41123f4895cd45e2b32519fcc8f9f17f4ff3', 0x4E3B, 0x2E, 0x90,
     'b24f1107eb4ae8df1c267a82290df57a4ad9f1483f9b55f9e16bcc3165defc4a'),
    # Riften Extension; RiftenExtension.bsa ships the same rtfarmhouse03.nif, RiftenExtensionNorth.esp loads later
    ('RiftenExtensionNorth.bsa', 'meshes/kelretu/rtfarmhouse03.nif',
     'a94d473e915b54606b61e3d11755a7f89d9f0c4340747ebfbc8b4fb304d074bb', 0x579E, 0x03, 0x79,
     '00ec1de036ad1ced8d2b04ad75f01c7be82fa37e39b59c2fa19f87c07c532f34'),
    ('RiftenExtension.bsa', 'meshes/oaristys/candles/candlebox_off.nif',
     '7d674dbe06925b69b7dac83732eb8a7863160ac0137be81f3a7d478dc41fa054', 0x5D06, 0x15, 0x59,
     '12070243bd1876f887a1a93cf1571bac64f62045cc5efa88be8614a5914dfcd9'),
    ('RiftenExtension.bsa', 'meshes/oaristys/candles/candlebox_on.nif',
     '615f13b4b450e5dd394a978004851ba200902134124dcac1ebcf5fd8d56f1325', 0x5DF4, 0x15, 0x59,
     '6f21a753450f8d76ca7a9e0e4177df9b8c4955f8f3841c3faf30c858c9f30fb3'),
    ('RiftenExtension.bsa', 'meshes/oaristys/clutter/emptywoodbox.nif',
     'c721fc3bbb4790bdd4bad5188cb05aa27179ec8feb96c9e14f034319d6649266', 0x3DEA, 0x15, 0x24,
     '472a0b4a11e056a8ce791624795297261957937323819c09af50c504c72715a1'),
    ('RiftenExtension.bsa', 'meshes/oaristys/dishes/nordgobletset01a.nif',
     'ecae3204097c580725e58d49aa5d9b9ee7b0ebd07a856c89b9180e4ddfb08822', 0xA688, 0x15, 0x20,
     '7344136d1963bae326e243ba74a276bd7abf5c7007f20cd0348602f889262e57'),
    ('RiftenExtension.bsa', 'meshes/oaristys/dishes/nordgobletset02b.nif',
     '7f63d93bc47343da044874e4ca0fc7d8705f58e85e2f3a7910c3e29ddf32b947', 0xBBC7, 0x15, 0xD0,
     '89aa7985b4bd4045c01f76942cb8e2381a1d696d939d60b324e75748f20f3952'),
    # Winterhold Restored
    ('Winterhold Restored.bsa', 'meshes/resources/tueffelachtein/craftingtable/clutterarcheryl.nif',
     'ae3e23142d17cc692a21c307627fde6a5941cc9305f1ede87c891fd892645875', 0x662, 0x34, 0x25,
     'b1abcb9f47f14a8a31efc3f72a96fa52b1bffd30469c1ca9a38c5e1c04632099'),
    ('Winterhold Restored.bsa', 'meshes/resources/tueffelachtein/craftingtable/craftingtableendrrack.nif',
     '59f346652488e29927722b1ea014290be5ab8af7c35c0285fe3ba87d50ffd000', 0x1760, 0x34, 0x30,
     'c5f1159258f47db7e9942cf3e1df3aea21e4b5987feb13d0aedfe647b8661724'),
    # Skyrim AE, Creation Club ayleid ruins pieces that Update.esm defines
    ('Skyrim - Meshes0.bsa', 'meshes/creationclub/_shared/dungeons/ayleidruins/interior/arceilingwelkydgreen01.nif',
     'eb497d9490b86df2a5d3ea0231ce7babbf32f7f7b5816d4ed4d88ecf55cd5cbe', 0x63B, 0x68, 0x18,
     '355cd1215c8d12abb56e879ea1642e6823a50e0382f1ab5d71211b0e8efeea40'),
    ('Skyrim - Meshes0.bsa', 'meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall01.nif',
     '4235dcc658cdf84da812bc9703244154dcc923f831e4d61e6f0c8518b4419ac0', 0xFF1, 0x68, 0x2E,
     'a742d79ef53e5221943a9f821a59d605173ed8212d95f5ecff5ce1c2043d773e'),
    ('Skyrim - Meshes0.bsa', 'meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall02.nif',
     '44fdd6de602a6bc6880f43caa37b3e7a26b3dc9520874f6cf59e979a2005e1be', 0xFEE, 0x68, 0x2E,
     '88a8e2a8c70be9101e5d54bfc63550ce4fe72ee7dbf4328fc3759c3e49b39609'),
    ('Skyrim - Meshes0.bsa', 'meshes/creationclub/_shared/dungeons/ayleidruins/interior/arnhall3way01.nif',
     '0e0a62734be556c5e30a7106ed1dc4869f18051f0c76d478c36b5f0e8ade15c4', 0x1FC2, 0x68, 0x00,
     '7ac66d49de9a01d8aaaa8805f71e1e1811576b29e95d6819a4a87ec1c0133011'),
    ('Skyrim - Meshes0.bsa', 'meshes/creationclub/_shared/dungeons/ayleidruins/interior/arrmcorneroutside01.nif',
     'c7fb011ccb4a651ab0cc539f2d1a77d4f125b25fed090120779e856b3a51eb6e', 0x102B, 0x68, 0x82,
     '1ab2dafe6a4a9d1b081ff71ae7fa24e25890f760c1458759289b46e48037f8e2'),
]


def flagged_restores(data):
    """mopp-check's restore byte for each MOPP shape it flags, None where no restore cleans the shape."""
    out = []
    for block, _ref, c, code, build, base in mopp.mopp_shapes(data):
        check(c is not None, f'MOPP block {block} has no compressed mesh data')
        v = mopp.verdict(c, code)
        if v['bad'] or v['stray'] or v['unaligned'] or v['unreachable'] or v['faults']:
            out.append(mopp.restore_byte(c, code, build, base))
    return out


def patch(data, out, archive, mesh, source_sha256, offset, old, new, result_sha256):
    source = read_source(data, archive, mesh, source_sha256)
    restores = flagged_restores(source)
    shown = ', '.join(f'0x{r[0]:X} {r[1]:02X} -> {r[2]:02X}' if r else 'none' for r in restores) or 'nothing'
    check(restores == [(offset, old, new)],
          f'mopp-check restores {shown}, expected only 0x{offset:X} {old:02X} -> {new:02X}')
    patched = source[:offset] + bytes([new]) + source[offset + 1:]
    lines, _count = mopp.check_nif(patched)
    check(not lines, 'mopp-check still flags the result: ' + ' / '.join(x.strip() for x in lines))
    return write_loose(out, mesh, patched, result_sha256)


def main():
    args = arguments('each archive of the table')
    refused = 0
    for archive, mesh, source_sha256, offset, old, new, result_sha256 in PATCHES:
        try:
            target = patch(args.data, args.out, archive, mesh, source_sha256, offset, old, new, result_sha256)
        except SystemExit as e:
            refused += 1
            print(f'{archive}:{mesh}: {e}')
            continue
        print(f'{archive}:{mesh}: 0x{offset:X} {old:02X} -> {new:02X}, clean, wrote {target}')
    check(not refused, f'{refused} of {len(PATCHES)} refused and not written')
    print(f'{len(PATCHES)} of {len(PATCHES)} written')


if __name__ == '__main__':
    main()
