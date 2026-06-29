# Help Scout MCP — Cloudflare Worker

Remote MCP server that fronts the Help Scout API for AI assistants. Per-user OAuth, Cloudflare Access for employee identity, Durable Object per session.

> **Deploying for the first time?** See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for an end-to-end checklist.

Run all commands from the repo root.

```bash
pnpm install     # install dependencies
pnpm dev         # wrangler dev (localhost:8788)
pnpm deploy      # wrangler deploy
pnpm type-check  # tsc --noEmit
pnpm test        # vitest
```

## One-time setup

### 1. Create the KV namespace

`OAUTH_KV` stores short-lived OAuth state (10-min TTL). Per-user Help Scout tokens live in Durable Object storage, not here.

```bash
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview
```

Paste the returned IDs into `wrangler.jsonc` (`id` and `preview_id`).

### 2. Cloudflare Access on the `/authorize` endpoint

Cloudflare Access handles employee identity. Scope it to the worker's **`/authorize` endpoint only** — that's the one browser-interactive step where the worker reads the verified email from the Access JWT. The MCP endpoints (`/mcp`, `/token`) are left un-fronted because they're protected by the OAuth bearer token the worker issues *after* `/authorize`, and `/callback/helpscout` is guarded by its one-time OAuth state token. Scoping to `/authorize` is what lets MCP clients log in through an ordinary browser flow instead of carrying a pre-shared service token.

Pick a hostname for your deployment (e.g. `helpscout-mcp.example.com`) and set it as the `routes` pattern in `wrangler.jsonc`. The rest of this section uses `<YOUR_HOSTNAME>` to mean that value.

1. **Configure Google Workspace as an IdP** in Cloudflare Zero Trust → Settings → Authentication → Login methods → Add new → Google Workspace. Follow the connector wizard (one-time admin consent in Workspace).
2. **Create a Self-hosted Access application** scoped to the authorize path:
   - Application domain / path: `<YOUR_HOSTNAME>/authorize`
   - Identity providers: Google Workspace
   - Policy: `Allow` if `Emails ending in @<your-workspace-domain>` — this is your perimeter, still enforced on every login since identity only enters through `/authorize`
3. **Capture two values** for worker secrets:
   - `CF_ACCESS_TEAM_DOMAIN` — your team subdomain, e.g. `acme` for `acme.cloudflareaccess.com`
   - `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app overview page

> No service token is needed. Clients connect with no `CF-Access-*` headers; the browser OAuth flow carries identity. Verify after deploy: `curl -i https://<YOUR_HOSTNAME>/mcp` should return a 401 bearer challenge from the worker, **not** a Cloudflare Access login page (which would mean the app is still fronting the whole host).

### 3. Help Scout OAuth app

Create at https://secure.helpscout.net/users/apps. Required redirect URI: `https://<YOUR_HOSTNAME>/callback/helpscout`. Grab the App ID and App Secret.

### 4. Set worker secrets

```bash
wrangler secret put HELPSCOUT_APP_ID
wrangler secret put HELPSCOUT_APP_SECRET
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUD
```

### 4a. Configure the redirect_uri allowlist (only if non-loopback clients)

`OAUTH_ALLOWED_REDIRECT_HOSTS` is a comma-separated list of host patterns this worker will accept as MCP `redirect_uri` values. Loopback (`localhost`, `127.0.0.1`, `[::1]`) is always allowed, so desktop clients work without configuration. For browser-based clients (claude.ai, etc.) set the env var:

```bash
wrangler secret put OAUTH_ALLOWED_REDIRECT_HOSTS
# example value: claude.ai,*.claude.ai
```

Without this, non-loopback redirects are rejected — that's the safe default given dynamic client registration is enabled, since otherwise an Access-authenticated user could be silently redirected through `/authorize` to an attacker-controlled callback.

### 5. Deploy

By default the worker deploys to `helpscout-mcp.<account>.workers.dev`:

```bash
pnpm deploy
```

