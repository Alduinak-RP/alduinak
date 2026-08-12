#!/usr/bin/env node
// Concatenates gamemode_extensions/*.js into gamemode.js.
//
// Same contract as the Server Manager's "Build gamemode only": sorted by
// filename, syntax-checked before it replaces the live file, written
// atomically so the server never hot-reloads a half-written gamemode.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const extDir = process.argv[2] || 'gamemode_extensions';
const target = process.argv[3] || 'gamemode.js';

let parts = [];
try {
  parts = fs.readdirSync(extDir).filter((f) => f.endsWith('.js')).sort();
} catch {
  // No extensions directory is normal
}

if (!parts.length) {
  process.exit(0);
}

const bodies = [];
for (const name of parts) {
  try {
    bodies.push(
      fs.readFileSync(path.join(extDir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
    );
    console.log(`[gamemode] + ${name}`);
  } catch (err) {
    console.error(`[gamemode] could not read ${name}: ${err.message}`);
    process.exit(1);
  }
}

const banner = '// GENERATED from gamemode_extensions/ - edit the parts, not this file.\n\n';
const out = banner + bodies.join('\n\n') + '\n';

try {
  new vm.Script(out, { filename: 'gamemode.js' });
} catch (err) {
  console.error(`[gamemode] syntax error in the concatenated output: ${err.message}`);
  process.exit(1);
}

let current = '';
try {
  current = fs.readFileSync(target, 'utf8');
} catch {
  // First build
}

if (current === out) {
  console.log(`[gamemode] ${target} already up to date`);
  process.exit(0);
}

const tmp = target + '.tmp';
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, target);
console.log(`[gamemode] built ${target} from ${parts.length} extension file(s)`);
