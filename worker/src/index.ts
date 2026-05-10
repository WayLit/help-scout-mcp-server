/**
 * Help Scout MCP Server — Cloudflare Workers entry point.
 *
 * Architecture:
 *   - Cloudflare Access fronts the worker for identity (Google Workspace SSO,
 *     MFA, device posture, service tokens).
 *   - Per-user Help Scout OAuth (authorization-code) tokens are stored in the
 *     user's Durable Object (`HelpScoutMCP`), keyed by email.
 *   - The OAuthProvider is a thin shell that lets MCP clients speak OAuth to
 *     us; the real identity comes from the Access JWT verified inside
 *     /authorize.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthHandler } from "./auth-handler";
import { instrumentServerForAudit } from "./audit";
import { HelpScoutAPI } from "./helpscout-api";
import { logger } from "./logger";
import { registerPrompts } from "./prompts";
import { configureRedaction } from "./redaction";
import { registerResources } from "./resources";
import { registerTools } from "./tools";
import type { Env, HelpScoutTokenRecord, Props } from "./types";
import { HS_TOKENS_STORAGE_KEY } from "./types";

const HELPSCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

/**
 * Build the MCP `instructions` string injected into the initialize handshake.
 * Mirrors stdio's discoverAndBuildInstructions but per-user (the worker is
 * one DO instance per email, so each user gets their own scoped list).
 */
function buildInstructions(inboxes: Array<{ id: number; name: string }>): string {
  const inboxList =
    inboxes.length > 0
      ? inboxes.map((i) => `  - "${i.name}" (ID: ${i.id})`).join("\n")
      : "  (No inboxes discovered yet — call searchInboxes once tokens are available)";

  return `Help Scout MCP Server - Search and retrieve Help Scout inbox, conversation, customer, and organization data.

## Available Inboxes (${inboxes.length} total)
${inboxList}

## Tool Selection Guide
| Task | Tool |
|------|------|
| Find tickets by keyword (billing, refund, bug) | comprehensiveConversationSearch |
| List recent/filtered tickets | searchConversations |
| Complex filters (email domain, multiple tags) | advancedConversationSearch |
| Lookup by ticket number (#12345) | structuredConversationFilter |
| Browse customers by name or query | listCustomers |
| Find a customer by email | searchCustomersByEmail |
| Get a full customer profile | getCustomer |
| Get customer contact channels | getCustomerContacts |
| Browse organizations | listOrganizations |
| Get an organization profile | getOrganization |
| See everyone in an organization | getOrganizationMembers |
| See all conversations for an organization | getOrganizationConversations |
| Get full conversation thread | getThreads |
| Quick conversation preview | getConversationSummary |

## Workflow Patterns
- **Ticket investigation**: searchConversations → getConversationSummary → getThreads
- **Keyword research**: comprehensiveConversationSearch → getThreads for details
- **Customer history**: searchCustomersByEmail → getCustomer → structuredConversationFilter/getThreads
- **Account review**: listOrganizations/getOrganization → getOrganizationMembers → getOrganizationConversations

## Notes
- Always use inbox IDs from the list above (not names)
- All search tools default to active+pending+closed statuses
- Use getServerTime for date-relative queries
- PII redaction is enabled by default (set REDACT_PII=false to disable)`;
}

