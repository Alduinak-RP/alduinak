// Proximity voice chat over LiveKit, driven entirely by the game side via
// window.__alduinakVoice (see skymp5-client voiceService.ts). Plain JS on
// purpose: the repo pins TypeScript 4.6 and livekit-client's types need 5.x.
//
// Contract with the game side:
//   connect(url, token, rangeUnits)  join the room (idempotent per token)
//   disconnect()                     leave the room
//   setPtt(bool)                     push-to-talk: enable/disable the mic track
//   setPeers({ identityHex: distanceUnits })  refresh distances ~every 400ms;
//       peers absent from the map are treated as out of range
// Events back to the game (window.skyrimPlatform.sendMessage):
//   'voice::ready', 'voice::micDenied', 'voice::error' <text>,
//   'voice::speaking' <jsonArray of identities currently audible+speaking>

import { Room, RoomEvent, Track } from 'livekit-client';

const FULL_VOLUME_UNITS = 350;   // within ~5m you hear full volume
const UNSUB_HYSTERESIS = 1.15;   // unsubscribe only past range*this (no flapping)

function sendToGame(...args) {
  try { window.skyrimPlatform.sendMessage(...args); } catch (e) { /* outside game */ }
}

class VoiceManager {
  constructor() {
    this.room = null;
    this.connecting = false;
    this.lastToken = null;
    this.rangeUnits = 2000;
    this.distances = {};       // identity -> game units, refreshed by setPeers
    this.ptt = false;
    this.audioEls = new Map(); // identity -> HTMLAudioElement
  }

  async connect(url, token, rangeUnits) {
    if (rangeUnits > 0) this.rangeUnits = rangeUnits;
    if (this.connecting || (this.room && this.lastToken === token)) return;
    this.lastToken = token;
    await this.disconnect();
    this.connecting = true;
    try {
      const room = new Room({ adaptiveStream: false, dynacast: false });
      this.room = room;

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
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
      });
      room.on(RoomEvent.Disconnected, () => {
        this.audioEls.forEach((el) => el.remove());
        this.audioEls.clear();
        if (this.room === room) { this.room = null; this.lastToken = null; }
        sendToGame('voice::error', 'disconnected');
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const audible = speakers
          .map((p) => p.identity)
          .filter((id) => this.gainFor(id) > 0);
        sendToGame('voice::speaking', JSON.stringify(audible));
      });

      await room.connect(url, token, { autoSubscribe: true });
      try { await room.startAudio(); } catch (e) { /* autoplay policy: unlocked by CEF switch */ }
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
  }

  async setPtt(down) {
    this.ptt = !!down;
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(this.ptt);
    } catch (e) {
      if (this.ptt) sendToGame('voice::micDenied', String(e && e.message || e));
    }
  }

  gainFor(identity) {
    const d = this.distances[identity];
    if (d === undefined || d > this.rangeUnits) return 0;
    if (d <= FULL_VOLUME_UNITS) return 1;
    return Math.max(0, 1 - (d - FULL_VOLUME_UNITS) / (this.rangeUnits - FULL_VOLUME_UNITS));
  }

  applyVolume(identity) {
    const el = this.audioEls.get(identity);
    if (el) el.volume = this.gainFor(identity);
  }

  setPeers(distances) {
    this.distances = distances || {};
    if (!this.room) return;
    this.audioEls.forEach((el, identity) => this.applyVolume(identity));
    // Bandwidth: don't even receive audio from players far out of range
    this.room.remoteParticipants.forEach((participant) => {
      const d = this.distances[participant.identity];
      const wanted = d !== undefined && d <= this.rangeUnits * UNSUB_HYSTERESIS;
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.isSubscribed !== wanted && typeof pub.setSubscribed === 'function') {
          try { pub.setSubscribed(wanted); } catch (e) { /* transient */ }
        }
      });
    });
  }
}

window.__alduinakVoice = new VoiceManager();

export default window.__alduinakVoice;
