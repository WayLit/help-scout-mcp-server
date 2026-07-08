/**
 * Shared types for the Help Scout MCP Worker.
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  /** Session DO for the Docs MCP (/docs/mcp). Per-user Docs API keys live in MCP_OBJECT, not here. */
  DOCS_MCP_OBJECT: DurableObjectNamespace;

  /** Optional: D1 database for tool-call audit log. If absent, audit is a no-op. */
  AUDIT_DB?: D1Database;

  // Cloudflare Access (replaces Google SSO leg)
  /** Team subdomain, e.g. "acme" for acme.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** Application Audience tag from the Access app overview page */
  CF_ACCESS_AUD: string;

  // Help Scout OAuth (per-user authorization-code flow)
  HELPSCOUT_APP_ID: string;
  HELPSCOUT_APP_SECRET: string;

  /**
   * Comma-separated list of host patterns allowed as MCP client redirect URIs.
   * Patterns: exact host (`claude.ai`) or wildcard (`*.claude.ai`). Loopback
   * (`localhost` / 127.0.0.1 / [::1]) is always allowed regardless of value.
   * Required in production — without it, only loopback is accepted, so a
   * misconfigured deployment won't silently authorize phishing redirects.
   */
  OAUTH_ALLOWED_REDIRECT_HOSTS?: string;

  /** Logger verbosity: error | warn | info | debug */
  LOG_LEVEL?: string;

  /** "false" to disable PII redaction. Defaults to enabled. */
  REDACT_PII?: string;

  /**
   * Local-dev only escape hatch. Refuses to take effect outside `wrangler dev`
   * (validated against `WRANGLER_DEV` flag set in package.json scripts).
   */
  BYPASS_ACCESS?: string;
  WRANGLER_DEV?: string;
}

/**
 * Props carried by the OAuthProvider into each McpAgent session.
 * Populated by auth-handler after Access JWT verification + HS OAuth.
 */
export interface Props {
  email: string;
  name: string;
  [key: string]: unknown;
}

/** Per-user Help Scout OAuth record (stored in DO storage). */
export interface HelpScoutTokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis when the access token expires. */
  expiresAt: number;
}

/** DO storage key for the user's Help Scout tokens. */
export const HS_TOKENS_STORAGE_KEY = "hs:tokens";

/**
 * DO storage key for the user's personal Help Scout Docs API key.
 * Unlike the OAuth tokens above, this is a single static credential
 * (Profile → My API Keys) with no expiry/refresh — Docs API access is
 * per-user but not OAuth-based.
 */
export const HS_DOCS_KEY_STORAGE_KEY = "hs:docs-api-key";

/** Identity payload attached by Access JWT middleware. */
export interface AccessIdentity {
  email: string;
  name: string;
  /** Access subject claim — service tokens have `sub` like `<service-token-id>.<team>`. */
  sub: string;
  /** True for service-token auth (headless MCP clients), false for browser logins. */
  isServiceToken: boolean;
}
