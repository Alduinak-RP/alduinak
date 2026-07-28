// Proximity voice chat over LiveKit, driven entirely by the game side via
// window.__alduinakVoice (see skymp5-client voiceService.ts). Plain JS on
// purpose: the repo pins TypeScript 4.6 and livekit-client's types need 5.x.
//
// Contract with the game side:
//   connect(url, token, cfg)  join the room; cfg = { talk, min, max, def,
//       tiers: [{u, label}] } - talk range bounds in game units
//   disconnect()              leave the room
//   setPtt(bool)              push-to-talk: enable/disable the mic track
//   setTalkRange(units)       V + mousewheel: my audible range; published to
//       the room over the LiveKit data channel so listeners attenuate by the
//       SPEAKER's loudness (a whisperer is only audible at whisper range)
//   setPeers({ identityHex: distanceUnits })  refresh distances ~every 400ms;
//       peers absent from the map are treated as out of range
// Events back to the game (window.skyrimPlatform.sendMessage):
//   'voice::ready', 'voice::micDenied', 'voice::error' <text>,
//   'voice::speaking' <jsonArray of identities currently audible+speaking>

import { Room, RoomEvent, Track } from 'livekit-client';

const UNSUB_HYSTERESIS = 1.15;   // unsubscribe only past range*this (no flapping)
const UNITS_PER_METER = 70;
const METER_HIDE_MS = 1800;

function sendToGame(...args) {
  try { window.skyrimPlatform.sendMessage(...args); } catch (e) { /* outside game */ }
}

class VoiceManager {
  constructor() {
    this.room = null;
    this.connecting = false;
    this.lastToken = null;
    this.minRange = 150;
    this.maxRange = 10000;
    this.defRange = 2000;
    this.myRange = 2000;
    this.tiers = [];
    this.distances = {};       // identity -> game units, refreshed by setPeers
    this.peerRanges = {};      // identity -> that speaker's chosen talk range
    this.ptt = false;
    this.audioEls = new Map(); // identity -> HTMLAudioElement
    this.meterEl = null;
    this.meterHideTimer = null;
    this.lastPeersAt = 0;
  }

  applyCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.min > 0) this.minRange = cfg.min;
    if (cfg.max > 0) this.maxRange = cfg.max;
    if (cfg.def > 0) this.defRange = cfg.def;
    if (Array.isArray(cfg.tiers)) this.tiers = cfg.tiers;
    if (cfg.talk > 0) this.myRange = this.clampRange(cfg.talk);
  }

  clampRange(units) {
    return Math.min(this.maxRange, Math.max(this.minRange, Math.round(units)));
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
            this.peerRanges[participant.identity] = this.clampRange(msg.r);
            this.applyVolume(participant.identity);
          }
        } catch (e) { /* not ours */ }
      });
      room.on(RoomEvent.Disconnected, () => {
        this.audioEls.forEach((el) => el.remove());
        this.audioEls.clear();
        this.peerRanges = {};
        // Intentional teardowns null this.room first; only report real drops,
        // otherwise the game re-requests a token and churns forever
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
      // Expose the room only once connected so setPtt cannot hit a
      // not-yet-connected room (that threw and mis-reported micDenied)
      this.room = room;
      this.publishRange();
      if (this.ptt) {
        try { await room.localParticipant.setMicrophoneEnabled(true); } catch (e) { /* applied on next press */ }
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
    if (this.ptt) this.showMeter(); else this.scheduleMeterHide();
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(this.ptt);
    } catch (e) {
      if (this.ptt) sendToGame('voice::micDenied', String(e && e.message || e));
    }
  }

  setTalkRange(units) {
    this.myRange = this.clampRange(units);
    this.publishRange();
    this.showMeter();
    this.scheduleMeterHide();
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

  // ── Talk-range meter (bottom center, shown while PTT held or adjusting) ────

  tierLabel(units) {
    let label = '';
    for (const t of this.tiers) {
      if (t && t.u > 0 && units >= t.u * 0.999) label = t.label;
    }
    return label || `${Math.round(units)}u`;
  }

  ensureMeter() {
    if (this.meterEl) return this.meterEl;
    const wrap = document.createElement('div');
    wrap.id = 'alduinak-voice-meter';
    wrap.style.cssText =
      'position:fixed;bottom:5vh;left:50%;transform:translateX(-50%);z-index:99999;' +
      'pointer-events:none;opacity:0;transition:opacity .25s;text-align:center;' +
      'font-family:inherit;user-select:none;';
    const label = document.createElement('div');
    label.style.cssText =
      'color:#fff;font-size:14px;text-shadow:0 1px 3px #000;margin-bottom:4px;letter-spacing:.5px;';
    const bar = document.createElement('div');
    bar.style.cssText =
      'width:240px;height:8px;border-radius:4px;background:rgba(0,0,0,.55);' +
      'border:1px solid rgba(255,255,255,.35);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText =
      'height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,#7fb4e6,#e6c97f);transition:width .1s;';
    bar.appendChild(fill);
    wrap.appendChild(label);
    wrap.appendChild(bar);
    document.body.appendChild(wrap);
    this.meterEl = wrap;
    this.meterLabelEl = label;
    this.meterFillEl = fill;
    return wrap;
  }

  showMeter() {
    const el = this.ensureMeter();
    // Log scale so whisper..shout spreads evenly across the bar
    const frac = Math.log(this.myRange / this.minRange) / Math.log(this.maxRange / this.minRange);
    this.meterFillEl.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    const meters = Math.round(this.myRange / UNITS_PER_METER);
    this.meterLabelEl.textContent = `Voice: ${this.tierLabel(this.myRange)} (${meters}m)`;
    el.style.opacity = '1';
    if (this.meterHideTimer) { clearTimeout(this.meterHideTimer); this.meterHideTimer = null; }
    if (!this.ptt) this.scheduleMeterHide();
  }

  scheduleMeterHide() {
    if (this.meterHideTimer) clearTimeout(this.meterHideTimer);
    this.meterHideTimer = setTimeout(() => {
      if (this.meterEl && !this.ptt) this.meterEl.style.opacity = '0';
    }, METER_HIDE_MS);
  }
}

window.__alduinakVoice = new VoiceManager();

// Failsafe: if the game stops feeding distances (main menu, script reload),
// go silent instead of playing the last-known volumes forever. Also heartbeat
// the talk range so listeners who missed the data packet eventually heal.
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
