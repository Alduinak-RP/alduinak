/**
 * Launcher configuration - developer-only.
 *
 * apiUrl  - Base URL of the Alduinak backend.
 *           Overridden by the API_URL environment variable (set in .env for
 *           local dev, or as a real env var in a packaged/CI build).
 *           The available game servers are fetched from GET /api/servers
 *           at runtime so they never need a launcher rebuild to update.
 */
module.exports = {
  apiUrl: process.env.API_URL || 'https://api.alduinak.com',

  // Nexus login, in preference order:
  //  1. OAuth (users.nexusmods.com, authorization code + PKCE) when a client
  //     id is set. The callback URL to register with the Nexus team is
  //     http://127.0.0.1:<nexusOauthPort>/nexus/callback
  //  2. Websocket SSO (the older Vortex/MO2/Wabbajack flow) when only the
  //     application slug is set.
  // With neither, the Nexus Login button reports login as not configured.
  nexusOauthClientId: process.env.NEXUS_OAUTH_CLIENT_ID || '',
  nexusOauthPort:     parseInt(process.env.NEXUS_OAUTH_PORT || '48521', 10),
  nexusAppSlug:       process.env.NEXUS_APP_SLUG || '',
}
