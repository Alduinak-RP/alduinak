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

// Section and key names match without regard to case, like the Win32 profile API the engine reads inis with
const lower = k => (typeof k === 'string' ? k.toLowerCase() : k)
const nocase = () => new Proxy(Object.create(null), {
  get: (t, k) => t[lower(k)],
  has: (t, k) => lower(k) in t,
  set: (t, k, v) => { t[lower(k)] = v; return true },
})

function read(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  const out = nocase()
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1]
      out[section] = out[section] || nocase()
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      out[section] = out[section] || nocase()
      if (!(k in out[section])) out[section][k] = v // the first value wins, like the engine
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
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  // Edits and the keys still to write, by lowercase section and key name
  const want = Object.create(null), remaining = Object.create(null)
  for (const s of Object.keys(edits)) {
    want[lower(s)] = { name: s, kv: new Map(Object.keys(edits[s]).map(k => [lower(k), [k, edits[s][k]]])) }
    remaining[lower(s)] = new Set(want[lower(s)].kv.keys())
  }

  // Missing keys go after the section's last non-blank line
  const flush = (sec, result) => {
    if (!want[sec]) return
    let at = result.length
    while (at && !result[at - 1].trim()) at--
    result.splice(at, 0, ...Array.from(remaining[sec], k => want[sec].kv.get(k).join('=')))
    remaining[sec].clear()
  }

  const result = []
  let curSection = ''
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const sec = /^\[(.+)\]$/.exec(trimmed)
    if (sec) {
      flush(curSection, result) // append any unwritten keys before leaving the section
      curSection = lower(sec[1])
      result.push(raw)
      continue
    }
    const eq = trimmed.indexOf('=')
    const k = eq > 0 ? trimmed.slice(0, eq).trim() : ''
    const edit = k && want[curSection] && want[curSection].kv.get(lower(k))
    if (edit) {
      result.push(`${k}=${edit[1]}`)
      remaining[curSection].delete(lower(k))
      continue
    }
    result.push(raw)
  }
  flush(curSection, result)

  // Sections that didn't exist in the file at all.
  for (const sec of Object.keys(want)) {
    if (remaining[sec].size) {
      if (result.length && result[result.length - 1].trim() !== '') result.push('')
      result.push(`[${want[sec].name}]`)
      flush(sec, result)
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, result.join(eol) + (result.length ? eol : ''))
}

module.exports = { read, write }
