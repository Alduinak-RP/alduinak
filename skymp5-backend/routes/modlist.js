const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const { modlistPath } = require('../sources/serverFiles')

// GET /api/modlist?server=<id>: read on every call, so editing data/modlist*.json needs no backend restart
router.get('/', (req, res) => {
  const file = modlistPath(config.serverOrMain(req.query.server).id)
  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    res.status(500).json({ error: `${path.basename(file)} is missing or invalid: ${err.message}` })
  }
})

module.exports = router
