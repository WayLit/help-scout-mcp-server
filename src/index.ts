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
import { registerDocsTools } from "./docs-tools";
import { HelpScoutAPI } from "./helpscout-api";
import { HelpScoutDocsAPI } from "./helpscout-docs-api";
import { buildInstructions } from "./instructions";
import { logger } from "./logger";
import { registerPrompts } from "./prompts";
import { configureRedaction } from "./redaction";
import { registerResources } from "./resources";
import { registerTools } from "./tools";
import type { Env, HelpScoutTokenRecord, Props } from "./types";
import { HS_DOCS_KEY_STORAGE_KEY, HS_TOKENS_STORAGE_KEY } from "./types";

const HELPSCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

/**
 * Trusted header carrying the OAuth-verified caller email from the serve()
 * boundary into the session Durable Object. Stamped by `mcpApiHandler` (which
 * overwrites any client-supplied copy) and checked in `HelpScoutMCP.fetch` to
 * reject cross-identity reuse of a leaked/replayed `mcp-session-id`.
 */
const VERIFIED_EMAIL_HEADER = "x-hs-verified-email";

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
   *   POST /store-docs-key   — body: { apiKey: string }
   *   GET  /has-docs-key     — returns { valid: boolean }
   *   POST /clear-docs-key   — wipe (used on REAUTH_REQUIRED / rotation)
   *   POST /get-docs-key     — returns { apiKey } or 401 { code: "REAUTH_REQUIRED" }
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal") {
      return this.handleInternal(request, url);
    }

    // Cross-identity guard. McpAgent binds this session DO to the first
    // caller's identity in init() (email -> HelpScoutAPI -> user-DO token
    // lookup) and does NOT re-run init() per request — `this.props` reflects
    // the identity the DO was *activated* with, not the current request. The
    // session DO is named by the client-supplied `mcp-session-id`, so a leaked
    // or replayed session id could otherwise let a different (also Access-
    // authenticated) user drive tool calls against the original user's Help
    // Scout tokens and cached PII while the DO is still warm. mcpApiHandler
    // stamps the OAuth-verified caller email into VERIFIED_EMAIL_HEADER; refuse
    // the request if it does not match the identity this DO was bound to.
    const verifiedEmail = request.headers.get(VERIFIED_EMAIL_HEADER);
    const boundEmail = this.props?.email;
    if (verifiedEmail && boundEmail && verifiedEmail !== boundEmail) {
      logger.warn("mcp session identity mismatch — refusing cross-identity reuse", {
        boundEmail,
        verifiedEmail,
      });
      return new Response("Session does not belong to the authenticated identity", {
        status: 403,
      });
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

    if (url.pathname === "/store-docs-key" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { apiKey?: string };
      if (!body?.apiKey) {
        return new Response("Invalid docs API key", { status: 400 });
      }
      await this.ctx.storage.put(HS_DOCS_KEY_STORAGE_KEY, body.apiKey);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/has-docs-key" && request.method === "GET") {
      const apiKey = await this.ctx.storage.get<string>(HS_DOCS_KEY_STORAGE_KEY);
      return Response.json({ valid: Boolean(apiKey) });
    }

    if (url.pathname === "/clear-docs-key" && request.method === "POST") {
      await this.ctx.storage.delete(HS_DOCS_KEY_STORAGE_KEY);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/get-docs-key" && request.method === "POST") {
      const apiKey = await this.ctx.storage.get<string>(HS_DOCS_KEY_STORAGE_KEY);
      if (!apiKey) {
        return Response.json({ code: "REAUTH_REQUIRED" }, { status: 401 });
      }
      return Response.json({ apiKey });
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

/**
 * Docs MCP — separate connector at /docs/mcp for Help Scout Docs (knowledge
 * base) access. Distinct from HelpScoutMCP because it authenticates
 * differently: no per-user Help Scout OAuth, just a personal Docs API key
 * collected via the /docs-api-key/enter form (see auth-handler.ts) and
 * stored in the *mailbox* user DO (MCP_OBJECT, keyed by email) alongside HS
 * OAuth tokens — DOCS_MCP_OBJECT below is only for this class's own McpAgent
 * session instances, not for secret storage.
 */
export class HelpScoutDocsMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "helpscout-docs-mcp",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    logger.setLevel(this.env.LOG_LEVEL);
    const email = this.props?.email;
    if (!email) {
      throw new Error("HelpScoutDocsMCP initialized without user props");
    }
    const api = new HelpScoutDocsAPI(this.env, this.ctx.storage, email);
    instrumentServerForAudit(this.server, this.env, email);
    registerDocsTools(this.server, api);

    const connected = await api.hasApiKey();
    this.setInstructions(
      connected
        ? "Help Scout Docs MCP: read and write access to your Docs knowledge base " +
            "(collections and articles). Use searchArticles to find stale content by " +
            "keyword, getArticle to read the full body, and updateArticle to fix it. " +
            "createArticle defaults to status=notpublished so drafts can be reviewed " +
            "before publishing."
        : "No Help Scout Docs API key on file yet — visit /docs-api-key/enter to connect one " +
            "before calling any tool here.",
    );
    logger.info("HelpScoutDocsMCP initialized", { email, connected });
  }

  private setInstructions(text: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.server.server as any)._instructions = text;
  }

  /** Same cross-identity replay guard as HelpScoutMCP.fetch — see there for the full rationale. */
  async fetch(request: Request): Promise<Response> {
    const verifiedEmail = request.headers.get(VERIFIED_EMAIL_HEADER);
    const boundEmail = this.props?.email;
    if (verifiedEmail && boundEmail && verifiedEmail !== boundEmail) {
      logger.warn("docs mcp session identity mismatch — refusing cross-identity reuse", {
        boundEmail,
        verifiedEmail,
      });
      return new Response("Session does not belong to the authenticated identity", {
        status: 403,
      });
    }
    return super.fetch(request);
  }
}

const mailboxServeHandler = HelpScoutMCP.serve("/mcp");
const docsServeHandler = HelpScoutDocsMCP.serve("/docs/mcp");

/**
 * Wraps McpAgent.serve() to stamp the OAuth-verified caller identity into a
 * trusted request header before the SDK routes to the session DO. The
 * OAuthProvider has already verified the bearer token and exposes the decrypted
 * identity on `ctx.props`; we forward `ctx.props.email` (overwriting any
 * client-supplied copy of the header) so `<Agent>.fetch` can reject a
 * session id presented under a different identity than the one it was bound to.
 */
function withVerifiedEmailHeader(serveHandler: {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
}) {
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext & { props?: Props },
    ): Promise<Response> {
      const headers = new Headers(request.headers);
      headers.delete(VERIFIED_EMAIL_HEADER);
      const email = ctx.props?.email;
      if (email) {
        headers.set(VERIFIED_EMAIL_HEADER, email);
      }
      return serveHandler.fetch(new Request(request, { headers }), env, ctx);
    },
  };
}

export default new OAuthProvider({
  apiHandlers: {
    // McpAgent.serve() returns a fetch handler suitable for apiHandlers.
    // Cast is needed because the OAuthProvider generic signature expects
    // an ExportedHandler-like type but accepts Worker entrypoints.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "/mcp": withVerifiedEmailHeader(mailboxServeHandler) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "/docs/mcp": withVerifiedEmailHeader(docsServeHandler) as any,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
