'use strict'

const fs   = require('fs')
const path = require('path')
const { locLookup } = require('../../localization/loc')

const locFile = path.join(__dirname, '..', '..', 'localization', 'en_loc.json')

const readLocTable = () => JSON.parse(fs.readFileSync(locFile, 'utf8'))

const { manager: managerSection, dashboard: dashboardSection } = readLocTable()

// Line from the manager section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
const loc = (key, vars) => locLookup(managerSection, key, vars)

// Source of the gamemode.js prelude that defines loc() over the gamemode section, read fresh for each build; it carries 00_core.js's strict directive, which no longer comes first
const gamemodeLocPrelude = () =>
  `'use strict'
` +
  `const EN_LOC = ${JSON.stringify(readLocTable().gamemode)};\n` +
  `${locLookup.toString()}\n` +
  `function loc(key, vars) { return locLookup(EN_LOC, key, vars) }\n`

module.exports = { loc, managerSection, dashboardSection, gamemodeLocPrelude }
