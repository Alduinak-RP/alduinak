'use strict'

const crypto = require('crypto')

// Constant-time string compare that also hides the length; an empty expected value never matches
function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b) && provided.length === expected.length
}

module.exports = safeEqual
