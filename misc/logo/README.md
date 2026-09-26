# logo

Downscales the official Alduinak lockup (`Desktop/Graphics/AlduinakLogoOfficial.png`, 1254 px RGBA, transparent
background) into every size the repo ships. Pure Python like `misc/voip-glyph`: it decodes the PNG itself,
resamples by area averaging on premultiplied alpha (so the white art never grows dark fringes), and writes PNGs and
Windows icons (32-bit BMP frames with an AND mask, the layout of the launcher's previous icon).

```bash
python misc/logo/make_logo.py <AlduinakLogoOfficial.png> misc/logo/assets
```

Takes about ten seconds. The outputs in `misc/logo/assets` and where they go:

| File | Size | Used by |
|---|---|---|
| `logo-1024.png` | 1024 px | Discord Developer Portal, Rich Presence art asset `alduinak` (the launcher's presence large image) |
| `menu-title-logo.png` | 800 px | In-game main menu title (`skymp5-front/src/utils/MainMenuMedia.js`), shown at 30% of the viewport height; copy it into the gitignored `skymp5-front/ui-static` on the box before a Build Client, next to `menu-background.webm` and `menu-music.mp3`, and retire `menu-title-dragon.png` and `menu-title-text.png` |
| `logo-96.png` | 96 px | `skymp5-launcher-tauri/ui/assets` (topbar emblem, 40 px) and `skymp5-backend/public/images` (dashboard brand mark, 42 px) |
| `icon.ico` | 16, 24, 32, 48, 64, 128, 256 px | `skymp5-launcher-tauri/src-tauri/icons/icon.ico`: exe, installer, uninstaller and taskbar icon |
| `favicon.ico` | 16, 32, 48 px | `skymp5-backend/public/images/favicon.ico`, the dashboard tab icon |

Rerun it and copy the outputs whenever the source art changes; the copies in the launcher and backend folders are
tracked, the main menu copy is not.
