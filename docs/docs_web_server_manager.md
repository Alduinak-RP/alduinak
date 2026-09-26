# Web Server Manager (dashboard Server tab)

The dashboard at `dashboard.alduinak.com` has a **Server** tab for dashboard admins.
From it staff can check the services, read logs, follow web jobs, use a limited game
console, view the settings with every secret hidden, start, stop or restart the game
server, and run the **Build gamemode only** and **Build server** jobs.

Everything else stays on the box, in the Electron Server Manager over RDP: manifest
updates, Sync settings or data, settings edits, launcher, client and native builds,
purge and the database wipe.

## 1. How it fits together

```
Browser (dashboard.alduinak.com, static files from :4002)
  -> https://api.alduinak.com/api/manager/*          nginx, TLS
  -> AlduinakBackend routes/manager.js (:4000)        login checks, rate limits, audit
  -> signed HTTP to 127.0.0.1:4003
  -> AlduinakManager agent (server-manager/src/agent.js)
       nssm service control, the manager's Builder, the console relay, log files
```

- **Backend.** This is the only part reachable from the internet. It holds no build
  logic. It checks the session, then forwards the request to the agent, signed with
  `MANAGER_AGENT_SECRET`.
- **Agent.** A separate nssm service (`AlduinakManager`). It listens on `127.0.0.1`
  only and runs as the Administrator account, so builds see the same yarn and caches
  as manual builds. It is a separate service because nssm 2.24 kills a service's child
  processes when that service stops. A build started by the backend would therefore
  die on every backend restart.
- **Jobs.** The agent runs one job at a time. Each job is a JSON record plus a log in
  `C:\logs\manager\jobs`. A job the agent was running when it stopped is marked
  `interrupted` at its next start.
- **Busy lock.** The agent and the Electron manager share one lock file,
  `C:\logs\manager\busy.lock`. A web job and an Electron build or sync can never run
  at the same time. The lock records the process start time, so a reused Windows pid
  never keeps a dead lock alive. Status polling only reads the lock. Only a process
  taking the lock removes a dead one, and it first moves the file aside. If the file
  it moved is no longer the dead lock it checked, it puts it back.

## 2. Security model

### Who gets in

| Check | Rule |
|---|---|
| Role | The session must hold `admin.*`. It comes from a Discord role mapped in `data/role-permissions.json` (today the **Staff** role) or from `DASHBOARD_DISCORD_IDS` in `.env`. Every admin has the same rights. |
| Live roles | Every manager request asks Discord for the member's current roles, cached for 60 s and cleared when Discord reports a role change. If Discord cannot be reached the request is refused with 503, never allowed. |
| Discord 2FA | The login stores `mfa_enabled` from Discord's `identify` scope. A session without it gets no manager access. Discord only reports this at login, so turning 2FA off later takes effect at the next login, at the latest 12 hours later. |
| Audience | Only a login that returned to the dashboard origin (`DASHBOARD_PUBLIC_URL`) may use the manager. Tokens delivered to `WEBSITE_URL` are refused. |
| Login link | The page accepts a `#token=` only with the one-time nonce it stored when the login started. A crafted link cannot sign someone into another account. The old `?token=` query fallback is gone. |
| Session limits | A session holding `admin.*` ends after **30 idle minutes** or **12 hours**, whichever comes first, on every dashboard route. Other staff sessions keep the 24 hour limit. Only requests made after real input (a click, key press, scroll or touch) count as activity. The Server tab marks its background polls with `X-Dashboard-Poll: 1`, and those never reset the idle clock, so a Server tab left open unattended is still signed out after 30 minutes. |
| Writes | A POST must carry an `Origin` equal to the dashboard origin. Tokens travel only in the `Authorization` header, never in cookies. |

### Permission escalation guard

Every path to `admin.*` passes the same gate as the manager itself: `admin.*`
confirmed against Discord at that moment, a dashboard-origin login with Discord 2FA,
and the dashboard `Origin` header. The gate covers these paths:

