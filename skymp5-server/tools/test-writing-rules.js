'use strict'

// Who reads which name on a writing (writingSystem.ts readerLines): node tools/test-writing-rules.js

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
const AUTHOR = 0xff000001
const READER = 0xff000019
const USER = 7

const person = (actorId, name, title = '') => ({ actorId, profileId: 1, realName: name, shownName: name, title, factionId: '' })

const doc = (id, kind, over = {}) => Object.assign({
  v: 1, id, kind, title: 'Title of ' + id, pages: ['text of ' + id], signed: true, finished: false,
  author: person(AUTHOR, 'Mivon'), scribe: person(AUTHOR, 'Mivon'),
  copyOf: '', createdAt: 1, updatedAt: 1, seal: null, brokenSeals: [], destroyedAt: 0, destroyedBy: '',
}, over)

;(async () => {
  const { WritingSystem } = await load(systemSource)
  const sys = new WritingSystem(() => {}, {})
  sys.enabled = true
  sys.ready = true
  for (const [key, id] of Object.entries(BASES)) {
    sys.bases.set(key, id)
    sys.keyOf.set(id, key)
  }
  const docs = {
    WBOOK1: doc('WBOOK1', 'book'),
    WTITLE: doc('WTITLE', 'book', { author: person(AUTHOR, 'Sen Volun', 'Jarl') }),
    WPLAIN: doc('WPLAIN', 'book', { signed: false }),
    WNONAM: doc('WNONAM', 'letter', { author: person(AUTHOR, '') }),
    WSEAL1: doc('WSEAL1', 'letter', { seal: Object.assign(person(AUTHOR, 'Mivon'), { at: 1 }) }),
    WBROKE: doc('WBROKE', 'letter', { brokenSeals: [{ seal: Object.assign(person(AUTHOR, 'Mivon'), { at: 1 }), brokenAt: 2, brokenBy: person(READER, 'Ria') }] }),
  }
  sys.store = { load: (id) => docs[id] || null, exists: (id) => !!docs[id], save: () => {} }

  let actor = READER
  let known = []
  let inventory = { entries: [] }
  let sent = []
  const mp = {
    getUserActor: () => actor,
    get: (id, prop) => (prop === 'inventory' ? inventory : prop === 'ff_knownIds' ? known : undefined),
    set: (id, prop, value) => { if (prop === 'inventory') inventory = value },
    sendCustomPacket: (u, text) => sent.push(JSON.parse(text)),
  }
  const ctx = { svr: mp }
  let clock = 0
  const realNow = Date.now
  Date.now = () => realNow() + (clock += 5000)

  const named = (key, id, title) => ({ baseId: BASES[key], count: 1, name: `${title} (${id})` })
  const read = (key, id) => {
    inventory = { entries: [named(key, id, key === 'sealed' ? 'Sealed Letter' : docs[id].title)] }
    sent = []
    sys.customPacket(USER, 'writingOpen', { id }, ctx)
    return sent.find((p) => p.customPacketType === 'writingMenu').doc
  }

  // A stranger reads the signature, with the title the signer showed
  assert.equal(read('book', 'WBOOK1').byline, 'Signed, Mivon')
  assert.equal(read('book', 'WTITLE').byline, 'Signed, Jarl Sen Volun')
  assert.equal(read('book', 'WPLAIN').byline, '')
  assert.equal(read('letter', 'WNONAM').byline, 'Signed in an unfamiliar hand')

  // A door note reads the same
  assert.equal(sys.pinnedNoteView(mp, READER, 'WBROKE').byline, 'Signed, Mivon')

  // Seals still follow the introductions
  assert.equal(read('sealed', 'WSEAL1').sealText, 'Closed with an unfamiliar seal.')
  assert.deepEqual(read('letter', 'WBROKE').brokenSeals, ['An unfamiliar seal was broken.'])
  known = [AUTHOR]
  assert.equal(read('sealed', 'WSEAL1').sealText, 'Closed with the seal of Mivon.')
  assert.deepEqual(read('letter', 'WBROKE').brokenSeals, ['The seal of Mivon was broken.'])
  assert.equal(read('book', 'WBOOK1').byline, 'Signed, Mivon')

  Date.now = realNow
  console.log('test-writing-rules: all checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
