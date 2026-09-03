'use strict'
// SkyrimSE.exe version gate. Pure node (no electron) so it stays headless-testable.
const fs   = require('fs')
const path = require('path')

const GAME_VERSION_REQUIRED = '1.6.1170.0'
// GOG ships the same generation as 1.6.1179.0; the launcher supports GOG installs, so it is accepted there.
const GAME_VERSION_GOG      = '1.6.1179.0'
const GAME_DOWNGRADE_URL    = 'https://www.nexusmods.com/site/mods/2188?tab=description'

// FileVersion from VS_FIXEDFILEINFO in the RT_VERSION resource; null when the file is missing or not a PE with one.
function readPeFileVersion(exePath) {
  let fd
  try { fd = fs.openSync(exePath, 'r') } catch { return null }
  try {
    const size = fs.fstatSync(fd).size
    const readAt = (off, len) => {
      if (off < 0 || len < 0 || off + len > size) throw new Error('out of range')
      const b = Buffer.alloc(len)
      if (fs.readSync(fd, b, 0, len, off) !== len) throw new Error('short read')
      return b
    }
    const dos = readAt(0, 64)
    if (dos.readUInt16LE(0) !== 0x5a4d) return null
    const pe = dos.readUInt32LE(0x3c)
    const coff = readAt(pe, 24)
    if (coff.readUInt32LE(0) !== 0x00004550) return null
    const numSections = coff.readUInt16LE(6)
    const optSize     = coff.readUInt16LE(20)
    const opt = readAt(pe + 24, optSize)
    const magic = opt.readUInt16LE(0)
    const dirBase = magic === 0x20b ? 112 : (magic === 0x10b ? 96 : -1)
    if (dirBase < 0) return null
    const rsrcRva = opt.readUInt32LE(dirBase + 2 * 8)
    if (!rsrcRva) return null
    const sect = readAt(pe + 24 + optSize, numSections * 40)
    let rva2off = null
    for (let i = 0; i < numSections; i++) {
      const va = sect.readUInt32LE(i * 40 + 12), raw = sect.readUInt32LE(i * 40 + 16), ptr = sect.readUInt32LE(i * 40 + 20)
      const vs = Math.max(sect.readUInt32LE(i * 40 + 8), raw)
      if (rsrcRva >= va && rsrcRva < va + vs) { rva2off = rva => rva - va + ptr; break }
    }
    if (!rva2off) return null
    const rsrcOff = rva2off(rsrcRva)
    // Resource tree: type (16 = RT_VERSION) -> name -> language -> data entry
    const dirEntries = (rel) => {
      const hdr = readAt(rsrcOff + rel, 16)
      const n = hdr.readUInt16LE(12) + hdr.readUInt16LE(14)
      const ents = readAt(rsrcOff + rel + 16, n * 8)
      const out = []
      for (let i = 0; i < n; i++) out.push({ id: ents.readUInt32LE(i * 8), off: ents.readUInt32LE(i * 8 + 4) })
      return out
    }
    const typeEnt = dirEntries(0).find(e => e.id === 16 && (e.off & 0x80000000))
    if (!typeEnt) return null
    const nameEnt = dirEntries(typeEnt.off & 0x7fffffff).find(e => e.off & 0x80000000)
    if (!nameEnt) return null
    const langEnt = dirEntries(nameEnt.off & 0x7fffffff).find(e => !(e.off & 0x80000000))
    if (!langEnt) return null
    const dataEntry = readAt(rsrcOff + langEnt.off, 16)
    const blob = readAt(rva2off(dataEntry.readUInt32LE(0)), Math.min(dataEntry.readUInt32LE(4), 1 << 16))
    // VS_FIXEDFILEINFO: dwSignature 0xFEEF04BD, dwFileVersionMS at +8, dwFileVersionLS at +12
    const sig = blob.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]))
    if (sig < 0 || sig + 16 > blob.length) return null
    const ms = blob.readUInt32LE(sig + 8), ls = blob.readUInt32LE(sig + 12)
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
  } catch { return null } finally { fs.closeSync(fd) }
}

// { exe, version, ok, required }; edition comes from mo2.detectEdition. An unreadable version never blocks (ok stays true) so an odd build only logs.
function checkGameVersion(gameDir, edition) {
  const exe = path.join(gameDir || '', 'SkyrimSE.exe')
  const version = gameDir ? readPeFileVersion(exe) : null
  const gog = edition === 'GOG'
  const ok = version === null || version === GAME_VERSION_REQUIRED || (gog && version === GAME_VERSION_GOG)
  return { exe, version, ok, required: gog ? GAME_VERSION_GOG : GAME_VERSION_REQUIRED }
}

module.exports = { GAME_VERSION_REQUIRED, GAME_VERSION_GOG, GAME_DOWNGRADE_URL, readPeFileVersion, checkGameVersion }