- **Role permissions.** `routes/role-permissions.js` refuses any change that adds or
  removes a privileged permission. Deleting a role that holds one counts as a
  removal. The privileged permissions are:
  - `admin.*` and any other `admin.` permission
  - any `manager.*` permission
  - `factions.define`
  - `permissions.manage`, which can hand out permissions
  - `server.access.manage`, which chooses the roles the bot hands out

  Staff with only `permissions.manage` (the **Admin** role) can still edit ordinary
  permissions.
- **Whitelist and banned roles.** The Discord bot adds and removes these roles for
  anyone with `players.manage`. So:
  - changing `whitelistRoleId` or `bannedRoleId` in `/api/server-access` needs the
    gate. The lock settings stay open to `server.access.manage`.
  - a role that holds any privileged permission can never become the whitelist or
    banned role.
  - the bot refuses to add or remove such a role even when it was set outside the
    dashboard, by a hand edit of the `access` block in `server-settings.json`.

  A dashboard ban is still written to `bans.json` in that case. Only the Discord role
  step is skipped.
- **The `/api/admin` proxy.** It forwards to the SkyMP-Admin service, which can stop
  the game server. A call with the static `ADMIN_TOKEN` is forwarded as before. A
  dashboard session needs the full manager gate, and every forwarded write is audited.
  Granular `admin.<x>` grants no longer open it.

A refusal answers 403 with a `reason` (`admin`, `audience`, `mfa` or `origin`), 503
when Discord cannot be asked, or 401 when Discord says the caller lost the role. The
401 also ends that session.

### Sessions follow permission changes immediately

A session is dropped as soon as its permissions no longer match what it was issued.
That happens in three ways:

- Every dashboard request recomputes the permissions from `role-permissions.json` and
  `DASHBOARD_DISCORD_IDS`. The backend reads both live from disk.
- Saving or deleting a role in the Permissions view revokes every session whose
  permissions changed.
- When Discord reports a member's roles changed, or the member left the server, that
  member's sessions are revoked. Manager requests also compare against Discord's live
  roles.

Removing someone from the Staff role in Discord therefore locks them out of the
manager on their next request.

### Abuse limits and headers

| Budget | Limit |
|---|---|
| `/auth/dashboard/url` and `/callback` | 20 per minute per IP |
| `/api/manager` before login checks | 600 per minute per IP |
| Manager reads (the tab polls every 3 s) | 300 per minute per session |
| Manager actions | 20 per minute per session |

The dashboard pages send these headers:

- `Content-Security-Policy`, with scripts and styles from the dashboard itself only,
  connections only to the API origin, `frame-ancestors 'none'`, `base-uri 'none'`,
  `form-action 'self'` and `object-src 'none'`
- `X-Frame-Options: DENY`
- `nosniff`
- `Referrer-Policy: no-referrer`
- HSTS

Player-controlled text (log lines, chat, names) is only ever inserted as text, never
as HTML.

### Secrets

- **Tokens at rest.** Dashboard tokens are stored only as sha256 hashes in
  `data/dashboard-sessions.json`.
- **Settings view.** Nothing secret ever reaches the browser. Secret fields show only
  "secret set" or "not set". JSON fields are masked key by key: `voiceChat`
  apiKey/apiSecret, `discordAuth` botToken, `metricsAuth` password,
  `additionalServerSettings[].token`. Unknown keys that look like credentials are
  masked as well.
- **Locked fields.** The settings view is read-only. Fields that would allow code
  execution, path changes, auth changes or data loss are also marked `locked`, so a
  later settings editor must never offer them:
  - `gamemodePath`, `dataDir`, `databaseDriver`, `databaseName`, `databaseUri`, `logDir`
  - `master`, `offlineMode`, `enableConsoleCommandsForAll`
  - the admin lists, `loadOrder`, `archives`, `startPoints`, `additionalServerSettings`
  - the ports and hosts
  - in `.env`, the URL, redirect, token and lock keys and every `MANAGER_*` key
