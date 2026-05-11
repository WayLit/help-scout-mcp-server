# Deploying the Help Scout MCP Worker

End-to-end checklist for a fresh Cloudflare deployment. Follow top to bottom. For architecture, design rationale, and troubleshooting, see [`README.md`](./README.md).

All commands run from the repo root unless noted.

## 0. Prerequisites

- Cloudflare account with `wrangler` authenticated (`wrangler login`).
- A Google Workspace tenant (for Cloudflare Access identity).
- A Help Scout admin account that can create OAuth apps.
- **Only if you want a custom domain:** a Cloudflare-managed DNS zone on the same account (e.g. `example.com` already nameservered to Cloudflare).
- Node 24+ and pnpm 11+.

## 1. Install dependencies

```bash
pnpm install
```

`pnpm install` at the repo root installs both the stdio server and the worker workspace package into a single lockfile.

## 2. Create the KV namespace

`OAUTH_KV` stores transient OAuth state (10-min TTL). Per-user Help Scout tokens live in Durable Object storage, not here.

```bash
cd worker
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview
```

Paste the two returned IDs into `worker/wrangler.jsonc` (`id` and `preview_id`), replacing the `REPLACE_WITH_*` placeholders.

## 3. Set up Cloudflare Access

Cloudflare Access fronts the worker for identity. The worker never sees unauthenticated requests; it only sees JWT-signed ones.

1. **Add Google Workspace as an IdP** in Zero Trust → Settings → Authentication → Login methods → Add new → Google Workspace. Follow the connector wizard (one-time admin consent in Workspace).
2. **Create a Self-hosted Access application** for the worker:
   - Application domain: your chosen hostname (e.g. `helpscout-mcp.example.com`), or the `*.workers.dev` URL if not using a custom domain.
   - Identity providers: Google Workspace.
   - Policy: `Allow` if `Emails ending in @<your-workspace-domain>`.
3. **For headless MCP clients (Claude Code, Cursor, etc.)** create a **service token** under Access → Service Auth and attach a second `Allow` policy that matches `Service Token` = the token's name. Each end user will configure the resulting `Client ID` + `Client Secret` as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
4. **Capture two values** for worker secrets:
   - `CF_ACCESS_TEAM_DOMAIN` — your team subdomain (e.g. `acme` for `acme.cloudflareaccess.com`).
   - `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app overview page.

## 4. Create the Help Scout OAuth app

At https://secure.helpscout.net/users/apps create a new OAuth app.

- **Redirect URI:** `https://<your-hostname>/callback/helpscout` (use whatever hostname you'll deploy to — `*.workers.dev` URL or custom domain).
- Save the **App ID** and **App Secret**.

## 5. Set worker secrets

```bash
cd worker
wrangler secret put HELPSCOUT_APP_ID
wrangler secret put HELPSCOUT_APP_SECRET
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUD
```

**Optional — only if you'll have browser-based MCP clients (claude.ai, etc.):**

```bash
wrangler secret put OAUTH_ALLOWED_REDIRECT_HOSTS
# value: comma-separated host patterns, e.g. "claude.ai,*.claude.ai"
```

Loopback (`localhost`, `127.0.0.1`, `[::1]`) is always allowed, so desktop clients work without this.

## 6. Deploy

### Option A: default — deploy to `*.workers.dev`

```bash
pnpm --filter helpscout-mcp-worker deploy
```

Your worker is now at `https://helpscout-mcp.<account>.workers.dev`.

### Option B: deploy under a custom domain

The hostname's zone must be a Cloudflare-managed zone on the same account; `custom_domain: true` provisions DNS automatically.

```bash
cd worker
cp wrangler.custom.jsonc.example wrangler.custom.jsonc
# edit wrangler.custom.jsonc:
#   - set "routes" pattern to your hostname
#   - paste your KV namespace IDs
wrangler deploy --config wrangler.custom.jsonc
```

`--config` replaces (does not merge with) the default `wrangler.jsonc`, so the override file is a complete worker config. Keep it in sync if you later upgrade the base config.

When changing hostname, three things must point at the same place:

1. The `routes` pattern in `wrangler.custom.jsonc`
2. The Help Scout redirect URI: `https://<your-hostname>/callback/helpscout`
3. The Cloudflare Access application domain

## 7. Verify

A successful deploy prints the worker URL. Sanity checks:

```bash
# Should return a Cloudflare Access login challenge, not 5xx from the worker.
curl -i https://<your-hostname>/mcp

# Type-check + dry-run is the same gate CI uses:
pnpm --filter helpscout-mcp-worker type-check
pnpm --filter helpscout-mcp-worker exec wrangler deploy --dry-run
```

## 8. Connect an MCP client

Configure your MCP client to point at the deployed URL, with the service-token headers.

**Claude Code:**

```bash
claude mcp add helpscout https://<your-hostname>/mcp \
  --transport http \
  --header "CF-Access-Client-Id=<service-token-id>" \
  --header "CF-Access-Client-Secret=<service-token-secret>"
```

**Cursor / Claude Desktop / other clients:** use the equivalent `mcpServers` config block with the same two `CF-Access-*` headers and `Url: https://<your-hostname>/mcp`.

On first tool call, the worker bounces you through Help Scout's OAuth consent screen. After consent, per-user tokens are stored in that user's Durable Object and refreshed automatically.

## 9. (Optional) Enable the audit log

For internal-tool deployments, an append-only D1 log of "who called what when" is cheap insurance.

```bash
cd worker
wrangler d1 create helpscout-mcp-audit
# Add to wrangler.jsonc (or wrangler.custom.jsonc):
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

If the `AUDIT_DB` binding is absent, audit logging is a silent no-op. `args_hash` is SHA-256 of the JSON-stringified args, so the log is forensically useful without storing user content.

## Common pitfalls

| Symptom | Likely cause |
|---|---|
| `401` before the worker is hit | Cloudflare Access policy doesn't include the user. Check Zero Trust → Logs → Access. |
| `invalid_grant` loops on tool call | User's Help Scout refresh token was revoked (HS app reinstalled, etc.). Worker should detect and force re-consent; if not, delete the user's DO storage entry manually via the dashboard. |
| Tool calls return `UNAUTHORIZED` | Token storage is missing/corrupt — forces re-auth on next call, which usually self-heals. |
| Service-token auth fails | Headers must be exactly `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and the service-token policy must be attached to the same Access app. |
| `wrangler deploy` fails with DNS error | Custom domain's zone is not Cloudflare-managed on this account. Either move DNS or deploy to `*.workers.dev` instead. |
| `BYPASS_ACCESS=true` is silently ignored in production | Intentional. The runtime refuses it outside `wrangler dev`. |
