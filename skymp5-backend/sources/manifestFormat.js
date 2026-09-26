'use strict'

/**
 * data/manifest.json, compact form written by scripts/compile-manifest.js:
 *   { version, build, game,
 *     mods: [{ name, source, modId, version, hash, size, files: [archiveEntry | fileEntry] }],
 *     gameFiles: [archiveEntry | fileEntry],  (files for the Skyrim folder itself)
 *     creations, modlist, plugins, settings, initweaks }
 *   archiveEntry: { archive, key, size, sha256, fileId? | url?, modId? }  (modId only when it differs from the mod's)
 *   fileEntry:    { file, name?, from: "<key>[/dir in archive]", to?: "root[/dir]", size, sha256 }
 *                 (to left out when its dir equals from's; name is the archive's filename when it differs from file)
 * expand() turns it into the flat shape installers work with:
 *   { version, build, archives: [{ id, name, hash, size, source }], mods: [{ name, modId, version, hash, size, files: [{ to, archive, from, sha256, size }] }],
 *     gameFiles: [...same file shape...], order, plugins, creations, modlist, pluginsText, settings, initweaks }
 */

const MANIFEST_NAME = 'manifest.json'

const joinPath = (dir, file) => (dir ? `${dir}/${file}` : file)

// "a1/Data/Meshes" -> ["a1", "Data/Meshes"]
function splitFrom(from) {
  const i = from.indexOf('/')
  return i < 0 ? [from, ''] : [from.slice(0, i), from.slice(i + 1)]
}

// "root/Meshes" -> "Meshes"
const destDir = to => (to === 'root' ? '' : to.replace(/^root\//, ''))

function expandFiles(entries, modId, archives) {
  const files = []
  for (const e of entries || []) {
    if (e.archive) {
      if (!archives.has(e.key)) {
        const source = e.url ? { type: 'url', url: e.url }
          : e.fileId ? { type: 'nexus', modId: e.modId || modId, fileId: e.fileId }
          : { type: 'manual', name: e.archive }
        archives.set(e.key, { id: e.key, name: e.archive, hash: e.sha256, size: e.size, source })
      }
      continue
    }
    const [key, fromDir] = splitFrom(e.from)
    const to = e.to === undefined ? fromDir : destDir(e.to)
    files.push({ to: joinPath(to, e.file), archive: key, from: joinPath(fromDir, e.name || e.file), sha256: e.sha256, size: e.size })
  }
  return files
}

// MO2 text files as their lines, comments and blanks dropped
const textLines = t => String(t || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))

function expand(m) {
  const archives = new Map()
  const mods = (m.mods || []).map(mod => ({
    name: mod.name, modId: mod.modId || 0, version: mod.version || '', hash: mod.hash, size: mod.size,
    files: expandFiles(mod.files, mod.modId, archives),
  }))
  const gameFiles = expandFiles(m.gameFiles, 0, archives)
  // modlist.txt lines are "+Mod" (enabled) or "-X_separator"; MO2 lists the top priority first
  const order = textLines(m.modlist).filter(l => l.startsWith('+') || (l.startsWith('-') && l.endsWith('_separator'))).map(l => l.slice(1).trim())
  return {
    version: m.version, build: m.build, game: m.game,
    archives: [...archives.values()], mods, gameFiles, order,
    plugins: textLines(m.plugins), creations: m.creations || null,
    modlist: m.modlist || '', pluginsText: m.plugins || '', settings: m.settings || '', initweaks: m.initweaks || '',
  }
}

module.exports = { MANIFEST_NAME, expand, textLines }
