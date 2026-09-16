'use strict'

// Console link to the gamemode over the backend WS relay, shared by the Electron manager and the agent

const WebSocket = require('ws')
const config = require('./config')

// onStatus(text) reports connection changes, onOutput(text) receives console output that no pending query consumed
function createConsoleRelay({ onStatus = () => {}, onOutput = () => {} } = {}) {
  return {
    ws: null, connected: false, timer: null, pending: new Map(),
    connect() {
      if (this.ws) return
      let ws
      try { ws = new WebSocket(`ws://127.0.0.1:${config.relay.port}`) }
      catch { return this.scheduleReconnect() }
      this.ws = ws
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', role: 'console', secret: config.relay.secret })))
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw.toString()) } catch { return }
        if (m.type === 'auth_ok') { this.connected = true; onStatus('connected to relay'); return }
        if (m.type === 'console_output' || m.type === 'console_log') {
          const text = String(m.text ?? '')
          // A marked reply line is consumed by its pending query, not shown in the
          // console. Position 0 only: a marker mid-text could be player-supplied.
          for (const [marker, p] of this.pending) {
            if (text.startsWith(marker)) { this.pending.delete(marker); clearTimeout(p.timer); p.resolve(text.slice(marker.length).trim()); return }
          }
          onOutput(text)
        }
      })
      ws.on('close', () => { this.connected = false; this.ws = null; this.scheduleReconnect() })
      ws.on('error', () => { /* 'close' handles the retry */ })
    },
    scheduleReconnect() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.connect() }, 4000) },
    command(text) {
      if (!this.connected || !this.ws) return { ok: false, error: 'relay not connected - is the backend running?' }
      try { this.ws.send(JSON.stringify({ type: 'console_command', text })); return { ok: true } }
      catch (err) { return { ok: false, error: err.message } }
    },
    // Send a command and resolve with the reply line following its marker.
    // Same-marker queries are serialized: pending is keyed on the marker, so two
    // in flight at once would clobber each other's resolver.
    query(command, marker, timeoutMs = 2500) {
      const queues = this.queues || (this.queues = new Map())
      const next = (queues.get(marker) || Promise.resolve()).then(() => this.queryNow(command, marker, timeoutMs))
      queues.set(marker, next)
      return next
    },
    queryNow(command, marker, timeoutMs) {
      return new Promise(resolve => {
        if (!this.connected || !this.ws) return resolve({ ok: false, error: 'relay not connected' })
        const timer = setTimeout(() => { this.pending.delete(marker); resolve({ ok: false, error: 'query timed out' }) }, timeoutMs)
        this.pending.set(marker, { resolve: payload => resolve({ ok: true, payload }), timer })
        try { this.ws.send(JSON.stringify({ type: 'console_command', text: command })) }
        catch (err) { this.pending.delete(marker); clearTimeout(timer); resolve({ ok: false, error: err.message }) }
      })
    },
  }
}

module.exports = { createConsoleRelay }
