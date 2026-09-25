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

  // Nexus OAuth login (authorization code + PKCE); the registered callback is
  //     http://127.0.0.1:<nexusOauthPort>/nexus/callback
  // Defaults are the registered public "SkyRP" app (a public PKCE client, so
  // no secret ships here); packaged builds have no .env, they rely on these.
  nexusOauthClientId: process.env.NEXUS_OAUTH_CLIENT_ID || 'skyrp',
  nexusOauthPort:     parseInt(process.env.NEXUS_OAUTH_PORT || '48521', 10),

  // Rich Presence application id; a discordAppId in /api/serverinfo overrides it
  discordAppId:       process.env.DISCORD_APP_ID || '1525331715613261934',
  // Party max shown as "(N of 1200)" when no server reports its player cap
  discordPartyMax:    parseInt(process.env.DISCORD_PARTY_MAX || '1200', 10),
  websiteUrl:         process.env.WEBSITE_URL || 'https://alduinak.com/',
}
