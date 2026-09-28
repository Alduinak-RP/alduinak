'use strict'

// Per-server backend data files: the main server keeps the plain names, any other server id gets a -<id> suffix
const path = require('path')
const config = require('../config')
const { MANIFEST_NAME } = require('./manifestFormat')

const DATA_DIR = path.join(__dirname, '..', 'data')

const suffix = id => (id && id !== config.servers[0].id ? `-${id}` : '')

const manifestPath  = id => path.join(DATA_DIR, MANIFEST_NAME.replace(/\.json$/, `${suffix(id)}.json`))
const modlistPath   = id => path.join(DATA_DIR, `modlist${suffix(id)}.json`)
// Folder under config.clientFilesDir and the /files/<name> URL segment of the extras archive
const extrasDirName = id => `extras${suffix(id)}`

module.exports = { DATA_DIR, manifestPath, modlistPath, extrasDirName }
