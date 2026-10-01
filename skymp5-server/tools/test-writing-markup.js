'use strict'

// The writing markup: the front's parser and renderer (skymp5-front writing/markup.tsx) and the server's page limits (writingSystem.ts readPages): node tools/test-writing-markup.js

const assert  = require('node:assert/strict')
const fs      = require('fs')
const path    = require('path')
const Module  = require('module')
const esbuild = require('esbuild')

const repo = path.join(__dirname, '..', '..')
const front = path.join(repo, 'skymp5-front')
const markupSource = path.join(front, 'src', 'features', 'writing', 'markup.tsx')
const systemSource = path.join(__dirname, '..', 'ts', 'systems', 'writingSystem.ts')

const settingsStub = {
  name: 'settings-stub',
  setup (build) {
    build.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'exports.Settings = { get: async () => ({ allSettings: {} }) }', loader: 'js' }))
  },
}

// Capital art resolves to its file name; Q stands for a letter the owner's set lacks
const pngStub = {
  name: 'png-stub',
  setup (build) {
    build.onLoad({ filter: /\.png$/ }, (a) => ({
      contents: path.basename(a.path) === 'Q.png' ? 'throw new Error("Cannot find module")' : `module.exports = ${JSON.stringify('img/' + path.basename(a.path))}`,
      loader: 'js',
    }))
  },
}

async function load (source, options) {
  const { outputFiles } = await esbuild.build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', ...options })
  const compiled = new Module(source)
  compiled.filename = source
  compiled.paths = Module._nodeModulePaths(path.dirname(source))
  compiled._compile(outputFiles[0].text, source)
  return compiled.exports
}

