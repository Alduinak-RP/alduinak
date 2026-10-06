'use strict'
// Factory for Express middleware: validates the dashboard session Bearer token and requires the given permission

const { sessionFromRequest } = require('../sources/dashboardAuth')
const { loc } = require('../sources/loc')
const { hasPermission }      = require('../sources/permissions')

/** @param {string} perm Permission string to require, e.g. 'lore.write' */
function requirePermission(perm) {
  return (req, res, next) => {
    const session = sessionFromRequest(req)

    if (!session) {
      return res.status(401).json({ error: loc('auth.notAuthenticated') })
    }
    if (!hasPermission(session.permissions || [], perm)) {
      return res.status(403).json({ error: loc('auth.insufficientPermissions') })
    }

    req.session = session
    next()
  }
}

module.exports = requirePermission