- **Log and console text.** Before it leaves the agent, every current secret value
  (8 or more characters) from `.env` and `server-settings.json` is replaced with
  `[redacted]`, and `mongodb://` connection strings are stripped. Lines starting with
  `__` (internal replies such as `__PLAYERSJSON__`) are dropped. The nginx
  `access.log` is not offered at all.

### Console

Only `say <text>`, `notify <name|all> <text>`, `kick <name>`, `players` and `status`
reach the game. Commands are capped at 500 characters, control characters are
stripped, and any command containing `__` is refused. The backend and the agent both
check this list.

### Agent transport

- **Callers.** The agent binds `127.0.0.1` and drops any connection that is not
  loopback or that carries `X-Forwarded-For`, `X-Real-IP` or `Forwarded`. It also
  checks the `Host` header.
- **Signature.** Each call carries an HMAC-SHA256 signature over the timestamp, a
  nonce, the method, the full path with its query, the acting admin and a body hash.
  Calls more than 30 s off are refused, and so are replayed nonces.
- **Secret.** If `MANAGER_AGENT_SECRET` is shorter than 32 characters, the agent
  refuses every call.
- **Allowed inputs.** Job kinds, log ids and query values come from fixed lists or
  must be integers. No request text reaches a shell, nssm or git.

### Builds from the web

A web build runs only when all of these hold:

- the live checkout is on `main`
- no merge is in progress
- nothing is uncommitted apart from the version files (`skymp5-client` and
  `skymp5-server` `package.json`, and `skymp5-launcher-tauri/src-tauri/tauri.conf.json`)

The commit id is stored in the job record and in the audit log.

`build/dist/server/gamemode_extensions` is **not in git**, so the checks above say
nothing about the gamemode parts. Anyone with file access on the box can change them.
Every **Build gamemode only** and **Build server** job therefore also records their
hashes:

- the sha256 of each `*.js` part it read, in the job record (`gamemode.files`) and in
  the job log
- one combined hash (`gamemode.sha256`), in the job record, the Jobs tab (`gm`) and
  the agent audit line (`gamemodeSha256`)

The combined hash is the sha256 of one line per part, in ordinal (case-sensitive) file
name order, in the form `<lowercase sha256><two spaces><file name>` plus a newline. To
list the parts on the box in that form and compare them with a job's `gamemode.files`:

```powershell
Get-FileHash -Algorithm SHA256 build\dist\server\gamemode_extensions\*.js | Sort-Object Path | ForEach-Object { "$($_.Hash.ToLower())  $(Split-Path $_.Path -Leaf)" }
```

**Start** and **Restart** are refused while a MongoDB purge is pending, the same rule
the Electron manager applies. After a wipe, the runbook in
[Database Wipe](docs_database_wipe.md) stamps `purgedAt`, which clears it.

### Audit

Two files, each written by one process and hash-chained line to line:

- **`C:\logs\manager\audit-backend.jsonl`** records:
  - every login attempt, including failures
  - every denied, rate-limited or refused manager request
  - every job start, console command and settings view
  - every privileged role permission change, whitelist or banned role change and
    admin proxy write, and every refused one
- **`C:\logs\manager\audit-agent.jsonl`** records job starts and finishes, console
  sends and refused signatures.

Each line carries the Discord id and name, the IP, the action, the outcome, the job id
and the commit.

Check that a file is intact:

```bash
node -e "console.log(require('./skymp5-backend/sources/manager/audit').verifyAuditFile('C:/logs/manager/audit-backend.jsonl'))"
```

If `MANAGER_AUDIT_WEBHOOK_URL` is set to a Discord webhook, the backend also posts to
that channel, at most 30 posts a minute. It posts failed logins, admin logins, denied
requests, job starts, console commands and role guard decisions. That channel is the
off-box copy that makes tampering visible.

### What this does not protect against

- **Local code.** Anything already running on the box can read `skymp5-backend/.env`,
  including the agent secret. That covers the game server (LocalSystem, third-party
  server plugins, gamemode JS). The loopback check and the signature only stop
  network callers.