;(async () => {
  // The server counts with the front's pattern
  const literal = (file, name) => new RegExp(`${name} = (/.+/gi);`).exec(fs.readFileSync(file, 'utf8'))[1]
  assert.equal(literal(systemSource, 'MARKUP_TAG'), literal(markupSource, 'export const TAG'))

  const md = await load(markupSource, { external: ['react', 'react-dom'], jsx: 'transform', plugins: [pngStub] })
  const React = require(require.resolve('react', { paths: [front] }))
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [front] }))
  const html = (text) => renderToStaticMarkup(React.createElement(md.Markup, { text }))

  // Plain text and markup characters stay text
  assert.equal(html('Dear Ysolda,\nthe goats <b>are</b> fine & well'), 'Dear Ysolda,\nthe goats &lt;b&gt;are&lt;/b&gt; fine &amp; well')
  assert.equal(html('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')

  // Tags, aliases and implicit closing at the end
  assert.equal(html('[b]bold[/b] [bold]too[/bold] [i]it[/i] [u]u[/u] [s]s[/s]'), '<strong>bold</strong> <strong>too</strong> <em>it</em> <u>u</u> <s>s</s>')
  assert.equal(html('[B]loud[/B]'), '<strong>loud</strong>')
  assert.equal(html('[b]open to the end'), '<strong>open to the end</strong>')
  assert.equal(html('[b][i]x[/b] y'), '<strong><em>x</em></strong> y')

  // Unknown, stray or malformed tags are shown as written
  assert.equal(html('[sic] [foo]x[/foo] [/b] [b=1]x'), '[sic] [foo]x[/foo] [/b] [b=1]x')
  assert.equal(html('[head=4]x[/head]'), '[head=4]x[/head]')
  assert.equal(html('[color=url(x)]a[/color]'), '[color=url(x)]a[/color]')
  assert.equal(html('[color="#fff" onmouseover=alert(1)]a'), '[color=&quot;#fff&quot; onmouseover=alert(1)]a')
  assert.equal(html('[font=comic]a[/font]'), '[font=comic]a[/font]')

  // Inks, hex colours, fonts by key or label, headings and blocks
  assert.equal(html('[color=red]r[/color][color=#12AbEf]h[/color][color=gray]g[/color]'),
    '<span style="color:#8b1a1a">r</span><span style="color:#12AbEf">h</span><span style="color:#55504a">g</span>')
  assert.equal(html('[font="Mage Script"]m[/font][font=daedric]d[/font]'),
    '<span style="font-family:&#x27;Writing Mage&#x27;, Georgia, serif;text-transform:uppercase">m</span><span style="font-family:&#x27;Writing Daedric&#x27;, Georgia, serif">d</span>')
  assert.equal(html('[font=unreadable]Ab [font=hand]c[/font] 9[/font]'),
    '<span style="font-family:&#x27;Writing Unreadable&#x27;, Georgia, serif">58 <span style="font-family:&#x27;Writing Hand&#x27;, Georgia, serif">c</span> 9</span>')
  assert.equal(html('[head=1]Title[/head]\nBody'), '<span class="writing-md__head writing-md__head--1">Title</span>Body')
  assert.equal(html('a\n[center]\nmid\n[/center]\nc'), 'a\n<span class="writing-md__block writing-md__block--center">mid\n</span>c')
  assert.equal(html('[right]r[/right]'), '<span class="writing-md__block writing-md__block--right">r</span>')
  assert.equal(html('[bullet] one\n[bullet/] two'), '<span class="writing-md__bullet">• </span> one\n<span class="writing-md__bullet">• </span> two')
  assert.equal(html('a\n[hr]\nb'), 'a\n<span class="writing-md__hr"></span>b')

  // Illuminated capitals, a closer after one, and the fallbacks
  assert.equal(html('[fancy]Once upon'), '<img class="writing-md__fancy" src="img/O.png" alt="O"/>nce upon')
  assert.equal(html('[fancy]once[/fancy] more'), '<img class="writing-md__fancy" src="img/O.png" alt="O"/>nce more')
  assert.equal(html('[fancy]Quiet'), '<span class="writing-md__fancy writing-md__fancy--text">Q</span>uiet')
  assert.equal(html('[fancy]1st'), '[fancy]1st')
  assert.equal(html('[/fancy] alone'), '[/fancy] alone')

  // Nesting stops at eight levels
  const deep = '[b]'.repeat(10) + 'x'
  const rendered = html(deep)
  assert.equal((rendered.match(/<strong>/g) || []).length, 8)
  assert.ok(rendered.includes('[b][b]x'))

  // At most 400 tags are honoured, the rest stay text
  const many = '[i]a[/i]'.repeat(201)
  assert.equal((html(many).match(/<em>/g) || []).length, 200)

  // The visible text, as the server counts it
  assert.equal(md.plainText('[fancy]Once [b]upon[/b] a [font=hand]time[/font] [sic]'), 'Once upon a time [sic]')

  // Server limits: visible characters against the configured length, the raw text against twice that
  const { WritingSystem } = await load(systemSource, { plugins: [settingsStub] })
  const sys = new WritingSystem(() => {}, {})
  const notices = []
  const mp = { sendCustomPacket: (u, text) => notices.push(JSON.parse(text).text) }
  const read = (pages) => sys.readPages(mp, 0, 'letter', pages)
  const max = 2000
  assert.deepEqual(read(['[b]' + 'a'.repeat(max) + '[/b]']), ['[b]' + 'a'.repeat(max) + '[/b]'])
  assert.equal(read(['a'.repeat(max + 1)]), null)
  assert.equal(notices.pop(), `A page holds ${max} characters at most.`)
  assert.equal(read(['[b]x[/b]'.repeat(500)]), null)
  assert.equal(notices.pop(), 'That page carries too much formatting.')
  assert.equal(read(['[color=red]' + 'a'.repeat(1990) + '[/color]'.repeat(250)]), null)
  assert.equal(notices.pop(), 'That page carries too much formatting.')
  assert.deepEqual(read(['[sic] ' + 'a'.repeat(max - 6)]), ['[sic] ' + 'a'.repeat(max - 6)])
  assert.equal(read(['[sic] ' + 'a'.repeat(max - 5)]), null)
  assert.deepEqual(sys.readPages(mp, 0, 'book', ['[head=1]One[/head]', '', 'Three', '']), ['[head=1]One[/head]', '', 'Three'])

  console.log('test-writing-markup: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
