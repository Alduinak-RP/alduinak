'use strict'

// Line from the dashboard section of localization/en_loc.json (window.EN_LOC_DASHBOARD) with {placeholders} filled
function dashLoc(key, vars) {
  let node = window.EN_LOC_DASHBOARD
  for (const part of key.split('.')) node = node && typeof node === 'object' ? node[part] : undefined
  if (typeof node !== 'string') return key
  return vars ? node.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : node
}

// Fills data-loc (text), data-loc-html, data-loc-title and data-loc-placeholder under root
function applyDashLoc(root = document) {
  for (const el of root.querySelectorAll('[data-loc]')) el.textContent = dashLoc(el.dataset.loc)
  for (const el of root.querySelectorAll('[data-loc-html]')) el.innerHTML = dashLoc(el.dataset.locHtml)
  for (const el of root.querySelectorAll('[data-loc-title]')) el.title = dashLoc(el.dataset.locTitle)
  for (const el of root.querySelectorAll('[data-loc-placeholder]')) el.placeholder = dashLoc(el.dataset.locPlaceholder)
}

// The Server Manager window (window.EN_LOC) fills its own data-loc from the manager section
if (!window.EN_LOC) document.addEventListener('DOMContentLoaded', () => applyDashLoc())
