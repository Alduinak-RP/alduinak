/**
 * Minimal INI reader/editor for the launcher's Settings tab.
 *
 * read(path)  → { Section: { key: value, ... }, ... }  (empty object if missing)
 * write(path, edits) applies edits { Section: { key: value } } in place,
 *   preserving every other line, comment and ordering. Missing keys are
 *   appended to their section; missing sections are appended to the file.
 *
 * Skyrim INIs use CRLF; we preserve whatever the file already uses (CRLF if
 * present, else LF) and default to CRLF for brand-new files.
 */
const fs = require('fs')
const path = require('path')

function read(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1]
      out[section] = out[section] || {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      out[section] = out[section] || {}
      out[section][k] = v
    }
  }
  return out
}

function write(filePath, edits) {
  let text = ''
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    text = ''
  }
  const eol = text.includes('\r\n') ? '\r\n' : (text.includes('\n') ? '\n' : '\r\n')
  const lines = text.length ? text.split(/\r?\n/) : []

  // Track which keys still need to be written, per section.
  const remaining = {}
  for (const s of Object.keys(edits)) remaining[s] = new Set(Object.keys(edits[s]))

  const flush = (sec, result) => {
    if (!edits[sec]) return
    for (const k of Array.from(remaining[sec] || [])) {
      result.push(`${k}=${edits[sec][k]}`)
      remaining[sec].delete(k)
    }
  }

  const result = []
  let curSection = ''
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const sec = /^\[(.+)\]$/.exec(trimmed)
    if (sec) {
      flush(curSection, result) // append any unwritten keys before leaving the section
      curSection = sec[1]
      result.push(raw)
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq > 0 && edits[curSection]) {
      const k = trimmed.slice(0, eq).trim()
      if (Object.prototype.hasOwnProperty.call(edits[curSection], k)) {
        result.push(`${k}=${edits[curSection][k]}`)
        if (remaining[curSection]) remaining[curSection].delete(k)
        continue
      }
    }
    result.push(raw)
  }
  flush(curSection, result)

  // Sections that didn't exist in the file at all.
  for (const sec of Object.keys(edits)) {
    if (remaining[sec] && remaining[sec].size) {
      if (result.length && result[result.length - 1].trim() !== '') result.push('')
      result.push(`[${sec}]`)
      for (const k of remaining[sec]) result.push(`${k}=${edits[sec][k]}`)
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, result.join(eol) + (result.length ? eol : ''))
}

module.exports = { read, write }
