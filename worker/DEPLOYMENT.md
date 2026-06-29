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

## 3. Set up Cloudflare Access (identity)

Cloudflare Access provides identity. Scope it to the worker's **`/authorize` endpoint only** — that is the single browser-interactive step where the worker reads the verified email from the Access JWT. Every other endpoint is deliberately left un-fronted: `/mcp` and `/token` are protected by the OAuth bearer token the worker itself issues *after* a successful `/authorize`, and `/callback/helpscout` is guarded by the one-time OAuth state token. Fronting only `/authorize` is what lets MCP clients authenticate with an ordinary browser login instead of a pre-shared service token (see step 8).

1. **Add Google Workspace as an IdP** in Zero Trust → Settings → Authentication → Login methods → Add new → Google Workspace. Follow the connector wizard (one-time admin consent in Workspace).
2. **Create a Self-hosted Access application** scoped to the authorize path:
   - Application domain / path: your hostname **with the `/authorize` path** — e.g. `helpscout-mcp.example.com/authorize` (or the `*.workers.dev` URL + `/authorize`).
   - Identity providers: Google Workspace.
   - Policy: `Allow` if `Emails ending in @<your-workspace-domain>`. This is your perimeter — it still gates every login, because identity can only enter through `/authorize`.
3. **Capture two values** for worker secrets:
   - `CF_ACCESS_TEAM_DOMAIN` — your team subdomain (e.g. `acme` for `acme.cloudflareaccess.com`).
   - `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app overview page.

> **No service token required.** Earlier versions fronted the *entire* hostname, which forced headless clients to send `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every `/mcp` call. With Access scoped to `/authorize`, the interactive browser OAuth flow carries identity and the worker's own bearer token protects the MCP endpoints — so end users connect with no headers (step 8).
>
> After deploying (step 6), verify the scoping: `curl -i https://<hostname>/mcp` should return a **401 bearer challenge from the worker**, not a Cloudflare Access login page. If you get Access login HTML, the app is still fronting the whole host — narrow its path to `/authorize`.

## 4. Create the Help Scout OAuth app

At https://secure.helpscout.net/users/apps create a new OAuth app.

- **Redirect URI:** `https://helpscout-mcp.waylit.ai/callback/helpscout` (use whatever hostname you'll deploy to — `*.workers.dev` URL or custom domain).
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
2. The Help Scout redirect URI: `https://helpscout-mcp.waylit.ai/callback/helpscout`
3. The Cloudflare Access application domain

## 7. Verify

A successful deploy prints the worker URL. Sanity checks:

```bash
# Should return a Cloudflare Access login challenge, not 5xx from the worker.
curl -i https://helpscout-mcp.waylit.ai/mcp

# Type-check + dry-run is the same gate CI uses:
pnpm --filter helpscout-mcp-worker type-check
pnpm --filter helpscout-mcp-worker exec wrangler deploy --dry-run
```

## 8. Connect an MCP client

Point your MCP client at the deployed `/mcp` URL. No headers, no service token — authentication happens through an interactive browser login on first connect.

**Claude Code:**

```bash
claude mcp add helpscout https://helpscout-mcp.waylit.ai/mcp --transport http
```

**Cursor / Claude Desktop / other clients:** use the equivalent `mcpServers` block with `Url: https://helpscout-mcp.waylit.ai/mcp` and no custom headers.

On first connect the client opens a browser and walks you through two consent steps, in order:

1. **Cloudflare Access** — Google Workspace SSO (the `/authorize` gate from step 3; proves *who you are*).
2. **Help Scout** — OAuth consent (grants the worker API access *on your behalf*).

The client then exchanges the resulting code at `/token`, stores its own bearer token, and uses that token for subsequent `/mcp` calls. Per-user Help Scout tokens live in that user's Durable Object and refresh automatically.

> Browser-based clients (claude.ai, etc.) additionally need their redirect host listed in `OAUTH_ALLOWED_REDIRECT_HOSTS` (step 5). Loopback clients like Claude Code work with no extra config.

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
| `curl /mcp` returns a Cloudflare Access login page (HTML) instead of a 401 bearer challenge | The Access app is fronting the whole hostname. Scope it to the `/authorize` path only (step 3), so the bearer-protected `/mcp` and `/token` endpoints stay reachable. |
| Browser never prompts for Cloudflare Access during connect | The `/authorize` path isn't covered by any Access application — identity isn't being enforced. Confirm the app's domain/path includes `/authorize`. |
| `wrangler deploy` fails with DNS error | Custom domain's zone is not Cloudflare-managed on this account. Either move DNS or deploy to `*.workers.dev` instead. |
| `BYPASS_ACCESS=true` is silently ignored in production | Intentional. The runtime refuses it outside `wrangler dev`. |
