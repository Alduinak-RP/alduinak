'use strict'

// Who reads which name on a writing and what a finished book still takes (writingSystem.ts readerLines, canEdit, onSave, onFinish): node tools/test-writing-rules.js

const assert  = require('node:assert/strict')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const systemSource = path.join(__dirname, '..', 'ts', 'systems', 'writingSystem.ts')
const storeSource = path.join(__dirname, '..', 'ts', 'systems', 'writingStore.ts')

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
  v: 1, id, kind, title: 'Title of ' + id, pages: ['text of ' + id], signed: true, finished: false, fixedPages: 0,
  author: person(AUTHOR, 'Mivon'), scribe: person(AUTHOR, 'Mivon'),
  copyOf: '', createdAt: 1, updatedAt: 1, seal: null, brokenSeals: [], destroyedAt: 0, destroyedBy: '',
}, over)

;(async () => {
  const { WritingSystem } = await load(systemSource)
  const { normaliseDoc } = await load(storeSource)
  const sys = new WritingSystem(() => {}, { titleOfActor: () => '', titleFactionOf: () => '', membershipsOfActor: () => [] })
  sys.enabled = true
  sys.ready = true
  // writing.log is the shared live log, so its lines stay in memory here
  const logged = []
  sys.appendLog = (text) => logged.push(text)
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
    WLEDGR: doc('WLEDGR', 'book', { pages: ['one', 'two'] }),
  }
  sys.store = { load: (id) => docs[id] || null, exists: (id) => !!docs[id], save: (d) => { docs[d.id] = d } }

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

  // An unfinished book is its author's to change, title and every page
  actor = AUTHOR
  const send = (type, content) => {
    sent = []
    sys.customPacket(USER, type, content, ctx)
    const menu = sent.find((p) => p.customPacketType === 'writingMenu')
    return menu ? menu.doc : sent.find((p) => p.customPacketType === 'notification') || null
  }
  const ledger = () => docs.WLEDGR
  let view = read('book', 'WLEDGR')
  assert.deepEqual([view.canEdit, view.canFinish, view.fixedPages], [true, true, 0])
  view = send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended'] })
  assert.deepEqual([ledger().title, ledger().pages], ['Ledger', ['one', 'two, amended']])
  assert.equal(inventory.entries[0].name, 'Ledger (WLEDGR)')

  // Finishing fixes the pages written so far and leaves the book open for more
  view = send('writingFinish', { id: 'WLEDGR' })
  assert.deepEqual([ledger().finished, ledger().fixedPages], [true, 2])
  assert.match(logged.pop(), /finished book WLEDGR "Ledger" up to page 2$/)
  assert.deepEqual([view.canEdit, view.canFinish, view.canCopy, view.fixedPages], [true, false, true, 2])

  // A save keeps the finished pages and the title whatever it sends for them, and takes the pages after them
  view = send('writingSave', { id: 'WLEDGR', title: 'Forged', pages: ['forged', 'forged too', 'three'] })
  assert.deepEqual([ledger().title, ledger().pages], ['Ledger', ['one', 'two, amended', 'three']])
  assert.deepEqual([view.canEdit, view.canFinish, view.fixedPages], [true, true, 2])
  send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended', 'three, reworded', 'four'] })
  assert.deepEqual(ledger().pages, ['one', 'two, amended', 'three, reworded', 'four'])
  send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['gone'] })
  assert.deepEqual(ledger().pages, ['one', 'two, amended'])

  // The pages after them are fixed by finishing again
  send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended', 'three'] })
  view = send('writingFinish', { id: 'WLEDGR' })
  assert.deepEqual([ledger().fixedPages, view.canFinish, view.canEdit], [3, false, true])
  send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended', 'changed'] })
  assert.deepEqual(ledger().pages, ['one', 'two, amended', 'three'])

  // A full book takes nothing more
  sys.cfg.writingBookMaxPages = 3
  view = read('book', 'WLEDGR')
  assert.deepEqual([view.canEdit, view.canFinish], [false, false])
  assert.equal(send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended', 'three'] }).text, 'You cannot change this writing.')
  sys.cfg.writingBookMaxPages = 100

  // A copy is fixed whole and nobody's to continue
  inventory.entries.push({ baseId: BASES.bookBlank, count: 1 })
  send('writingCopy', { id: 'WLEDGR' })
  const copyId = Object.keys(docs).find((id) => docs[id].copyOf === 'WLEDGR')
  assert.deepEqual([docs[copyId].finished, docs[copyId].fixedPages, docs[copyId].pages], [true, 3, ['one', 'two, amended', 'three']])
  view = read('book', copyId)
  assert.deepEqual([view.canEdit, view.canFinish], [false, false])

  // Another reader continues nothing
  actor = READER
  view = read('book', 'WLEDGR')
  assert.deepEqual([view.canEdit, view.canFinish, view.fixedPages], [false, false, 3])
  assert.equal(send('writingSave', { id: 'WLEDGR', title: 'Ledger', pages: ['one', 'two, amended', 'three', 'mine'] }).text, 'You cannot change this writing.')

  // Files: a book finished before pages could follow is fixed whole, a stored count never passes the pages, an unfinished book has none
  const stored = (over) => normaliseDoc(Object.assign({ id: 'WFILE1', kind: 'book', pages: ['a', 'b', 'c'] }, over), 'WFILE1').fixedPages
  assert.equal(stored({ finished: true }), 3)
  assert.equal(stored({ finished: true, fixedPages: 2 }), 2)
  assert.equal(stored({ finished: true, fixedPages: 9 }), 3)
  assert.equal(stored({ finished: false, fixedPages: 2 }), 0)

  Date.now = realNow
  console.log('test-writing-rules: all checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