To deploy under a custom domain, see [Custom domain](#custom-domain) below.

## Local development

`.dev.vars` (gitignored — copy from `.dev.vars.example`):

```
HELPSCOUT_APP_ID=...
HELPSCOUT_APP_SECRET=...
CF_ACCESS_TEAM_DOMAIN=...
CF_ACCESS_AUD=...
```

For local dev, Access JWT verification can be bypassed by setting `BYPASS_ACCESS=true` in `.dev.vars` — **never** set this in production. The runtime refuses to start with `BYPASS_ACCESS=true` outside of `wrangler dev`.

```bash
pnpm dev
```

The Help Scout OAuth flow needs the redirect URI to be reachable. For local testing, either:

- Add `http://localhost:8788/callback/helpscout` as an allowed redirect URI in your HS app, or
- Use `wrangler dev --remote` to run the worker on Cloudflare's edge with a temporary `*.workers.dev` URL.

## Architecture

- **Entry**: `src/index.ts` — `OAuthProvider` wrapping the `HelpScoutMCP` Durable Object.
- **Auth**: Cloudflare Access (scoped to `/authorize`) verifies identity → JWT in `Cf-Access-Jwt-Assertion` → worker extracts email and completes the OAuth grant. The MCP client then holds a worker-issued bearer token for `/mcp` and `/token`. Help Scout authorization-code flow runs once per user (and re-runs on `invalid_grant`); each user's DO holds their HS tokens.
- **Per-user isolation**: each user's HS tokens, cache, and inbox-discovery results live in their own Durable Object instance, keyed by email. No shared credentials.

## Troubleshooting

**"401 from Cloudflare Access" during the browser login at `/authorize`.** The Access app is misconfigured or the user isn't in the policy. Check Zero Trust → Logs → Access.

**"invalid_grant" loops.** A user's Help Scout refresh token was revoked (HS app reinstalled, user removed, etc.). The worker should detect this and force re-consent automatically; if it doesn't, manually delete the user's DO storage:
```bash
wrangler durable-objects namespace ids MCP_OBJECT
# then use the dashboard "Inspect" tool to delete the entry
```

**Tool call returns `UNAUTHORIZED`.** Token storage is missing or corrupt. Forces a re-auth on the MCP client's next call.

**`curl /mcp` returns a Cloudflare Access login page instead of a 401 bearer challenge.** The Access app is fronting the whole hostname. Scope it to the `/authorize` path only, so the bearer-protected `/mcp` and `/token` endpoints stay reachable. Conversely, if the browser never prompts for Access during connect, the `/authorize` path isn't covered by any Access app — identity isn't being enforced.

## Optional: audit log (D1)

For an internal tool, an append-only record of "who called what when" is cheap insurance. Wire up D1 to opt in.

```bash
wrangler d1 create helpscout-mcp-audit
# Add the binding to wrangler.jsonc:
#   "d1_databases": [
#     { "binding": "AUDIT_DB", "database_name": "helpscout-mcp-audit", "database_id": "..." }
#   ]

wrangler d1 execute helpscout-mcp-audit --command "
  CREATE TABLE IF NOT EXISTS tool_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    email TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_hash TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    error_code TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tool_audit_email_ts ON tool_audit (email, ts DESC);
"
```

If the `AUDIT_DB` binding is absent, audit logging is a silent no-op. `args_hash` is a SHA-256 of the JSON-stringified args, so the log is forensically useful without storing user content.

## Custom domain

The committed `wrangler.jsonc` has no `routes` block, so `wrangler deploy` puts the worker on `*.workers.dev`. To deploy under your own hostname, use an override config file (gitignored — your hostname stays out of the repo):

```bash
cp wrangler.custom.jsonc.example wrangler.custom.jsonc
# edit wrangler.custom.jsonc — set "routes" pattern + paste your KV namespace IDs
wrangler deploy --config wrangler.custom.jsonc
```

Wrangler's `--config` flag replaces (does not merge with) the default config, so `wrangler.custom.jsonc` is a complete worker config. If you later change the base `wrangler.jsonc` (e.g. new bindings, compatibility flags), copy those changes into your override too.

The hostname's zone must be a Cloudflare-managed zone on the same account before deploy; `custom_domain: true` provisions DNS automatically.

When changing hostname, three things have to point at the same place:
1. The `routes` pattern in `wrangler.custom.jsonc`
2. The Help Scout redirect URI: `https://<your-hostname>/callback/helpscout`
3. The Cloudflare Access application domain/path: `https://<your-hostname>/authorize`

## What's not in this worker

The worker intentionally omits some pieces that the old stdio server had:

- **Shared OAuth Client Credentials** — every user authenticates Help Scout themselves; no shared app credential.
- **No `HELPSCOUT_DEFAULT_INBOX_ID`** — per-user deployment, scope by passing `inboxId` per call.

PII redaction (via [OpenRedaction](https://github.com/sam247/openredaction)) is added in Phase 6 of the rollout plan.
