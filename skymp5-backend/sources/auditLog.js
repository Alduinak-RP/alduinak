'use strict'

// Timestamped audit lines in the moderation log folder (BAN_LOG_DIR); a failed write never breaks the action it records

const fs   = require('fs')
const path = require('path')

const LOG_DIR = process.env.BAN_LOG_DIR || 'C:\\Users\\Administrator\\Desktop\\logs'

function append(fileName, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, fileName), `${new Date().toISOString()} ${line}\n`)
  } catch (e) {
    console.error(`[audit] failed to write ${fileName}:`, e.message)
  }
}

module.exports = { append }
