'use strict'

// nssm queries and the native module lock check, shared by the manager and the deploy/mongodb scripts

const fs   = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const config = require('./config')

const LOCK_CODES = ['EBUSY', 'EPERM', 'EACCES']

// Returns trimmed output; nssm prints UTF-16LE, which reads as utf8 with NUL bytes between characters
function nssm(verb, name, ...rest) {
  return new Promise(resolve => {
    execFile(config.nssm, [verb, name, ...rest], { windowsHide: true, timeout: verb === 'status' ? 5000 : 30000 }, (err, stdout, stderr) => {
      const clean = String(stdout || stderr || (err && err.message) || '').replace(/\u0000/g, '').trim()
      resolve(clean)
    })
  })
}

// nssm reports stopped for a server started by hand, but its process still holds the native module open
function nativeModuleLocked() {
  const file = path.join(config.paths.serverDir, 'scam_native.node')
  if (!fs.existsSync(file)) return null
  try { fs.closeSync(fs.openSync(file, 'r+')); return null }
  catch (err) { return LOCK_CODES.includes(err.code) ? 'a game server process still holds scam_native.node (started outside nssm?), stop it first' : null }
}

module.exports = { LOCK_CODES, nssm, nativeModuleLocked }
