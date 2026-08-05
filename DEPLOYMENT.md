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

This installs the worker's dependencies from the repo-root `package.json`.

## 2. Create the KV namespace

`OAUTH_KV` stores transient OAuth state (10-min TTL). Per-user Help Scout tokens live in Durable Object storage, not here.

```bash
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview
```

Paste the two returned IDs into `wrangler.jsonc` (`id` and `preview_id`), replacing the `REPLACE_WITH_*` placeholders.

## 3. Set up Cloudflare Access (identity)

Cloudflare Access provides identity. Scope it to the worker's **browser-interactive paths only**: `/authorize` (OAuth entry for both `/mcp` and `/docs/mcp`), `/callback/helpscout` (the Help Scout OAuth redirect — the worker re-verifies the Access JWT here, binding the callback to the identity that started the flow, on top of the one-time OAuth state token), and `/docs-api-key/*` (the Docs API key entry/rotation form — see the [Docs MCP](./README.md#docs-mcp) section in the README). Every other endpoint is deliberately left un-fronted: `/mcp`, `/docs/mcp`, and `/token` are protected by the OAuth bearer token the worker itself issues *after* a successful `/authorize`, and `/docs/assets/upload` is protected by the single-use upload token minted by the `createArticleImageUpload` tool. Fronting only these paths is what lets MCP clients authenticate with an ordinary browser login instead of a pre-shared service token (see step 8).

> **Do not add `/docs/assets/upload` to the Access application.** It is called by a headless local uploader that has no browser session. Fronting it with Access serves a login page instead of accepting the upload, silently breaking image uploads. Scope the Access app to `/authorize`, `/callback/helpscout`, and `/docs-api-key/*` only.

1. **Add Google Workspace as an IdP** in Zero Trust → Settings → Authentication → Login methods → Add new → Google Workspace. Follow the connector wizard (one-time admin consent in Workspace).
2. **Create a Self-hosted Access application** scoped to the authorize + callback + docs-key paths:
   - Application domain / path: your hostname **with the `/authorize` path** — e.g. `helpscout-mcp.example.com/authorize` (or the `*.workers.dev` URL + `/authorize`). Add a second path rule for `/callback/helpscout` and a third for `/docs-api-key/*` in the same app (or separate apps with an identical policy) — the callback rule is required, not just for Docs MCP.
   - Identity providers: Google Workspace.
   - Policy: `Allow` if `Emails ending in @<your-workspace-domain>`. This is your perimeter — it still gates every login, because identity can only enter through these paths.
3. **Capture two values** for worker secrets:
   - `CF_ACCESS_TEAM_DOMAIN` — your team subdomain (e.g. `acme` for `acme.cloudflareaccess.com`).
   - `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app overview page.

> **No service token required.** Earlier versions fronted the *entire* hostname, which forced headless clients to send `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every `/mcp` call. With Access scoped this way, the interactive browser OAuth flow carries identity and the worker's own bearer token protects the MCP endpoints — so end users connect with no headers (step 8).
>
> After deploying (step 6), verify the scoping: `curl -i https://<hostname>/mcp` and `curl -i https://<hostname>/docs/mcp` should each return a **401 bearer challenge from the worker**, not a Cloudflare Access login page. If you get Access login HTML, the app is still fronting the whole host — narrow its path.

## 4. Create the Help Scout OAuth app

At https://secure.helpscout.net/users/apps create a new OAuth app.

- **Redirect URI:** `https://helpscout-mcp.waylit.ai/callback/helpscout` (use whatever hostname you'll deploy to — `*.workers.dev` URL or custom domain).
- Save the **App ID** and **App Secret**.

## 5. Set worker secrets

```bash
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
pnpm deploy
```

Your worker is now at `https://helpscout-mcp.<account>.workers.dev`.

### Option B: deploy under a custom domain

The hostname's zone must be a Cloudflare-managed zone on the same account; `custom_domain: true` provisions DNS automatically.

```bash
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
# Should return a 401 bearer challenge from the worker, not 5xx and not an Access login page.
curl -i https://helpscout-mcp.waylit.ai/mcp
curl -i https://helpscout-mcp.waylit.ai/docs/mcp

# Type-check + dry-run is the same gate CI uses:
pnpm type-check
pnpm exec wrangler deploy --dry-run
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

**Docs MCP (optional, separate connector):** add a second entry pointed at `/docs/mcp`, e.g. `claude mcp add helpscout-docs https://helpscout-mcp.waylit.ai/docs/mcp --transport http`. First connect walks through Cloudflare Access, then — instead of Help Scout OAuth consent — a short form asking for your personal Docs API key (Help Scout → profile → **My API Keys**). See [Docs MCP](./README.md#docs-mcp) in the README for details.

## 9. (Optional) Enable the audit log

For internal-tool deployments, an append-only D1 log of "who called what when" is cheap insurance.

```bash
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
| `curl /mcp` or `curl /docs/mcp` returns a Cloudflare Access login page (HTML) instead of a 401 bearer challenge | The Access app is fronting the whole hostname. Scope it to `/authorize`, `/callback/helpscout`, and `/docs-api-key/*` only (step 3), so the bearer-protected `/mcp`, `/docs/mcp`, and `/token` endpoints stay reachable. |
| Browser never prompts for Cloudflare Access during connect | The `/authorize` (or `/callback/helpscout`, or `/docs-api-key/*`) path isn't covered by any Access application — identity isn't being enforced. Confirm the app's domain/path includes it. |
| `Missing Cf-Access-Jwt-Assertion header` on the Help Scout redirect back to the worker | The Access app's path rules don't cover `/callback/helpscout`. The worker re-verifies the Access JWT on that route (to bind the callback to the identity that started the flow), so it must be fronted the same as `/authorize`. Add the path rule (step 3). |
| Docs MCP tool calls return `REAUTH_REQUIRED` | No Docs API key on file, or Help Scout revoked/rotated it. Visit `/docs-api-key/enter` to (re)connect one. |
| Image upload returns a Cloudflare Access login page instead of `201` | The Access app is fronting `/docs/assets/upload`. Narrow its path rules to `/authorize`, `/callback/helpscout`, and `/docs-api-key/*` only (step 3). |
| Image upload returns `401 INVALID_UPLOAD_TOKEN` | The token was already used — including by a prior attempt that failed after the token was read, since it's burned on read, not on success — or more than 15 minutes elapsed since `createArticleImageUpload`. If the token was only just minted, this can also be a KV read-consistency miss (the token hasn't propagated to this colo yet); retrying is safe in that case. Otherwise mint a fresh one per image. |
| `wrangler deploy` fails with DNS error | Custom domain's zone is not Cloudflare-managed on this account. Either move DNS or deploy to `*.workers.dev` instead. |
| `BYPASS_ACCESS=true` is silently ignored in production | Intentional. The runtime refuses it outside `wrangler dev`. |
