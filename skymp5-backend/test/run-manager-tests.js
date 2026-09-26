'use strict'
// Runs the manager security tests against a throwaway copy of the backend and manager code, so no live data, .env or log folder is ever read or written
// Usage: node test/run-manager-tests.js [scratch folder]

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const backendDir = path.resolve(__dirname, '..')
const repoRoot   = path.resolve(backendDir, '..')
const parent     = process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir()
fs.mkdirSync(parent, { recursive: true })
const root = fs.mkdtempSync(path.join(parent, 'alduinak-manager-test-'))

const skip = src => !/[\\/](node_modules|client|skse|\.git)([\\/]|$)/.test(path.relative(repoRoot, src))
for (const rel of ['config.js', 'package.json', 'routes', 'sources', 'middleware', 'scripts', 'test', path.join('data', 'role-permissions.json')]) {
  fs.cpSync(path.join(backendDir, rel), path.join(root, 'skymp5-backend', rel), { recursive: true, filter: skip })
}
fs.cpSync(path.join(repoRoot, 'server-manager', 'src'), path.join(root, 'server-manager', 'src'), { recursive: true, filter: skip })

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(root, 'skymp5-backend', 'test', 'manager-security.test.js')], {
  cwd: path.join(root, 'skymp5-backend'),
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_PATH: [path.join(backendDir, 'node_modules'), path.join(repoRoot, 'server-manager', 'node_modules')].join(path.delimiter),
    ALDUINAK_MANAGER_TEST_ROOT: root,
    ALDUINAK_SERVER_SETTINGS: path.join(root, 'server', 'server-settings.json'),
    ALDUINAK_LOG_DIR: path.join(root, 'logs'),
  },
})

if (result.status === 0) fs.rmSync(root, { recursive: true, force: true })
else console.error(`kept the test copy for inspection: ${root}`)
process.exit(result.status === null ? 1 : result.status)
