'use strict'

/**
 * GitHub webhook handler: POST /webhooks/github, fired on pushes to the SkyMP-Client repo.
 * Verifies the HMAC-SHA256 signature (X-Hub-Signature-256), responds 200 immediately so
 * GitHub doesn't time out, then runs `git pull` in sources/client/ and rebuilds public/files/root/.
 * Setup (SkyMP-Client repo, Settings -> Webhooks): payload URL https://<server>/webhooks/github,
 * content type application/json, secret GITHUB_WEBHOOK_SECRET (required env var), push event only.
 */

const crypto  = require('crypto')
const path    = require('path')
const { execFile } = require('child_process')
const express = require('express')
const rateLimit = require('express-rate-limit')
const { mergeSourcesIntoRoot } = require('../scripts/merge-files')

const router = express.Router()

const githubWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
})

const CLIENT_DIR   = path.join(__dirname, '..', 'sources', 'client')
const DEFAULT_BRANCH = process.env.CLIENT_BRANCH || 'refs/heads/main'

// Signature verification

// Constant-time compare of expected vs received HMAC-SHA256 signature; true if the payload was signed with `secret`
function verifySignature(secret, rawBody, receivedSig) {
  if (typeof receivedSig !== 'string') return false

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  try {
    // Buffers must be the same length for timingSafeEqual
    if (expected.length !== receivedSig.length) return false
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(receivedSig)
    )
  } catch {
    return false
  }
}

// Update pipeline

// Pull latest from the client repo and rebuild the file root; runs after the HTTP response is already sent
function pullAndMerge() {
  console.log('[webhook] Running git pull in', CLIENT_DIR)

  execFile('git', ['-C', CLIENT_DIR, 'pull', '--ff-only'], (err, stdout, stderr) => {
    if (err) {
      console.error('[webhook] git pull failed:', stderr.trim() || err.message)
      return
    }

    const summary = stdout.trim()
    if (summary === 'Already up to date.') {
      console.log('[webhook] Client already up to date, skipping merge.')
      return
    }

    console.log('[webhook] git pull:', summary)

    mergeSourcesIntoRoot().catch(mergeErr => {
      console.error('[webhook] merge failed:', mergeErr.message)
    })
  })
}

// Route

router.post('/github', githubWebhookLimiter, (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET

  // Secret must be configured; reject silently otherwise
  if (!secret) {
    console.error('[webhook] GITHUB_WEBHOOK_SECRET is not set.')
    return res.status(500).json({ error: 'Webhook not configured on server.' })
  }

  // Signature verification
  const sig = req.headers['x-hub-signature-256']
  if (!verifySignature(secret, req.rawBody, sig)) {
    console.warn('[webhook] Rejected request with invalid signature.')
    return res.status(401).json({ error: 'Invalid signature.' })
  }

  const event = req.headers['x-github-event']
  const body  = req.body  // already parsed by express.json()

  // Acknowledge immediately; GitHub times out after 10 s
  res.json({ ok: true, event })

  // Handle push to the tracked branch
  if (event === 'push') {
    const ref = body?.ref
    if (ref !== DEFAULT_BRANCH) {
      console.log(`[webhook] Push to ${ref}, not the tracked branch (${DEFAULT_BRANCH}), ignoring.`)
      return
    }

    const pusher  = body?.pusher?.name || 'unknown'
    const commits = body?.commits?.length ?? 0
    console.log(`[webhook] Push by ${pusher}: ${commits} commit(s) on ${ref}`)

    pullAndMerge()
    return
  }

  // ping: GitHub sends this when the webhook is first created
  if (event === 'ping') {
    console.log('[webhook] Ping received, webhook is connected.')
    return
  }

  console.log(`[webhook] Unhandled event: ${event}`)
})

module.exports = router
