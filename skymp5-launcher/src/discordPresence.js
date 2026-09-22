/**
 * Discord Rich Presence over the desktop app's local IPC pipe, no library.
 *
 * Frames are a little-endian uint32 opcode, a little-endian uint32 length and
 * a JSON payload. Opcode 0 HANDSHAKE { v: 1, client_id } answers with a
 * FRAME (1) DISPATCH READY; SET_ACTIVITY goes as a FRAME with a nonce; 2 is
 * CLOSE, 3 PING and 4 PONG. Discord listens on \\.\pipe\discord-ipc-0..9.
 * Every failure is logged once and retried while presence is wanted; nothing
 * here blocks or throws into the launcher.
 */
const net = require('net')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 }
const PIPES = 10
const RETRY_MS = 15_000

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\discord-ipc-${i}`
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir()
  return path.join(dir, `discord-ipc-${i}`)
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32LE(op, 0)
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

class DiscordPresence {
  constructor(log = () => {}) {
    this.log = log
    this.clientId = ''
    this.wanted = false
    this.socket = null
    this.ready = false
    this.activity = null
    this.buf = Buffer.alloc(0)
    this.retryTimer = null
    this.noPipeLogged = false
  }

  start(clientId) {
    this.clientId = String(clientId || '')
    this.wanted = true
    if (!this.socket && this.clientId) this.connect()
  }

  // Clears the activity and closes the pipe; a later start() reconnects
  stop() {
    this.wanted = false
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.activity = null
    if (!this.socket) return
    if (this.ready) {
      this.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() })
      this.send(OP.CLOSE, {})
    }
    const s = this.socket
    this.socket = null
    this.ready = false
    try { s.end() } catch { }
  }

  setActivity(activity) {
    this.activity = activity
    if (this.ready) this.pushActivity()
  }

  pushActivity() {
    const args = { pid: process.pid }
    if (this.activity) args.activity = this.activity
    this.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: crypto.randomUUID() })
  }

  send(op, payload) {
    if (!this.socket) return
    try { this.socket.write(encode(op, payload)) } catch (err) { this.log('discord: write failed:', err.message) }
  }

  connect(i = 0) {
    if (!this.wanted) return
    if (i >= PIPES) {
      if (!this.noPipeLogged) { this.log('discord: no ipc pipe (is Discord running?)'); this.noPipeLogged = true }
      return this.scheduleRetry()
    }
    const s = net.connect(pipePath(i))
    s.once('error', () => { s.destroy(); this.connect(i + 1) })
    s.once('connect', () => {
      s.removeAllListeners('error')
      this.socket = s
      this.buf = Buffer.alloc(0)
      this.noPipeLogged = false
      s.on('data', d => this.onData(d))
      s.on('error', err => this.log('discord: pipe error:', err.message))
      s.on('close', () => this.onClose(s))
      this.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId })
    })
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0)
      const len = this.buf.readUInt32LE(4)
      if (this.buf.length < 8 + len) break
      let payload = {}
      try { payload = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')) } catch { }
      this.buf = this.buf.subarray(8 + len)
      this.onFrame(op, payload)
    }
  }

  onFrame(op, payload) {
    if (op === OP.PING) return this.send(OP.PONG, payload)
    if (op === OP.CLOSE) {
      this.log('discord: closed by Discord:', JSON.stringify(payload))
      return
    }
    if (op !== OP.FRAME) return
    if (payload.evt === 'READY') {
      this.ready = true
      this.log('discord: presence ready')
      if (this.activity) this.pushActivity()
    } else if (payload.evt === 'ERROR') {
      this.log('discord: error:', JSON.stringify(payload.data || payload))
    }
  }

  onClose(s) {
    if (this.socket !== s) return
    this.socket = null
    this.ready = false
    if (this.wanted) this.scheduleRetry()
  }

  scheduleRetry() {
    if (!this.wanted || this.retryTimer) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect() }, RETRY_MS)
  }
}

module.exports = { DiscordPresence }
