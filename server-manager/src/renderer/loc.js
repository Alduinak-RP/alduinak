'use strict'

// Line from the manager section of localization/en_loc.json (window.EN_LOC from the preload) with {placeholders} filled
function loc(key, vars) {
  let node = window.EN_LOC
  for (const part of key.split('.')) node = node && typeof node === 'object' ? node[part] : undefined
  if (typeof node !== 'string') return key
  return vars ? node.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : node
}

// Fills data-loc (text), data-loc-html, data-loc-title and data-loc-placeholder under root
function applyLoc(root = document) {
  for (const el of root.querySelectorAll('[data-loc]')) el.textContent = loc(el.dataset.loc)
  for (const el of root.querySelectorAll('[data-loc-html]')) el.innerHTML = loc(el.dataset.locHtml)
  for (const el of root.querySelectorAll('[data-loc-title]')) el.title = loc(el.dataset.locTitle)
  for (const el of root.querySelectorAll('[data-loc-placeholder]')) el.placeholder = loc(el.dataset.locPlaceholder)
}

document.addEventListener('DOMContentLoaded', () => applyLoc())
