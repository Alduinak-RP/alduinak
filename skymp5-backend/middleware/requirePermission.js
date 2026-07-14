'use strict'
// Factory for Express middleware: validates the dashboard session Bearer token and requires the given permission

const sessions         = require('../sources/dashboardSessions')
const { hasPermission } = require('../sources/permissions')

/** @param {string} perm Permission string to require, e.g. 'lore.write' */
function requirePermission(perm) {
  return (req, res, next) => {
    const auth    = req.headers['authorization'] ?? ''
    const token   = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const session = sessions.validate(token)

    if (!session) {
      return res.status(401).json({ error: 'not authenticated' })
    }
    if (!hasPermission(session.permissions || [], perm)) {
      return res.status(403).json({ error: 'insufficient permissions' })
    }

    req.session = session
    next()
  }
}

module.exports = requirePermission
