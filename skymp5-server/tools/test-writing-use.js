'use strict'

// Reading a writing from the pack (writingSystem.ts onUse, onOpen): a blank always writes a new one and the entry read opens: node tools/test-writing-use.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const systemSource = path.join(__dirname, '..', 'ts', 'systems', 'writingSystem.ts')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: {} }) }', loader: 'js' }))
  },
}

async function load (source) {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', plugins: [settingsStub] })
  const compiled = new Module(source)
  compiled.filename = source
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

const BASES = { letterBlank: 0x330020ca, letter: 0x330020cb, sealed: 0x330020cc, journalBlank: 0x330020cd, journal: 0x330020ce, bookBlank: 0x330020cf, book: 0x330020d0, wax: 0x330020d1 }
const ACTOR = 0xff000019
const USER = 7

const doc = (id, kind, title) => ({
  v: 1, id, kind, title, pages: ['text of ' + id], signed: false, finished: false,
  author: { actorId: 0xff000001, profileId: 1, realName: 'Mivon', shownName: 'Mivon', title: '', factionId: '' },
  scribe: { actorId: 0xff000001, profileId: 1, realName: 'Mivon', shownName: 'Mivon', title: '', factionId: '' },
  copyOf: '', createdAt: 1, updatedAt: 1, seal: kind === 'sealed' ? {} : null, brokenSeals: [], destroyedAt: 0, destroyedBy: '',
})

;(async () => {
  const { WritingSystem } = await load(systemSource)
  const lines = []
  const sys = new WritingSystem((l) => lines.push(l), {})
  sys.enabled = true
  sys.ready = true
  for (const [key, id] of Object.entries(BASES)) {
    sys.bases.set(key, id)
    sys.keyOf.set(id, key)
  }
  const docs = {
    WX2SAU: doc('WX2SAU', 'letter', 'Mysterious Letter'),
    WW00WN: doc('WW00WN', 'letter', 'Mysterious Note'),
    W5TRP8: Object.assign(doc('W5TRP8', 'letter', 'Sealed one'), { seal: { actorId: 0, profileId: -1, realName: '', shownName: '', title: '', factionId: '', at: 1 } }),
  }
  sys.store = { load: (id) => docs[id] || null, exists: (id) => !!docs[id], save: () => {} }

  let inventory = { entries: [] }
  let sent = []
  const mp = {
    getUserActor: () => ACTOR,
    get: (id, prop) => (prop === 'inventory' ? inventory : undefined),
    set: (id, prop, value) => { if (prop === 'inventory') inventory = value },
    sendCustomPacket: (u, text) => sent.push(JSON.parse(text)),
  }
  const ctx = { svr: mp }
  let clock = 0
  const realNow = Date.now
  Date.now = () => realNow() + (clock += 5000)

  const named = (base, name) => ({ baseId: base, count: 1, name })
  const plain = (base, count = 1) => ({ baseId: base, count })
  const use = (base, name) => {
    sent = []
    sys.customPacket(USER, 'writingUse', name === undefined ? { baseId: base } : { baseId: base, name }, ctx)
    return sent.find((p) => p.customPacketType === 'writingMenu' || p.customPacketType === 'notification') || null
  }
  const open = (id) => {
    sent = []
    sys.customPacket(USER, 'writingOpen', { id }, ctx)
    return sent.find((p) => p.customPacketType === 'writingMenu' || p.customPacketType === 'notification') || null
  }

  // The owner's report: two letters given by others and an unnamed Letter from the Item Spawner, all of one base
  inventory = { entries: [named(BASES.letter, 'Mysterious Letter (WX2SAU)'), named(BASES.letter, 'Mysterious Note (WW00WN)'), plain(BASES.letter)] }

  // Old client, no name: a list led by the new row instead of one of the letters
  let reply = use(BASES.letter)
  assert.equal(reply.view, 'list')
  assert.deepEqual(reply.list.map((r) => r.id), ['new', 'WX2SAU', 'WW00WN'])
  assert.equal(reply.list[0].title, 'Write a new letter')
  assert.match(lines.pop(), /^\[writing\] ff000019 reads 330020cb "": a list of 2 and a new one, carrying 1 blank and 2 written of that base$/)

  // The new row opens the composer on that blank, and a create writes on it
  reply = open('new')
  assert.equal(reply.view, 'compose')
  assert.equal(reply.compose.kind, 'letter')
  assert.equal(sys.sessions.get(USER).blank, BASES.letter)

  // A list row still opens its letter
  use(BASES.letter)
  reply = open('WW00WN')
  assert.equal(reply.view, 'read')
  assert.equal(reply.doc.id, 'WW00WN')

  // The new row with no blank left says so
  use(BASES.letter)
  const kept = inventory
  inventory = { entries: kept.entries.filter((e) => e.name) }
  reply = open('new')
  assert.equal(reply.text, 'You have no Blank Parchment left.')
  inventory = kept

  // The new row only answers a list that offered it
  sys.sessions.delete(USER)
  sent = []
  sys.customPacket(USER, 'writingOpen', { id: 'new' }, ctx)
  assert.equal(sent.length, 0)

  // New client: the entry read decides
  reply = use(BASES.letter, 'Letter')
  assert.equal(reply.view, 'compose')
  assert.match(lines.pop(), /reads 330020cb "Letter": the composer, carrying 1 blank and 2 written/)
  reply = use(BASES.letter, 'Mysterious Note (WW00WN)')
  assert.equal(reply.view, 'read')
  assert.equal(reply.doc.id, 'WW00WN')
  assert.match(lines.pop(), /reads 330020cb "Mysterious Note \(WW00WN\)": WW00WN, carrying 1 blank and 2 written/)
  reply = use(BASES.letter, 'Mysterious Letter (WX2SAU)')
  assert.equal(reply.doc.id, 'WX2SAU')

  // A tag the pack no longer holds never writes a new one
  reply = use(BASES.letter, 'Gone (WZZZZZ)')
  assert.equal(reply.view, 'list')

  // One given letter and the unnamed blank: before, the letter opened every time
  inventory = { entries: [named(BASES.letter, 'Mysterious Letter (WX2SAU)'), plain(BASES.letter)] }
  reply = use(BASES.letter)
  assert.deepEqual(reply.list.map((r) => r.id), ['new', 'WX2SAU'])
  assert.equal(use(BASES.letter, 'Letter').view, 'compose')

  // Without a blank of that base a lone letter opens as before, and a list has no new row
  inventory = { entries: [named(BASES.letter, 'Mysterious Letter (WX2SAU)'), plain(BASES.letterBlank, 3)] }
  assert.equal(use(BASES.letter).doc.id, 'WX2SAU')
  assert.equal(use(BASES.letter, 'Letter').doc.id, 'WX2SAU')
  inventory.entries.push(named(BASES.letter, 'Mysterious Note (WW00WN)'))
  reply = use(BASES.letter)
  assert.deepEqual(reply.list.map((r) => r.id), ['WX2SAU', 'WW00WN'])

  // A Blank Parchment always writes a new one, letters in the pack or not
  assert.equal(use(BASES.letterBlank).view, 'compose')
  assert.equal(use(BASES.letterBlank, 'Blank Parchment').view, 'compose')
  assert.equal(sys.sessions.get(USER).blank, BASES.letterBlank)

  // A sealed letter read by name shows its sealed face
  inventory.entries.push(named(BASES.sealed, 'Sealed Letter (W5TRP8)'))
  reply = use(BASES.sealed, 'Sealed Letter (W5TRP8)')
  assert.equal(reply.view, 'sealed')
  assert.equal(reply.doc.id, 'W5TRP8')

  // Nothing of that base: no reply, one line
  inventory = { entries: [] }
  assert.equal(use(BASES.journal), null)
  assert.match(lines.pop(), /reads 330020ce "": nothing, carrying 0 blank and 0 written/)

  Date.now = realNow
  console.log('test-writing-use: all checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