- **Staff role membership.** Anyone in the Staff role in Discord is a manager admin.
  Keep that role small.
- **Stolen Discord accounts.** A taken-over Discord account of an admin who has 2FA
  still gets in. The audit webhook is how you notice.
- **Gamemode parts.** `gamemode_extensions` is outside git. Job hashes show what was
  built, not who wrote it.
- **Backend compromise.** AlduinakBackend still runs as LocalSystem, so a backend
  compromise is a box compromise.

Known gaps worth closing later:

- The launcher session files (`data/sessions.json`, `auth-states.json`) still hold
  raw tokens.
- Ports 4000 and 4002 listen on all interfaces and rely on the firewall.
- The relay on 7778 has no brute-force limit.

## 3. First-time setup (owner, on the box)

1. **Add the keys to `skymp5-backend/.env`.** Generate the secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   ```
   MANAGER_AGENT_PORT=4003
   MANAGER_AGENT_SECRET=<the 64 hex characters>
   # optional
   MANAGER_LOG_DIR=C:\logs\manager
   MANAGER_AUDIT_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
   ```
2. **Check the Discord application.** Its OAuth2 redirects must include
   `https://api.alduinak.com/auth/dashboard/callback`, matching
   `DISCORD_DASHBOARD_REDIRECT_URI`. Confirm that `DASHBOARD_PUBLIC_URL` is
   `https://dashboard.alduinak.com`.
3. **Install the agent service.** Run `server-manager\Setup-Agent.bat`. It asks for
   admin rights, installs `AlduinakManager` and opens the nssm editor. On its
   **Log on** tab, choose *This account*, enter `.\Administrator` and the password,
   then press *Edit service*. The equivalent commands, from an elevated `cmd.exe`:
   ```
   C:\tools\nssm\nssm.exe install AlduinakManager "C:\Program Files\nodejs\node.exe" "src\agent.js"
   C:\tools\nssm\nssm.exe set AlduinakManager AppDirectory "C:\Users\Administrator\Desktop\alduinak\server-manager"
   C:\tools\nssm\nssm.exe set AlduinakManager AppStdout "C:\logs\manager-agent.log"
   C:\tools\nssm\nssm.exe set AlduinakManager AppStderr "C:\logs\manager-agent-err.log"
   C:\tools\nssm\nssm.exe set AlduinakManager AppRotateFiles 1
   C:\tools\nssm\nssm.exe set AlduinakManager AppRotateBytes 10485760
   C:\tools\nssm\nssm.exe set AlduinakManager AppEnvironmentExtra "ALDUINAK_NO_AUTO_INSTALL=1" "ALDUINAK_EXTRA_PATH=C:\Users\Administrator\AppData\Roaming\npm"
   C:\tools\nssm\nssm.exe set AlduinakManager Start SERVICE_AUTO_START
   C:\tools\nssm\nssm.exe set AlduinakManager AppThrottle 5000
   C:\tools\nssm\nssm.exe set AlduinakManager ObjectName .\Administrator "<Administrator password>"
   C:\tools\nssm\nssm.exe start AlduinakManager
   ```
   If the Administrator password ever changes, update it in the service (`nssm edit
   AlduinakManager`), or the agent stops starting.
4. **Restart AlduinakBackend.** This loads the new routes, headers and session store.
   Restart the Electron manager too, so it uses the shared busy lock.
5. **Test it.** Log into the dashboard with a Staff account that has Discord 2FA. Open
   **Server** and check that the status shows *Agent online*. Then run **Build
   gamemode only** once.
6. **Check the daily restart.** `C:\logs\manager-agent.log` shows
   `[schedule] next daily restart at ...` for 04:00 box time. The agent is what runs it,
   so there is no daily restart until this service is installed and running.

## 4. Staff runbook

