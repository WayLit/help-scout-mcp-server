/**
 * Auth handler — Cloudflare Access for identity, Help Scout authorization-code
 * for per-user API access.
 *
 * Flow:
 *   GET  /authorize          → Access-fronted; verifies JWT, then either
 *                              completes auth (if user has valid HS tokens) or
 *                              redirects to Help Scout consent.
 *   GET  /callback/helpscout → exchanges HS code, writes tokens into the user's
 *                              Durable Object, then completes auth.
 *
 * Cloudflare Access handles all of: identity (Google Workspace), MFA, device
 * posture, consent UI, CSRF, session management. The worker only sees
 * authenticated requests with a JWT in `Cf-Access-Jwt-Assertion`.
 */
import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { AccessAuthError, verifyAccessJwt } from "./access-jwt";
import { logger, newRequestId } from "./logger";
import type { Env, HelpScoutTokenRecord, Props } from "./types";
import {
  createOAuthState,
  deleteOAuthState,
  readOAuthState,
} from "./workers-oauth-utils";

const HELPSCOUT_AUTHORIZE_URL =
  "https://secure.helpscout.net/authentication/authorizeClientApplication";
const HELPSCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decide whether an MCP client's `redirect_uri` is allowed.
 *
 * Cloudflare Access proves *who* the user is, but with dynamic client
 * registration enabled the OAuthProvider would otherwise hand a code to any
 * `redirect_uri` an attacker registers. This is the gate that stops a
 * phished, Access-authenticated user from silently authorizing an
 * attacker-controlled MCP client.
 *
 * Always allows loopback (`localhost`, `127.0.0.1`, `[::1]`) so dev/desktop
 * clients work without configuration. For all other hosts, the deployer must
 * opt in via `OAUTH_ALLOWED_REDIRECT_HOSTS` — comma-separated `host` patterns
 * (`claude.ai`) or wildcard subdomains (`*.claude.ai`). Without an allowlist,
 * a misconfigured production deployment fails closed instead of silently
 * accepting any host.
 */
export function isAllowedRedirectUri(
  redirectUri: string | undefined,
  allowedHostsList: string | undefined,
): boolean {
  if (!redirectUri) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return true;
  }

  if (!allowedHostsList) return false;
  const patterns = allowedHostsList
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern === hostname) return true;
    if (pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

function redirectToHelpScout(env: Env, stateToken: string): Response {
  const params = new URLSearchParams({
    client_id: env.HELPSCOUT_APP_ID,
    state: stateToken,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `${HELPSCOUT_AUTHORIZE_URL}?${params.toString()}` },
  });
}

async function exchangeHelpScoutCode(env: Env, code: string): Promise<HelpScoutTokenRecord> {
  const body = new URLSearchParams({
    code,
    client_id: env.HELPSCOUT_APP_ID,
    client_secret: env.HELPSCOUT_APP_SECRET,
    grant_type: "authorization_code",
  });
  const res = await fetch(HELPSCOUT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Help Scout token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Send the freshly-minted HS tokens into the user's Durable Object.
 * Idempotent — overwrites whatever was stored.
 */
async function storeHelpScoutTokensInDO(
  env: Env,
  email: string,
  record: HelpScoutTokenRecord,
): Promise<void> {
  const id = env.MCP_OBJECT.idFromName(email);
  const stub = env.MCP_OBJECT.get(id);
  const res = await stub.fetch("https://internal/store-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    throw new Error(`Failed to store tokens in DO (${res.status}): ${await res.text()}`);
  }
}

/**
 * Ask the user's DO whether it has valid (non-expired) HS tokens.
 * Returns true if a tool call could succeed without re-consent.
 */
async function userHasValidTokens(env: Env, email: string): Promise<boolean> {
  const id = env.MCP_OBJECT.idFromName(email);
  const stub = env.MCP_OBJECT.get(id);
  const res = await stub.fetch("https://internal/has-valid-tokens");
  if (!res.ok) return false;
  const json = (await res.json()) as { valid: boolean };
  return json.valid;
}

async function completeAuth(
  env: Bindings,
  oauthReqInfo: AuthRequest,
  props: Props,
): Promise<Response> {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: props.email,
    scope: oauthReqInfo.scope,
    metadata: { label: props.name },
    props,
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo } });
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get("/healthz", (c) =>
  c.json({ ok: true, name: "helpscout-mcp", time: new Date().toISOString() }),
);

