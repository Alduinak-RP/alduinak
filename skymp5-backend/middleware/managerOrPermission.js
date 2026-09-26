'use strict'
// Dashboard Bearer session with a permission, or the Server Manager's master API token sent straight to this process over loopback

const config            = require('../config')
const requirePermission = require('./requirePermission')
const { safeEqual }     = require('../sources/safeEqual')

const MANAGER_ACTOR = 'server-manager'
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
// nginx sets these on every proxied request, so a request carrying one came through a proxy even when its socket is local
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host']
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function isDirectLoopback(req) {
  const socket = req.socket || req.connection || {}
  return LOOPBACK_ADDRESSES.has(socket.remoteAddress)
    && !PROXY_HEADERS.some(name => req.headers[name] !== undefined)
    && LOOPBACK_HOST_RE.test(String(req.headers.host || ''))
}

/** @param {string} perm Permission a dashboard session needs; the manager token stands for admin */
function managerOrPermission(perm) {
  const bearer = requirePermission(perm)
  return (req, res, next) => {
    if (req.headers['x-auth-token'] === undefined) {
      return bearer(req, res, () => {
        req.actor = `dashboard:${req.session.discordId}`
        next()
      })
    }
    if (!isDirectLoopback(req) || !safeEqual(req.headers['x-auth-token'], config.masterApiAuthToken)) {
      return res.status(403).json({ error: 'the manager token is accepted only from this machine' })
    }
    req.actor = MANAGER_ACTOR
    next()
  }
}

module.exports = managerOrPermission
module.exports.isDirectLoopback = isDirectLoopback
module.exports.MANAGER_ACTOR = MANAGER_ACTOR
