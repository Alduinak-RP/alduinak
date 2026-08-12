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
const MUSIC_VOLUME = 0.5;

class MainMenuMedia {
  constructor() {
    this.root = null;
    this.video = null;
    this.music = null;
    this.button = null;
    this.musicMuted = false;
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
  }

  // Full unmount so the video decoder does not keep running behind gameplay
  hide() {
    if (!this.root) return;
    try { this.video && this.video.pause(); } catch (e) {}
    try { this.music && this.music.pause(); } catch (e) {}
    this.root.remove();
    this.root = this.video = this.music = this.button = null;
  }

  mount() {
    this.root = document.createElement('div');

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
