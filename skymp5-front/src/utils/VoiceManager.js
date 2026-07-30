// Proximity voice chat over LiveKit, driven by the game side via window.__alduinakVoice (skymp5-client voiceService.ts).
// Plain JS on purpose: the repo pins TypeScript 4.6 and livekit-client's types need 5.x.
// Contract with the game side:
//   connect(url, token, cfg)  join the room; cfg = { modes: [{key,label,units}], mode }
//   disconnect()              leave the room
//   setPtt(bool)              push-to-talk: enable/disable the mic track
//   setMode(key)              Alt+V cycles whisper/talk/shout; the range goes out on the data channel so listeners attenuate by the SPEAKER's loudness
//   setPeers({ identityHex: distanceUnits })  refresh distances ~every 400ms; peers absent from the map are out of range
// Events back to the game (window.skyrimPlatform.sendMessage):
//   'voice::ready', 'voice::micDenied', 'voice::error' <text>, 'voice::speaking' <json array of audible speaking identities>

import { Room, RoomEvent, Track } from 'livekit-client';

import whisperImg from '../img/voice/Whisper.png';
import talkImg from '../img/voice/Talk.png';
import shoutImg from '../img/voice/Shout.png';

const UNSUB_HYSTERESIS = 1.15;   // unsubscribe only past range*this (no flapping)
const BANNER_MS = 1400;          // how long the mode banner stays up
const MODE_IMG = { whisper: whisperImg, talk: talkImg, shout: shoutImg };
// Fallbacks; the server sends the real list in connect()
const DEFAULT_MODES = [
  { key: 'whisper', label: 'Whisper', units: 140 },
  { key: 'talk', label: 'Talk', units: 840 },
  { key: 'shout', label: 'Shout', units: 3150 },
];

function sendToGame(...args) {
  try { window.skyrimPlatform.sendMessage(...args); } catch (e) { /* outside game */ }
}

class VoiceManager {
  constructor() {
    this.room = null;
    this.connecting = false;
    this.lastToken = null;
    this.modes = DEFAULT_MODES;
    this.mode = 'talk';
    this.distances = {};       // identity -> game units, refreshed by setPeers
    this.peerRanges = {};      // identity -> that speaker's mode range
    this.ptt = false;
    this.audioEls = new Map(); // identity -> HTMLAudioElement
    this.bannerEl = null;
    this.bannerTimer = null;
    this.lastPeersAt = 0;
  }

  applyCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Array.isArray(cfg.modes) && cfg.modes.length) this.modes = cfg.modes;
    if (cfg.mode && this.modeByKey(cfg.mode)) this.mode = cfg.mode;
  }

  modeByKey(key) {
    for (const m of this.modes) if (m.key === key) return m;
    return null;
  }

  get myRange() {
    const m = this.modeByKey(this.mode) || this.modes[0];
    return m ? m.units : 840;
  }

  // The default range for a speaker whose mode packet hasn't arrived yet
  get defRange() {
    const m = this.modeByKey('talk') || this.modes[Math.floor(this.modes.length / 2)];
    return m ? m.units : 840;
  }

  async connect(url, token, cfg) {
    this.applyCfg(cfg);
    if (this.connecting || (this.room && this.lastToken === token)) return;
    this.connecting = true; // set before any await so calls cannot interleave
    try {
      await this.disconnect();
      this.lastToken = token; // after disconnect(), which nulls it
      const room = new Room({ adaptiveStream: false, dynacast: false });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const stale = this.audioEls.get(participant.identity);
        if (stale) stale.remove(); // never leave an orphan playing unmanaged
        const el = track.attach();
        el.volume = 0; // silent until proximity says otherwise
        document.body.appendChild(el);
        this.audioEls.set(participant.identity, el);
        this.applyVolume(participant.identity);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach((el) => el.remove());
        this.audioEls.delete(participant.identity);
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        const el = this.audioEls.get(participant.identity);
        if (el) { el.remove(); this.audioEls.delete(participant.identity); }
        delete this.peerRanges[participant.identity];
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        this.publishRange(); // newcomers need to learn my current range
      });
      room.on(RoomEvent.DataReceived, (payload, participant) => {
        if (!participant) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg && msg.t === 'voiceRange' && msg.r > 0) {
            this.peerRanges[participant.identity] = Math.round(msg.r);
            this.applyVolume(participant.identity);
          }
        } catch (e) { /* not ours */ }
      });
      room.on(RoomEvent.Disconnected, () => {
        this.audioEls.forEach((el) => el.remove());
        this.audioEls.clear();
        this.peerRanges = {};
        // Intentional teardowns null this.room first; report only real drops or the game re-requests tokens forever
        if (this.room === room) {
          this.room = null;
          this.lastToken = null;
          sendToGame('voice::error', 'disconnected');
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const audible = speakers
          .map((p) => p.identity)
          .filter((id) => this.gainFor(id) > 0);
        sendToGame('voice::speaking', JSON.stringify(audible));
      });

      await room.connect(url, token, { autoSubscribe: true });
      try { await room.startAudio(); } catch (e) { /* autoplay policy: unlocked by CEF switch */ }
      // Expose the room only once connected so setPtt cannot hit a not-yet-connected room and mis-report micDenied
      this.room = room;
      this.publishRange();
      if (this.ptt) {
        try { await room.localParticipant.setMicrophoneEnabled(true); } catch (e) { /* applied on next press */ }
      } else {
        // Pre-warm: the first mic open runs Chromium's device stack in-process
        // and can hitch; do it at connect so the first PTT only unmutes
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch (e) { /* micDenied is reported on the first real PTT */ }
      }
      sendToGame('voice::ready');
    } catch (e) {
      this.room = null;
      this.lastToken = null;
      sendToGame('voice::error', String(e && e.message || e));
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    const room = this.room;
    this.room = null;
    this.lastToken = null;
    if (room) {
      try { await room.disconnect(); } catch (e) { /* already gone */ }
    }
    this.audioEls.forEach((el) => el.remove());
    this.audioEls.clear();
    this.peerRanges = {};
  }

  async setPtt(down) {
    this.ptt = !!down;
    // The banner doubles as the transmit indicator: solid while the mic is open, hidden on release
    if (this.ptt) this.showBanner(this.mode);
    else this.hideBanner();
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(this.ptt);
    } catch (e) {
      if (this.ptt) sendToGame('voice::micDenied', String(e && e.message || e));
    }
  }

  setMode(key) {
    if (!this.modeByKey(key)) return;
    this.mode = key;
    this.publishRange();
    this.showBanner(key);
  }

  publishRange() {
    if (!this.room) return;
    this.lastRangePublishAt = Date.now();
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ t: 'voiceRange', r: this.myRange }));
      const p = this.room.localParticipant.publishData(payload, { reliable: true });
      if (p && p.catch) p.catch(() => { /* transient; republished on the heartbeat */ });
    } catch (e) { /* transient; republished on next change/join */ }
  }

  rangeFor(identity) {
    const r = this.peerRanges[identity];
    return r > 0 ? r : this.defRange;
  }

  gainFor(identity) {
    const d = this.distances[identity];
    const r = this.rangeFor(identity);
    if (d === undefined || d > r) return 0;
    const full = r / 3; // full volume in the closest third, then linear falloff
    if (d <= full) return 1;
    return Math.max(0, 1 - (d - full) / (r - full));
  }

  applyVolume(identity) {
    const el = this.audioEls.get(identity);
    if (el) el.volume = this.gainFor(identity);
  }

  setPeers(distances) {
    this.distances = distances || {};
    this.lastPeersAt = Date.now();
    if (!this.room) return;
    this.audioEls.forEach((el, identity) => this.applyVolume(identity));
    // Bandwidth: don't even receive audio from players far out of range
    this.room.remoteParticipants.forEach((participant) => {
      const d = this.distances[participant.identity];
      const wanted = d !== undefined && d <= this.rangeFor(participant.identity) * UNSUB_HYSTERESIS;
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.isSubscribed !== wanted && typeof pub.setSubscribed === 'function') {
          try { pub.setSubscribed(wanted); } catch (e) { /* transient */ }
        }
      });
    });
  }

  // ── Mode banner (bottom left, flashed when Alt+V changes the mode) ─────────

  ensureBanner() {
    if (this.bannerEl) return this.bannerEl;
    const img = document.createElement('img');
    img.id = 'alduinak-voice-banner';
    img.style.cssText =
      'position:fixed;bottom:6vh;left:2vw;z-index:99999;width:9vw;min-width:110px;' +
      'max-width:170px;height:auto;pointer-events:none;opacity:0;' +
      'transition:opacity .18s;user-select:none;';
    document.body.appendChild(img);
    this.bannerEl = img;
    return img;
  }

  showBanner(key) {
    const src = MODE_IMG[key];
    if (!src) return;
    const el = this.ensureBanner();
    el.src = src;
    el.style.opacity = '1';
    if (this.bannerTimer) { clearTimeout(this.bannerTimer); this.bannerTimer = null; }
    // While transmitting the banner stays until setPtt(false) hides it
    if (!this.ptt) this.bannerTimer = setTimeout(() => { el.style.opacity = '0'; }, BANNER_MS);
  }

  hideBanner() {
    if (this.bannerTimer) { clearTimeout(this.bannerTimer); this.bannerTimer = null; }
    if (this.bannerEl) this.bannerEl.style.opacity = '0';
  }
}

window.__alduinakVoice = new VoiceManager();

// Failsafe: if the game stops feeding distances (main menu, script reload), go silent instead of playing stale volumes.
// Also heartbeat the range so listeners who missed the data packet eventually heal.
setInterval(() => {
  const vm = window.__alduinakVoice;
  if (!vm.room) return;
  if (vm.lastPeersAt && Date.now() - vm.lastPeersAt > 5000) {
    vm.distances = {};
    vm.audioEls.forEach((el) => { el.volume = 0; });
  }
  if (!vm.lastRangePublishAt || Date.now() - vm.lastRangePublishAt > 20000) {
    vm.publishRange();
  }
}, 2000);

export default window.__alduinakVoice;
