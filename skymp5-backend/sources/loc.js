'use strict'

const table = require('../../localization/en_loc.json')
const { locLookup } = require('../../localization/loc')

// Line from the backend section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
const loc = (key, vars) => locLookup(table.backend, key, vars)

module.exports = { loc, table }
