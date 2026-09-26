'use strict'
// CPU, memory and (for nginx) requests per minute of each service, sampled on demand by the Console tab.
// A service's process tree is summed: nssm runs the real program as its child, nginx has workers.

const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')
const config = require('./config')
const { serviceName } = require('./services')

const PS = `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.KernelModeTime + $_.UserModeTime) $($_.WorkingSetSize)" }
'--'
Get-CimInstance Win32_Service | Where-Object { $_.ProcessId } | ForEach-Object { "$($_.Name) $($_.ProcessId)" }`

let prev = null           // { at, cpu: Map(pid -> 100ns) }
const requests = { file: '', offset: 0, samples: [] }   // samples: [at, lines]

function powershell(script) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 },
      (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

function treeOf(root, children) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()
    out.push(pid)
    for (const c of children.get(pid) || []) stack.push(c)
  }
  return out
}

// New access.log lines in the last minute; the first sample only sets the offset
function nginxRequestsPerMinute(file) {
  let size
  try { size = fs.statSync(file).size } catch { return null }
  if (requests.file !== file || size < requests.offset) Object.assign(requests, { file, offset: size, samples: [] })
  let lines = 0
  if (size > requests.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(size - requests.offset, 16 << 20))
    fs.readSync(fd, buf, 0, buf.length, size - buf.length)
    fs.closeSync(fd)
    for (const b of buf) if (b === 10) lines++
    requests.offset = size
  }
  const now = Date.now()
  requests.samples.push([now, lines])
  requests.samples = requests.samples.filter(([at]) => now - at <= 60000)
  const span = Math.max(now - requests.samples[0][0], 4000)
  return Math.round(requests.samples.reduce((n, [, l]) => n + l, 0) * 60000 / span)
}

// { key: { cpu: percent, memMb, requestsPerMin? } } for every service with a running process
async function sample() {
  const text = await powershell(PS)
  const [procPart, svcPart = ''] = text.split(/^--\s*$/m)
  const children = new Map()
  const cpu = new Map()
  const mem = new Map()
  for (const line of procPart.split(/\r?\n/)) {
    const [pid, ppid, t, ws] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    cpu.set(pid, t)
    mem.set(pid, ws)
  }
  const svcPid = new Map(svcPart.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(p => p.length === 2).map(([n, p]) => [n, Number(p)]))
  const now = Date.now()
  const out = {}
  for (const svc of config.services) {
    const root = svcPid.get(await serviceName(svc))
    if (!root) continue
    const pids = treeOf(root, children)
    const total = pids.reduce((n, p) => n + (cpu.get(p) || 0), 0)
    const before = prev ? pids.reduce((n, p) => n + (prev.cpu.get(p) ?? cpu.get(p) ?? 0), 0) : total
    const wallMs = prev ? now - prev.at : 0
    out[svc.key] = {
      cpu: wallMs > 0 ? Math.max(0, Math.round((total - before) / 1e4 / wallMs / os.cpus().length * 1000) / 10) : 0,
      memMb: Math.round(pids.reduce((n, p) => n + (mem.get(p) || 0), 0) / 1048576),
    }
    if (svc.accessLog) out[svc.key].requestsPerMin = nginxRequestsPerMinute(svc.accessLog)
  }
  prev = { at: now, cpu }
  return out
}

module.exports = { sample }