app.get("/authorize", async (c) => {
  logger.setLevel(c.env.LOG_LEVEL);
  const requestId = newRequestId();
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    logger.warn("authorize: missing clientId", { requestId });
    return c.text("Invalid authorization request", 400);
  }

  // Reject unknown redirect_uris before any state mutation. With dynamic client
  // registration enabled, this is the gate that stops a phished
  // Access-authenticated user from silently authorizing an attacker-controlled
  // client. Loopback is always allowed; remote hosts require an explicit
  // allowlist via OAUTH_ALLOWED_REDIRECT_HOSTS.
  if (!isAllowedRedirectUri(oauthReqInfo.redirectUri, c.env.OAUTH_ALLOWED_REDIRECT_HOSTS)) {
    logger.warn("authorize: redirect_uri rejected by allowlist", {
      requestId,
      clientId: oauthReqInfo.clientId,
      redirectUri: oauthReqInfo.redirectUri,
    });
    return c.text("redirect_uri not allowed", 400);
  }

  // Cloudflare Access has already authenticated the user — just verify the JWT.
  let identity;
  try {
    identity = await verifyAccessJwt(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof AccessAuthError) {
      logger.warn("authorize: access JWT rejected", { requestId, reason: err.message });
      return c.text(err.message, err.status);
    }
    throw err;
  }

  logger.info("authorize: identity verified", {
    requestId,
    email: identity.email,
    isServiceToken: identity.isServiceToken,
  });

  // If the user already has valid HS tokens, skip the HS consent leg.
  if (await userHasValidTokens(c.env, identity.email)) {
    logger.info("authorize: existing HS tokens, completing auth", { requestId, email: identity.email });
    return completeAuth(c.env, oauthReqInfo, {
      email: identity.email,
      name: identity.name,
    });
  }

  // Otherwise, kick off the HS authorization-code flow.
  const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV, {
    accessIdentity: { email: identity.email, name: identity.name },
  });
  logger.info("authorize: redirecting to Help Scout", { requestId, email: identity.email });
  return redirectToHelpScout(c.env, stateToken);
});

app.get("/callback/helpscout", async (c) => {
  logger.setLevel(c.env.LOG_LEVEL);
  const requestId = newRequestId();
  const code = c.req.query("code");
  const stateToken = c.req.query("state");
  if (!code || !stateToken) {
    logger.warn("hs callback: missing code or state", { requestId });
    return c.text("Missing code or state", 400);
  }

  const stored = await readOAuthState(stateToken, c.env.OAUTH_KV);
  if (!stored?.accessIdentity) {
    logger.warn("hs callback: state expired or not found", { requestId });
    return c.text("State expired or not found", 400);
  }

  // Re-verify the Access identity presenting the callback and bind it to the
  // identity that started the flow. The `state` token alone is not a sufficient
  // CSRF/auth-code-injection guard: if it leaks (referer, history, proxy logs,
  // shared device) within its TTL, a different Access-authenticated user could
  // complete the Help Scout leg with their own account and have the resulting
  // tokens written into the original user's DO (keyed by stored email). Asserting
  // the live JWT email matches stored.accessIdentity.email closes that window.
  let callbackIdentity;
  try {
    callbackIdentity = await verifyAccessJwt(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof AccessAuthError) {
      logger.warn("hs callback: access JWT rejected", { requestId, reason: err.message });
      return c.text(err.message, err.status);
    }
    throw err;
  }
  if (callbackIdentity.email !== stored.accessIdentity.email) {
    logger.warn("hs callback: identity mismatch — refusing cross-identity token store", {
      requestId,
      callbackEmail: callbackIdentity.email,
      stateEmail: stored.accessIdentity.email,
    });
    return c.text("Callback identity does not match the initiating user", 403);
  }

  let tokens;
  try {
    tokens = await exchangeHelpScoutCode(c.env, code);
  } catch (err) {
    logger.error("hs callback: token exchange failed", {
      requestId,
      email: stored.accessIdentity.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.text("Help Scout authentication failed", 502);
  }

  await storeHelpScoutTokensInDO(c.env, stored.accessIdentity.email, tokens);
  await deleteOAuthState(stateToken, c.env.OAUTH_KV);
  logger.info("hs callback: tokens stored, completing auth", {
    requestId,
    email: stored.accessIdentity.email,
  });

  return completeAuth(c.env, stored.oauthReqInfo, {
    email: stored.accessIdentity.email,
    name: stored.accessIdentity.name,
  });
});

export { app as AuthHandler };