export class HelpScoutMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "helpscout-mcp",
    version: "2.0.0",
  });

  /**
   * In-flight Help Scout refresh promise. Lives on the *user* DO instance
   * (named by email), so concurrent MCP session DOs RPC'ing in for a fresh
   * access token coalesce onto a single refresh — Help Scout refresh tokens
   * are single-use, so a parallel refresh would otherwise burn one with
   * `invalid_grant`.
   */
  private refreshPromise: Promise<HelpScoutTokenRecord> | null = null;

  async init(): Promise<void> {
    logger.setLevel(this.env.LOG_LEVEL);
    configureRedaction(this.env);
    const email = this.props?.email;
    if (!email) {
      throw new Error("HelpScoutMCP initialized without user props");
    }
    const api = new HelpScoutAPI(this.env, this.ctx.storage, email);
    // Audit must be instrumented BEFORE tool registrations so the patched
    // server.tool() captures every handler.
    instrumentServerForAudit(this.server, this.env, email);
    registerTools(this.server, api);
    registerPrompts(this.server);
    registerResources(this.server, api);

    // Warm the inbox cache and inject discovered inboxes into MCP `instructions`.
    // First tool call returns from cache (24h TTL) instead of round-tripping.
    if (await api.hasValidTokens()) {
      try {
        const response = await api.get<{
          _embedded?: { mailboxes?: Array<{ id: number; name: string }> };
        }>("/mailboxes", { page: 1, size: 100 });
        const inboxes = response._embedded?.mailboxes ?? [];
        this.setInstructions(buildInstructions(inboxes));
        logger.info("McpAgent initialized with inbox discovery", {
          email,
          inboxCount: inboxes.length,
        });
      } catch (err) {
        // Don't block init on a transient HS outage; ship the static instructions.
        this.setInstructions(buildInstructions([]));
        logger.warn("inbox discovery failed, using fallback instructions", {
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.setInstructions(buildInstructions([]));
      logger.info("McpAgent initialized without HS tokens", { email });
    }
  }

  /**
   * Set the MCP server instructions string by mutating the underlying low-level
   * Server. McpServer constructs Server eagerly with options at field init —
   * this writes through to the same private `_instructions` slot so it ships
   * with the next initialize handshake.
   */
  private setInstructions(text: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.server.server as any)._instructions = text;
  }

  /**
   * Internal-only fetch handler. AuthHandler RPCs into the user's DO to
   * write/read tokens — these requests come from the worker itself, never
   * from the public internet (Access fronts everything else).
   *
   * Routes:
   *   POST /store-tokens     — body: HelpScoutTokenRecord
   *   GET  /has-valid-tokens — returns { valid: boolean }
   *   POST /clear-tokens     — wipe (used on REAUTH_REQUIRED)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal") {
      return this.handleInternal(request, url);
    }
    // Anything else falls through to the McpAgent base (handles /mcp).
    return super.fetch(request);
  }

  private async handleInternal(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/store-tokens" && request.method === "POST") {
      const record = (await request.json()) as HelpScoutTokenRecord;
      if (!record?.accessToken || !record?.refreshToken || !record?.expiresAt) {
        return new Response("Invalid token record", { status: 400 });
      }
      await this.ctx.storage.put(HS_TOKENS_STORAGE_KEY, record);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/has-valid-tokens" && request.method === "GET") {
      const record = await this.ctx.storage.get<HelpScoutTokenRecord>(HS_TOKENS_STORAGE_KEY);
      const valid = Boolean(record && record.expiresAt - Date.now() >= 60_000);
      return Response.json({ valid });
    }

    if (url.pathname === "/clear-tokens" && request.method === "POST") {
      await this.ctx.storage.delete(HS_TOKENS_STORAGE_KEY);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/get-access-token" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { forceRefresh?: boolean };
      return this.handleGetAccessToken(Boolean(body?.forceRefresh));
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Return a usable access token, refreshing if expired (or forced). Single-flight
   * via `this.refreshPromise` — concurrent callers across MCP session DOs land in
   * the same user DO instance and share one in-flight refresh, so a single-use
   * Help Scout refresh token isn't burned twice.
   *
   * Wire response codes:
   *   200 { accessToken, expiresAt } — caller can use the token.
   *   401 { code: "REAUTH_REQUIRED" } — caller must surface re-auth to the user.
   *   502 { code: "UPSTREAM_ERROR", message } — transient HS failure; caller may retry.
   */
  private async handleGetAccessToken(forceRefresh: boolean): Promise<Response> {
    const record = await this.ctx.storage.get<HelpScoutTokenRecord>(HS_TOKENS_STORAGE_KEY);
    if (!record) {
      return Response.json({ code: "REAUTH_REQUIRED" }, { status: 401 });
    }

    const validForAtLeast60s = record.expiresAt - Date.now() >= 60_000;
    if (!forceRefresh && validForAtLeast60s) {
      return Response.json({ accessToken: record.accessToken, expiresAt: record.expiresAt });
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshHelpScoutToken(record.refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    try {
      const refreshed = await this.refreshPromise;
      return Response.json({ accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
    } catch (err) {
      if (err instanceof Error && err.message === "REAUTH_REQUIRED") {
        return Response.json({ code: "REAUTH_REQUIRED" }, { status: 401 });
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("get-access-token: refresh failed", { error: message });
      return Response.json({ code: "UPSTREAM_ERROR", message }, { status: 502 });
    }
  }

  /**
   * Exchange the stored refresh token for a fresh `{accessToken, refreshToken}`
   * pair and persist it. On `invalid_grant` (revoked/expired refresh), wipe the
   * stored record and signal `REAUTH_REQUIRED` so the caller can drive consent.
   */
  private async refreshHelpScoutToken(refreshToken: string): Promise<HelpScoutTokenRecord> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.env.HELPSCOUT_APP_ID,
      client_secret: this.env.HELPSCOUT_APP_SECRET,
      grant_type: "refresh_token",
    });
    const res = await fetch(HELPSCOUT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if ((res.status === 400 || res.status === 401) && /invalid[_-]?grant/i.test(text)) {
        await this.ctx.storage.delete(HS_TOKENS_STORAGE_KEY);
        throw new Error("REAUTH_REQUIRED");
      }
      throw new Error(`Help Scout token refresh failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const record: HelpScoutTokenRecord = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    await this.ctx.storage.put(HS_TOKENS_STORAGE_KEY, record);
    return record;
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  // McpAgent.serve() returns a fetch handler suitable for apiHandler.
  // Cast is needed because the OAuthProvider generic signature expects
  // an ExportedHandler-like type but accepts Worker entrypoints.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: HelpScoutMCP.serve("/mcp") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
