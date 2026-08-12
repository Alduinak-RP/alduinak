// Main menu background video + music, mounted outside React (the VoiceManager
// pattern). The game client drives it through injected JS:
//   window.__alduinakMenuMedia.show({ musicMuted }) / .hide()
// The mute button reports changes back via
// sendMessage('cef::menuMedia:saveSettings', json); the client persists them
// to disk because CEF storage does not survive a relaunch.
// The media files ship as siblings of index.html (the manager's buildFront
// copies skymp5-front/ui-static there); missing files degrade gracefully.

const VIDEO_SRC = 'menu-background.webm';
const MUSIC_SRC = 'menu-music.mp3';
const TITLE_DRAGON_SRC = 'menu-title-dragon.png';
const TITLE_TEXT_SRC = 'menu-title-text.png';
const MUSIC_VOLUME = 0.5;
const FORM_HEIGHT = 704; // fixed .login-form frame height (login/styles.scss)

// While the menu media is up, the login/character-select panel is pushed below
// the title art and scaled to fit; both values are computed per viewport.
const MENU_CSS = `
body.alduinak-menu-media .login-form {
  margin: var(--alduinak-menu-shift, 45vh) auto auto;
  transform: scale(var(--alduinak-menu-scale, 1));
  transform-origin: top center;
}
`;

class MainMenuMedia {
  constructor() {
    this.root = null;
    this.video = null;
    this.music = null;
    this.button = null;
    this.title = null;
    this.dragonImg = null;
    this.textImg = null;
    this.musicMuted = false;
    this.onResize = () => this.layout();
  }

  sendToGame(name, ...args) {
    try {
      window.skyrimPlatform.sendMessage(name, ...args);
    } catch (e) {
      // running in a plain browser preview
    }
  }

  show(settings) {
    this.musicMuted = !!(settings && settings.musicMuted);
    if (!this.root) this.mount();
    if (this.video) this.video.play().catch(() => {});
    this.applyMute();
    document.body.classList.add('alduinak-menu-media');
    this.layout();
    window.addEventListener('resize', this.onResize);
  }

  // Full unmount so the video decoder does not keep running behind gameplay
  hide() {
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('alduinak-menu-media');
    if (!this.root) return;
    try { this.video && this.video.pause(); } catch (e) {}
    try { this.music && this.music.pause(); } catch (e) {}
    this.root.remove();
    this.root = this.video = this.music = this.button = null;
    this.title = this.dragonImg = this.textImg = null;
  }

  // Title art anchored 1/6 from the top; the form panel starts below it and
  // scales down when the viewport is too short for title + full frame.
  layout() {
    if (!this.root) return;
    const vh = window.innerHeight;
    const top = Math.round(vh / 6);
    const dragonH = Math.round(vh * 0.21);
    const textH = Math.round(vh * 0.055);
    if (this.title) this.title.style.top = top + 'px';
    if (this.dragonImg) this.dragonImg.style.height = dragonH + 'px';
    if (this.textImg) {
      this.textImg.style.height = textH + 'px';
      this.textImg.style.marginTop = '10px';
    }
    const titleBlock = (this.dragonImg ? dragonH + 10 : 0) + (this.textImg ? textH : 0);
    const shift = top + titleBlock + 24;
    const scale = Math.min(1, Math.max(0.5, (vh - shift - 16) / FORM_HEIGHT));
    document.body.style.setProperty('--alduinak-menu-shift', shift + 'px');
    document.body.style.setProperty('--alduinak-menu-scale', scale.toFixed(3));
  }

  mount() {
    this.root = document.createElement('div');

    if (!document.getElementById('alduinak-menu-css')) {
      const style = document.createElement('style');
      style.id = 'alduinak-menu-css';
      style.textContent = MENU_CSS;
      document.head.appendChild(style);
    }

    this.video = document.createElement('video');
    this.video.src = VIDEO_SRC;
    this.video.loop = true;
    this.video.muted = true; // the mp3 is the soundtrack, the video ships without audio
    this.video.autoplay = true;
    // z-index -1: over the game (page background is transparent), under every
    // widget - chat (auto), login/character select (40), trade (50)
    this.video.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-1;pointer-events:none;';
    this.video.addEventListener('error', () => {
      if (this.video) this.video.remove();
      this.video = null;
    });
    this.root.appendChild(this.video);

    // Title art: dragon with the lettering under it, replacing the game title
    this.title = document.createElement('div');
    this.title.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:0;pointer-events:none;' +
      'display:flex;flex-direction:column;align-items:center;';
    this.dragonImg = document.createElement('img');
    this.dragonImg.src = TITLE_DRAGON_SRC;
    this.dragonImg.addEventListener('error', () => {
      if (this.dragonImg) this.dragonImg.remove();
      this.dragonImg = null;
      this.layout();
    });
    this.title.appendChild(this.dragonImg);
    this.textImg = document.createElement('img');
    this.textImg.src = TITLE_TEXT_SRC;
    this.textImg.addEventListener('error', () => {
      if (this.textImg) this.textImg.remove();
      this.textImg = null;
      this.layout();
    });
    this.title.appendChild(this.textImg);
    this.root.appendChild(this.title);

    this.music = document.createElement('audio');
    this.music.src = MUSIC_SRC;
    this.music.loop = true;
    this.music.volume = MUSIC_VOLUME;
    this.music.addEventListener('error', () => {
      this.music = null;
      if (this.button) this.button.style.display = 'none';
    });
    this.root.appendChild(this.music);

    this.button = document.createElement('div');
    // z-index 39: above the video, below the login layer (40); still clickable
    // because that layer is pointer-events:none outside its centered panel
    this.button.style.cssText =
      'position:fixed;right:24px;bottom:24px;z-index:39;pointer-events:auto;cursor:pointer;' +
      'padding:6px 14px;border:1px solid rgba(255,255,255,.35);border-radius:4px;' +
      'background:rgba(0,0,0,.55);color:#e8e0d2;font:14px/1.4 Georgia,serif;' +
      'letter-spacing:1px;user-select:none;';
    this.button.addEventListener('click', () => {
      this.musicMuted = !this.musicMuted;
      this.applyMute();
      this.sendToGame('cef::menuMedia:saveSettings', JSON.stringify({ musicMuted: this.musicMuted }));
    });
    this.root.appendChild(this.button);

    document.body.appendChild(this.root);
  }

  applyMute() {
    if (this.button) this.button.textContent = this.musicMuted ? '♪ Music: Off' : '♪ Music: On';
    if (!this.music) return;
    if (this.musicMuted) {
      this.music.pause();
    } else {
      this.music.play().catch(() => {});
    }
  }
}

window.__alduinakMenuMedia = window.__alduinakMenuMedia || new MainMenuMedia();

export default window.__alduinakMenuMedia;
