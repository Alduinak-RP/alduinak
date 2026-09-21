# voip-glyph

Adds the VOIP speaker icon to SkyrimPlatform's Tavern font as the private-use glyph U+E000. Name tags are
SkyrimPlatform DirectX text, which can only draw font glyphs, so `FormView` puts `\uE000 ` in front of the name of a
player who is talking.

`add_glyph.py` decodes the icon PNG (8-bit RGBA), crops it to its alpha, box-downscales it to 36 px high and appends it
to the font texture as premultiplied white. The glyph sits on the baseline of `A` and advances 6 px. It refuses a font
that already has a glyph at or past U+E000, so always run it on the original font. An older font without the glyph
draws its default character `?` instead.

```bash
python misc/voip-glyph/add_glyph.py <original Tavern.spritefont> <voip.png> <out Tavern.spritefont> [height]
```

The tracked font is `client-deps/common/Data/Platform/Fonts/Tavern.spritefont`, made from its previous version (see git
history) and `Desktop/Graphics/voip.png`. Only a full CMake or CI build copies it into
`build/dist/client/Data/Platform/Fonts`; the manager's Build Client does not, so copy it there by hand before a Build
Client.
