'use strict'

// Read-only web view of server-settings.json and the backend .env: secret values never leave the box, only whether they are set

const schema = require('./settingsSchema')
const { sanitize } = require('./mongoPurge')

// Nested keys and unknown top-level keys that hold credentials (voiceChat apiKey/apiSecret, discordAuth botToken, metricsAuth password, additionalServerSettings[].token)
const SECRET_NAME_RE = /token|secret|passw|pwd|api_?key|private|credential|webhook|cookie|^auth|databaseuri|_uri$/i

// Never editable from the web even after settings writes arrive: code execution, file paths, auth, admin lists, load order and the database
const WEB_LOCKED = {
  serverSettings: new Set([
    'gamemodePath', 'dataDir', 'databaseDriver', 'databaseName', 'databaseUri', 'logDir', 'master', 'masterKey', 'masterApiAuthToken',
    'offlineMode', 'enableConsoleCommandsForAll', 'adminProfileIds', 'adminRoleIds', 'adminRoles', 'discordAuth', 'metricsAuth',
    'additionalServerSettings', 'loadOrder', 'archives', 'startPoints', 'listenHost', 'uiListenHost', 'port', 'locale', 'voiceChat',
  ]),
  backendEnv: new Set([
    'PORT', 'WS_PORT', 'RELAY_SECRET', 'SKYMP_HOST',
    'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'DISCORD_BOT_TOKEN', 'DASHBOARD_PORT', 'DASHBOARD_PUBLIC_URL', 'DASHBOARD_API_BASE_URL',
    'DISCORD_DASHBOARD_REDIRECT_URI', 'DASHBOARD_DISCORD_IDS', 'WEBSITE_URL',
    'LAUNCH_CHECK_ENFORCE', 'BAN_LOG_DIR',
    'CLIENT_FILES_DIR', 'ALDUINAK_GH_TOKEN',
  ]),
}

function isLocked(file, key) {
  return WEB_LOCKED[file].has(key) || /^MANAGER_/.test(key)
}

function isSet(value) {
  return value !== undefined && value !== null && value !== ''
}

// Deep copy with credential-named keys replaced by { secretSet } and connection strings stripped
function redactValue(value, depth = 0) {
  if (typeof value === 'string') return sanitize(value)
  if (!value || typeof value !== 'object') return value
  if (depth > 8) return '[nested]'
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_NAME_RE.test(k) ? { secretSet: isSet(v) } : redactValue(v, depth + 1)
  }
  return out
}

function maskEntry(file, key, value, field) {
  const secret = field ? field.type === 'secret' : SECRET_NAME_RE.test(key)
  const entry = { key, label: field ? field.label : key, group: field ? field.group : 'Other', type: field ? field.type : 'unknown', secret, locked: isLocked(file, key) }
  if (secret) entry.secretSet = isSet(value)
  else entry.value = redactValue(value)
  return entry
}

/** Masked fields for one settings file; values is the parsed object (server-settings.json) or the .env key map. */
function maskSettings(file, values) {
  const fields = schema[file]
  if (!fields) throw new Error(`unknown settings file ${file}`)
  const known = new Set(fields.map(f => f.key))
  const src = values || {}
  return {
    fields: fields.map(f => maskEntry(file, f.key, src[f.key], f)),
    extra: Object.keys(src).filter(k => !known.has(k)).sort().map(k => maskEntry(file, k, src[k], null)),
  }
}

// Every credential value worth scrubbing from log text: secret fields, credential-named nested keys and unknown secret-looking keys
function secretValues(settings, env) {
  const found = new Set()
  const walk = (value, secret) => {
    if (typeof value === 'string') { if (secret && value.length >= 8) found.add(value); return }
    if (!value || typeof value !== 'object') return
    for (const [k, v] of Object.entries(value)) walk(v, secret || SECRET_NAME_RE.test(k))
  }
  for (const [file, values] of [['serverSettings', settings], ['backendEnv', env]]) {
    const byKey = Object.fromEntries(schema[file].map(f => [f.key, f]))
    for (const [k, v] of Object.entries(values || {})) {
      const f = byKey[k]
      walk(v, (f && f.type === 'secret') || SECRET_NAME_RE.test(k))
    }
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/** Replaces known secret values and database connection strings in free text such as logs and console output. */
function redactText(text, secrets) {
  let s = String(text)
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join('[redacted]')
  return sanitize(s)
}

module.exports = { maskSettings, secretValues, redactText, WEB_LOCKED, SECRET_NAME_RE }
