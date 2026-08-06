# Help Scout MCP — Cloudflare Worker

Remote MCP server that fronts the Help Scout API for AI assistants. Per-user OAuth, Cloudflare Access for employee identity, Durable Object per session.

Two connectors, one worker:
- **`/mcp`** — mailboxes, conversations, customers, organizations (per-user Help Scout OAuth).
- **`/docs/mcp`** — Help Scout Docs (knowledge base) collections and articles, read **and write** — for finding and fixing stale articles. Each user enters a personal Docs API key (Help Scout → Profile → My API Keys) once through a short web form; see [Docs MCP](#docs-mcp) below.

> **Deploying for the first time?** See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for an end-to-end checklist.

Run all commands from the repo root.

```bash
pnpm install     # install dependencies
pnpm dev         # wrangler dev (localhost:8788)
pnpm deploy      # wrangler deploy
pnpm type-check  # tsc --noEmit
pnpm test        # vitest
```

## Compared to the official Help Scout MCP

Help Scout runs its own hosted MCP server at `https://mcp.helpscout.net/mcp` ([their docs](https://docs.helpscout.com/article/1779-connect-your-ai-agent-with-help-scout-to-search-conversations-and-pull-reports)). If you only need read access, use theirs: nothing to deploy, plus reporting and admin surfaces this worker lacks.

This worker covers what the official server still leaves out — **writes**, behind controls you own.

| | Official | This worker |
|---|---|---|
| Conversations, customers, organizations | read | read, plus composite search/context tools |
| Reports (company, conversation, productivity, happiness) | ✅ Plus/Pro | ❌ |
| Users, teams, workflows, saved replies | ✅ | ❌ (inboxes only) |
| Conversation writes | ❌ on their roadmap | ✅ draft replies, status, assign, move, new draft |
| Docs (knowledge base) | search + read | full CRUD on collections and articles, plus image upload |
| PII redaction | — | ✅ on by default, fails closed |
| SSO perimeter | Help Scout login | ✅ Cloudflare Access in front of the OAuth flow |
| Audit log | — | ✅ optional, append-only D1 |
| Ops burden | none, hosted | you deploy and run the Worker |

The two coexist. They authenticate independently, so connect both: the official server for reporting, this worker for drafting and Docs edits.

> Capabilities compared as of August 2026. Help Scout lists write support as planned, so check their docs before assuming this table still holds.

## One-time setup

### 1. Create the KV namespace

`OAUTH_KV` stores short-lived OAuth state (10-min TTL). Per-user Help Scout tokens live in Durable Object storage, not here.

```bash
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview
```

Paste the returned IDs into `wrangler.jsonc` (`id` and `preview_id`).

### 2. Cloudflare Access on the browser-interactive endpoints

Cloudflare Access handles employee identity. Scope it to the worker's **browser-interactive paths only**:

- `/authorize` — both connectors' OAuth entry.
- `/callback/helpscout` — the Help Scout OAuth redirect. The worker re-verifies the Access JWT here, binding the callback to the identity that started the flow on top of the one-time OAuth state token.
- `/docs-api-key/*` — the Docs API key entry and rotation form, gated separately because it sits outside the OAuth code path.

Leave Access off the MCP endpoints (`/mcp`, `/docs/mcp`, `/token`) and the image upload endpoint (`/docs/assets/upload`): bearer tokens the worker issues *after* `/authorize` already protect those. Scoping this way lets MCP clients log in through an ordinary browser flow instead of carrying a pre-shared service token. **Important:** step 3 of the [deployment checklist](./DEPLOYMENT.md#3-set-up-cloudflare-access-identity) carries a critical warning about `/docs/assets/upload`.

Pick a hostname for your deployment (e.g. `helpscout-mcp.example.com`) and set it as the `routes` pattern in `wrangler.jsonc`. The rest of this section uses `<YOUR_HOSTNAME>` to mean that value.

1. **Configure Google Workspace as an IdP** in Cloudflare Zero Trust → Settings → Authentication → Login methods → Add new → Google Workspace. Follow the connector wizard (one-time admin consent in Workspace).
2. **Create a Self-hosted Access application** scoped to the authorize + callback + docs-key paths:
   - Application domain / path: `<YOUR_HOSTNAME>/authorize` — add a second path rule for `<YOUR_HOSTNAME>/callback/helpscout` and a third for `<YOUR_HOSTNAME>/docs-api-key/*` in the same app (or separate apps with an identical policy)
   - Identity providers: Google Workspace
   - Policy: `Allow` if `Emails ending in @<your-workspace-domain>` — this is your perimeter, and every login still crosses it, since identity enters only through these paths
3. **Capture two values** for worker secrets:
   - `CF_ACCESS_TEAM_DOMAIN` — your team subdomain, e.g. `acme` for `acme.cloudflareaccess.com`
   - `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app overview page

> Skip the service token: clients connect with no `CF-Access-*` headers, and the browser OAuth flow carries identity. Verify after deploy — `curl -i https://<YOUR_HOSTNAME>/mcp` and `curl -i https://<YOUR_HOSTNAME>/docs/mcp` should each return a 401 bearer challenge from the worker, **not** a Cloudflare Access login page. A login page means the Access app still fronts the whole host.

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

`OAUTH_ALLOWED_REDIRECT_HOSTS` is a comma-separated list of host patterns the worker accepts as MCP `redirect_uri` values. Loopback (`localhost`, `127.0.0.1`, `[::1]`) always passes, so desktop clients need no configuration. For browser-based clients (claude.ai, etc.) set the env var:

```bash
wrangler secret put OAUTH_ALLOWED_REDIRECT_HOSTS
# example value: claude.ai,*.claude.ai
```

Left unset, the worker rejects every non-loopback redirect. That is the safe default: dynamic client registration is enabled, so a permissive list would let an attacker route an Access-authenticated user through `/authorize` to a callback they control.

### 5. Deploy

By default the worker deploys to `helpscout-mcp.<account>.workers.dev`:

```bash
pnpm deploy
```

To deploy under a custom domain, see [Custom domain](#custom-domain) below.

## Docs MCP

Add a second MCP connector in your client pointed at `https://<YOUR_HOSTNAME>/docs/mcp`. No Worker secret to configure: the Docs API key is **personal** rather than account-wide, so each user supplies their own.

First connection flow:

1. The client starts the OAuth handshake against `/docs/mcp` and hits `/authorize`, same as the mailbox connector.
2. Cloudflare Access verifies identity (same policy as above, which must cover `/docs-api-key/*`).
3. For a user with no Docs API key on file, the worker serves a short HTML form instead of redirecting to Help Scout: paste the key from Help Scout → your profile → **My API Keys**.
4. The worker validates the key live against the Docs API, stores it in your per-user Durable Object (alongside your mailbox OAuth tokens — nothing is shared across users), and completes the OAuth grant.

When Help Scout revokes the key or you rotate it, tool calls start failing with `REAUTH_REQUIRED`. To replace it, visit `https://<YOUR_HOSTNAME>/docs-api-key/enter` directly — the client's OAuth flow stays intact.

Tools are read/write: `listCollections`, `getCollection`, `createCollection`, `updateCollection`, `deleteCollection`, `listArticles`, `searchArticles`, `getArticle`, `createArticle`, `updateArticle`, `deleteArticle`, `createArticleImageUpload`. New articles default to `status: notpublished`, so you can review a draft before it goes live — pass `status: "published"` to publish immediately.

### Adding images to articles

Image bytes never travel through a tool call. MCP arguments are JSON, so an image would arrive as base64 the model types out character by character. The upload runs locally instead:

1. `createArticleImageUpload(articleId)` returns an `uploadUrl`, a single-use `uploadToken` (15-minute expiry, bound to that one article), and the size and format limits. The article must already exist; an ID that doesn't resolve fails the call immediately. A sequential article number works too — the token binds to the resolved article ID, which the upload endpoint requires.
2. A local uploader POSTs the file to `uploadUrl` as `multipart/form-data` with the image in a `file` field and `Authorization: Bearer <uploadToken>`. The response is `{ filelink, filename, width, height }`. A failed upload still consumes the token — mint a fresh one to retry.
3. Call `getArticle`, insert `<img src="<filelink>">` into the body, and save with `updateArticle`.

Adding several images? Upload them all first, then apply every `<img>` tag in a **single** `updateArticle` call — `updateArticle` replaces the whole body, so one call per image would discard the previous insertions.

Limits: 10 MB per image; PNG, JPEG, GIF, and WebP only. The worker rejects SVG, because Help Scout serves assets from its own domain and a scripted SVG would land there as stored XSS. Your Docs API key never leaves the worker — the uploader authenticates with the one-time token alone.

The uploader ships with the Help Scout plugin in [WayLit/claude-plugins](https://github.com/WayLit/claude-plugins).

## Local development

`.dev.vars` (gitignored — copy from `.dev.vars.example`):

```
HELPSCOUT_APP_ID=...
HELPSCOUT_APP_SECRET=...
CF_ACCESS_TEAM_DOMAIN=...
CF_ACCESS_AUD=...
```

Setting `BYPASS_ACCESS=true` in `.dev.vars` skips Access JWT verification locally — **never** set it in production. Outside `wrangler dev`, the runtime refuses to start with the flag on.

```bash
pnpm dev
```

The Help Scout OAuth flow needs the redirect URI to be reachable. For local testing, either:

- Add `http://localhost:8788/callback/helpscout` as an allowed redirect URI in your HS app, or
- Use `wrangler dev --remote` to run the worker on Cloudflare's edge with a temporary `*.workers.dev` URL.

## Architecture

- **Entry**: `src/index.ts` — one `OAuthProvider` with two `apiHandlers`: `HelpScoutMCP` at `/mcp` and `HelpScoutDocsMCP` at `/docs/mcp`.
- **Auth**: Cloudflare Access (scoped to `/authorize`, `/callback/helpscout`, and `/docs-api-key/*`) verifies identity → JWT in `Cf-Access-Jwt-Assertion` → worker extracts email and completes the OAuth grant. The MCP client then holds a worker-issued bearer token for `/mcp`, `/docs/mcp`, and `/token`. Help Scout authorization-code flow runs once per user for `/mcp` (and re-runs on `invalid_grant`); `/docs/mcp` instead collects a personal Docs API key once via a web form. Both credentials live in the same per-user DO.
- **Per-user isolation**: each user's HS tokens, Docs API key, cache, and inbox-discovery results live in their own `MCP_OBJECT` Durable Object instance, keyed by email. `DOCS_MCP_OBJECT` holds only Docs MCP session state (transport + response cache) and RPCs into `MCP_OBJECT` by email for the stored key. No shared credentials.

## Troubleshooting

**"401 from Cloudflare Access" during the browser login at `/authorize`.** Either the Access app is misconfigured or the policy excludes the user. Check Zero Trust → Logs → Access.

**"invalid_grant" loops.** A user's Help Scout refresh token was revoked (HS app reinstalled, user removed, etc.). The worker should detect this and force re-consent automatically; if it doesn't, manually delete the user's DO storage:
```bash
wrangler durable-objects namespace ids MCP_OBJECT
# then use the dashboard "Inspect" tool to delete the entry
```

**Tool call returns `UNAUTHORIZED`.** Token storage is missing or corrupt. The MCP client re-authenticates on its next call.

**`curl /mcp` returns a Cloudflare Access login page instead of a 401 bearer challenge.** The Access app fronts the whole hostname. Scope it to the browser-interactive paths, so the bearer-protected `/mcp` and `/token` endpoints stay reachable. The opposite symptom — no Access prompt in the browser during connect — means no Access app covers `/authorize`, so nothing enforces identity.

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

Without the `AUDIT_DB` binding, audit logging is a silent no-op. `args_hash` is a SHA-256 of the JSON-stringified args, so the log stays forensically useful without storing user content.

## PII redaction

**On by default.** The worker redacts conversation bodies, subjects, customer records, and contact details through [OpenRedaction](https://github.com/sam247/openredaction) (GDPR preset) before anything reaches the model. Set `REDACT_PII=false` to disable.

Redaction runs field by field over the content, rather than swapping whole bodies for a constant, so message structure survives and the model can still tell what a ticket concerns. Placeholders are deterministic — the same email always maps to the same token, so the model can tell that two results involve the same person. Names stay in place by design: redacting them costs real triage value (who filed it, who's assigned) for little privacy gain, since a name alone identifies little once the email, phone, and address are gone.

It fails closed. If the detector throws, the tool call errors rather than returning unredacted text.

## Custom domain

The committed `wrangler.jsonc` has no `routes` block, so `wrangler deploy` puts the worker on `*.workers.dev`. To deploy under your own hostname, use an override config file (gitignored — your hostname stays out of the repo):

```bash
cp wrangler.custom.jsonc.example wrangler.custom.jsonc
# edit wrangler.custom.jsonc — set "routes" pattern + paste your KV namespace IDs
wrangler deploy --config wrangler.custom.jsonc
```

Wrangler's `--config` flag replaces the default config rather than merging with it, so `wrangler.custom.jsonc` must be a complete worker config. If you later change the base `wrangler.jsonc` (new bindings, compatibility flags), copy those changes into your override too.

The hostname's zone must be a Cloudflare-managed zone on the same account before deploy; `custom_domain: true` provisions DNS automatically.

When changing hostname, three things have to point at the same place:
1. The `routes` pattern in `wrangler.custom.jsonc`
2. The Help Scout redirect URI: `https://<your-hostname>/callback/helpscout`
3. The Cloudflare Access application domain/path: `https://<your-hostname>/authorize`

## What's not in this worker

The worker drops two pieces the old stdio server had:

- **Shared OAuth client credentials** — every user authenticates to Help Scout themselves.
- **`HELPSCOUT_DEFAULT_INBOX_ID`** — the deployment is per-user, so scope each call by passing `inboxId`.