**Logging in.** Use the dashboard's own Discord Login button. If the tab says
two-factor authentication is needed, turn on 2FA in Discord, then log out and back in.
After 30 minutes without a click or key press, or after 12 hours, you are signed out.
A Server tab that is only refreshing on its own does not count. Log in again.

**Status tab.**
- The services list shows every service. Only the game server has **Start**,
  **Restart** and **Stop**. Every action asks for confirmation and runs as a job.
- **Busy** shows what holds the build lock: a web job or the Electron manager.
- A red line means a MongoDB purge is pending, so the game server will not start from
  anywhere.

**Builds.**
- **Build gamemode only** regenerates `gamemode.js` from `gamemode_extensions`. The
  server hot-reloads it, no restart needed. The job log lists each part with its
  hash, and the Jobs tab shows the combined hash beside the commit.
- **Build server** bundles the TypeScript into `dist_back` and rebuilds the gamemode.
  Afterwards, restart the game server so the new bundle loads.
- A refused build names the reason. Either the checkout is not on main, a merge is in
  progress, it has uncommitted changes, or another task holds the lock. Fix the
  checkout on the box, or wait.

**Jobs tab.** Recent web jobs with who ran them, the commit and the outcome. Click
**Log** to follow a job's output.

**Logs tab.** Pick a service log or a `C:\logs` file.
- **Follow** appends new lines every 3 seconds.
- **Load older** pages back through the file.
- Secrets appear as `[redacted]`.

**Console tab.** Allowed commands: `say <text>`, `notify <name|all> <text>`,
`kick <name>`, `players` and `status`. Output from the game appears below. Anything
else must be done in game or on the box.

**Daily restart.** The agent restarts the game server every day at `AUTO_RESTART_AT`
(`skymp5-backend/.env`, local box time, default `04:00`, read live; `off` disables it).
It broadcasts `Server restart in N minutes. Please find a safe spot and log out.` with
`say` 60 (shown as 1 hour), 30, 10, 5, 4, 3, 2 and 1 minutes before. A warning whose
time already passed when the agent started is skipped. At the target it runs a normal
**Restart** job as *Daily restart*, so the logs are archived into `C:\logs\YYYY-MM`
(the game logs plus the backend's `ban.log` and `faction.log`) and the audit and Jobs
tab record it. If a build holds the lock it retries each minute for 30 minutes; a
pending purge or a game server stopped by hand skips that day. The `[schedule]` lines
appear in the Console tab and `C:\logs\manager-agent.log`. Keep a database wipe or a
long build outside 03:00 to 04:30, or set `AUTO_RESTART_AT=off` for it.

**Settings tab.** A read-only view. Edit settings on the box with the Electron
manager.

**Agent offline.**
1. Check `C:\logs\manager-agent-err.log` and `nssm status AlduinakManager`.
2. If needed, restart it from an RDP session: `nssm restart AlduinakManager`. Never do
   this while a job is running, because the job's build processes are killed with it.

**Removing someone's access.** Take the Staff role away in Discord. Their sessions end
on their next request.

**Suspected compromise.**
1. Remove the role.
2. Replace `MANAGER_AGENT_SECRET` in `.env`. The backend and the agent read it live.
3. Sign everyone out: stop AlduinakBackend, delete
   `skymp5-backend/data/dashboard-sessions.json`, start the backend.
4. Read both audit files and the webhook channel.

## 5. Tests

```bash
cd skymp5-backend
node test/run-manager-tests.js
```

The runner copies the backend and manager code into a temporary folder with a fake
`.env`, fake settings and fake logs. It never reads live data. The tests cover:

- the escalation guard, including the whitelist and banned roles, the gate on
  privileged grants, the `/api/admin` proxy and immediate session invalidation
- the Discord 2FA and audience rules
- the admin idle and lifetime limits, including polling that must not keep a session
  alive
- the Origin check
- the console allow-list
- settings, log and job-log masking
- signed agent calls and refusals
- git checkout refusals
- the shared busy lock and its stale-lock cleanup race
- the gamemode_extensions hashes in job records and the audit
- rate limits
- the audit hash chain
