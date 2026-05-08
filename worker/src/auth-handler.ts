/**
 * Auth handler — chained Google SSO + Help Scout OAuth.
 *
 * Flow:
 *   GET  /authorize          → approval dialog or direct redirect to Google
 *   POST /authorize          → validate CSRF, record consent, redirect to Google
 *   GET  /callback/google    → exchange code, check KV for Help Scout tokens,
 *                              either skip to completeAuthorization or redirect to Help Scout
 *   GET  /callback/helpscout → exchange code, store tokens in KV, completeAuthorization
 */
import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { Env, HelpScoutTokenRecord, Props } from "./types";
import { helpScoutTokensKey } from "./types";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  deleteOAuthState,
  generateCSRFProtection,
  isClientApproved,
  readOAuthState,
  renderApprovalDialog,
  updateOAuthState,
  validateCSRFToken,
  validateSessionBinding,
} from "./workers-oauth-utils";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const HELPSCOUT_AUTHORIZE_URL =
  "https://secure.helpscout.net/authentication/authorizeClientApplication";
const HELPSCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

const SERVER_INFO = {
  name: "Help Scout MCP",
  description:
    "Remote MCP server that lets AI assistants search and read your Help Scout conversations, customers, and organizations.",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function absoluteCallback(request: Request, path: string): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}${path}`;
}

function redirectToGoogle(
  request: Request,
  env: Env,
  stateToken: string,
  headers: Record<string, string> = {},
): Response {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: absoluteCallback(request, "/callback/google"),
    response_type: "code",
    scope: "openid email profile",
    state: stateToken,
    access_type: "online",
    prompt: "select_account",
  });
  if (env.GOOGLE_HOSTED_DOMAIN) {
    params.set("hd", env.GOOGLE_HOSTED_DOMAIN);
  }
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      Location: `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`,
    },
  });
}

function redirectToHelpScout(env: Env, stateToken: string, headers: Record<string, string> = {}): Response {
  const params = new URLSearchParams({
    client_id: env.HELPSCOUT_APP_ID,
    state: stateToken,
  });
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      Location: `${HELPSCOUT_AUTHORIZE_URL}?${params.toString()}`,
    },
  });
}

async function exchangeGoogleCode(
  request: Request,
  env: Env,
  code: string,
): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: absoluteCallback(request, "/callback/google"),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return { accessToken: json.access_token };
}

async function fetchGoogleUserInfo(accessToken: string): Promise<{ email: string; name: string }> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    email?: string;
    name?: string;
    email_verified?: boolean;
  };
  if (!json.email) throw new Error("Google userinfo missing email");
  if (json.email_verified === false) throw new Error("Google email not verified");
  return { email: json.email, name: json.name ?? json.email };
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
 * Try to refresh a Help Scout access token. Returns null on any failure
 * (revoked, expired, network error) so callers can fall through to a
 * full re-consent flow instead of locking the user out.
 */
async function tryRefreshHelpScoutTokens(
  env: Env,
  refreshToken: string,
): Promise<HelpScoutTokenRecord | null> {
  try {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.HELPSCOUT_APP_ID,
      client_secret: env.HELPSCOUT_APP_SECRET,
      grant_type: "refresh_token",
    });
    const res = await fetch(HELPSCOUT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
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
  } catch {
    return null;
  }
}

async function loadHelpScoutTokens(env: Env, email: string): Promise<HelpScoutTokenRecord | null> {
  const raw = await env.OAUTH_KV.get(helpScoutTokensKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HelpScoutTokenRecord;
  } catch {
    return null;
  }
}

async function storeHelpScoutTokens(
  env: Env,
  email: string,
  record: HelpScoutTokenRecord,
): Promise<void> {
  await env.OAUTH_KV.put(helpScoutTokensKey(email), JSON.stringify(record));
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
  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo },
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) return c.text("Invalid authorization request", 400);

  // Skip consent dialog if the user already approved this client
  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie } = bindStateToSession(stateToken);
    return redirectToGoogle(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
  const { token: csrfToken, setCookie } = generateCSRFProtection();
  return renderApprovalDialog(c.req.raw, {
    client,
    server: SERVER_INFO,
    state: { oauthReqInfo },
    csrfToken,
    setCookie,
  });
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const csrfToken = String(form.get("csrf_token") ?? "");
  const encodedState = String(form.get("state") ?? "");

  if (!(await validateCSRFToken(c.req.raw, csrfToken, c.env.COOKIE_ENCRYPTION_KEY))) {
    return c.text("CSRF validation failed", 403);
  }

  let oauthReqInfo: AuthRequest;
  try {
    const parsed = JSON.parse(atob(encodedState)) as { oauthReqInfo: AuthRequest };
    oauthReqInfo = parsed.oauthReqInfo;
  } catch {
    return c.text("Invalid state payload", 400);
  }
  if (!oauthReqInfo?.clientId) return c.text("Invalid authorization request", 400);

  const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
  const approvedCookie = await addApprovedClient(
    c.req.raw,
    oauthReqInfo.clientId,
    c.env.COOKIE_ENCRYPTION_KEY,
  );
  const { setCookie: sessionCookie } = bindStateToSession(stateToken);

  // Two Set-Cookie headers need to go out together.
  const headers = new Headers();
  headers.append("Set-Cookie", approvedCookie);
  headers.append("Set-Cookie", sessionCookie);
  headers.set(
    "Location",
    `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: absoluteCallback(c.req.raw, "/callback/google"),
      response_type: "code",
      scope: "openid email profile",
      state: stateToken,
      access_type: "online",
      prompt: "select_account",
      ...(c.env.GOOGLE_HOSTED_DOMAIN ? { hd: c.env.GOOGLE_HOSTED_DOMAIN } : {}),
    }).toString()}`,
  );
  return new Response(null, { status: 302, headers });
});

app.get("/callback/google", async (c) => {
  const code = c.req.query("code");
  const stateToken = c.req.query("state");
  if (!code || !stateToken) return c.text("Missing code or state", 400);

  if (!validateSessionBinding(c.req.raw, stateToken)) {
    return c.text("Session binding validation failed", 403);
  }

  const stored = await readOAuthState(stateToken, c.env.OAUTH_KV);
  if (!stored) return c.text("State expired or not found", 400);

  // Exchange Google code for userinfo
  const { accessToken } = await exchangeGoogleCode(c.req.raw, c.env, code);
  const googleUser = await fetchGoogleUserInfo(accessToken);

  // Optional: enforce hosted domain at the server too (Google's hd is a hint only)
  if (c.env.GOOGLE_HOSTED_DOMAIN) {
    const expected = c.env.GOOGLE_HOSTED_DOMAIN.toLowerCase();
    if (!googleUser.email.toLowerCase().endsWith(`@${expected}`)) {
      return c.text(`Access restricted to @${expected} accounts`, 403);
    }
  }

  // If the user already has valid Help Scout tokens, skip the second leg.
  // Verify the refresh token still works first — Help Scout tokens can be
  // revoked or expired. If we trusted the KV record blindly and the token
  // was stale, the user would be locked out: every retry of /authorize
  // would short-circuit here, and every tool call would return UNAUTHORIZED.
  const existing = await loadHelpScoutTokens(c.env, googleUser.email);
  if (existing && existing.refreshToken) {
    const refreshed = await tryRefreshHelpScoutTokens(c.env, existing.refreshToken);
    if (refreshed) {
      await storeHelpScoutTokens(c.env, googleUser.email, refreshed);
      await deleteOAuthState(stateToken, c.env.OAUTH_KV);
      return completeAuth(c.env, stored.oauthReqInfo, {
        email: googleUser.email,
        name: googleUser.name,
      });
    }
    // Stale token — fall through to re-consent. We intentionally do NOT
    // delete the KV record here; storeHelpScoutTokens after the new
    // /callback/helpscout will overwrite it.
  }

  // Otherwise, store googleUser into state and redirect to Help Scout authorize
  await updateOAuthState(stateToken, c.env.OAUTH_KV, { googleUser });
  return redirectToHelpScout(c.env, stateToken);
});

app.get("/callback/helpscout", async (c) => {
  const code = c.req.query("code");
  const stateToken = c.req.query("state");
  if (!code || !stateToken) return c.text("Missing code or state", 400);

  // Prevent session fixation: the same browser that started the flow
  // (and received mcp_session in /authorize) must complete it.
  if (!validateSessionBinding(c.req.raw, stateToken)) {
    return c.text("Session binding validation failed", 403);
  }

  const stored = await readOAuthState(stateToken, c.env.OAUTH_KV);
  if (!stored?.googleUser) return c.text("State expired or not found", 400);

  const tokens = await exchangeHelpScoutCode(c.env, code);
  await storeHelpScoutTokens(c.env, stored.googleUser.email, tokens);
  await deleteOAuthState(stateToken, c.env.OAUTH_KV);

  return completeAuth(c.env, stored.oauthReqInfo, {
    email: stored.googleUser.email,
    name: stored.googleUser.name,
  });
});

export { app as AuthHandler };
