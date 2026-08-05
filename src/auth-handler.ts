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

import { HELPSCOUT_DOCS_API_BASE } from "./helpscout-docs-api";
import { AccessAuthError, verifyAccessJwt } from "./access-jwt";
import { recordToolCall } from "./audit";
import {
  MAX_MULTIPART_OVERHEAD_BYTES,
  MAX_UPLOAD_BYTES,
  consumeUploadToken,
  sanitizeUploadFileName,
  sniffImageMimeType,
  uploadArticleImage,
} from "./docs-assets";
import { isHelpScoutApiError } from "./helpscout-api";
import { logger, newRequestId } from "./logger";
import type { Env, HelpScoutTokenRecord, Props } from "./types";
import { createOAuthState, deleteOAuthState, readOAuthState } from "./workers-oauth-utils";

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

/**
 * True if this authorize/token request targets the Docs MCP rather than the
 * mailbox MCP. MCP clients send `resource` (RFC 8707) set to the canonical
 * URL of the server they're connecting to, e.g. `https://host/docs/mcp` —
 * that's the only signal available at `/authorize` time to tell the two
 * connectors apart, since both share one OAuthProvider instance.
 */
export function isDocsResource(resource: string | string[] | undefined): boolean {
  const values = Array.isArray(resource) ? resource : resource ? [resource] : [];
  return values.some((r) => {
    try {
      return new URL(r).pathname.replace(/\/+$/, "") === "/docs/mcp";
    } catch {
      return false;
    }
  });
}

/** Ask the user's DO whether it has a stored Help Scout Docs API key. */
async function userHasDocsApiKey(env: Env, email: string): Promise<boolean> {
  const id = env.MCP_OBJECT.idFromName(email);
  const stub = env.MCP_OBJECT.get(id);
  const res = await stub.fetch("https://internal/has-docs-key");
  if (!res.ok) return false;
  const json = (await res.json()) as { valid: boolean };
  return json.valid;
}

/**
 * Confirm a Docs API key actually works before storing it — catches typos
 * and expired/revoked keys immediately instead of surfacing a confusing
 * failure on the first real tool call.
 */
async function validateDocsApiKey(apiKey: string): Promise<boolean> {
  const res = await fetch(`${HELPSCOUT_DOCS_API_BASE}/collections?page=1`, {
    headers: { Authorization: `Basic ${btoa(`${apiKey}:X`)}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}

async function storeDocsApiKeyInDO(env: Env, email: string, apiKey: string): Promise<void> {
  const id = env.MCP_OBJECT.idFromName(email);
  const stub = env.MCP_OBJECT.get(id);
  const res = await stub.fetch("https://internal/store-docs-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    throw new Error(`Failed to store Docs API key in DO (${res.status}): ${await res.text()}`);
  }
}

/** Escape for safe interpolation into HTML text/attribute contexts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function docsApiKeyFormPage(opts: { state?: string; error?: string }): string {
  const errorHtml = opts.error
    ? `<p style="color:#b00020;font:14px system-ui">${escapeHtml(opts.error)}</p>`
    : "";
  const stateInput = opts.state
    ? `<input type="hidden" name="state" value="${escapeHtml(opts.state)}" />`
    : "";
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Connect Help Scout Docs</title></head>
<body style="font:16px system-ui;max-width:480px;margin:64px auto;padding:0 16px">
  <h1 style="font-size:20px">Connect your Help Scout Docs API key</h1>
  <p>Find this under your Help Scout profile → <strong>My API Keys</strong>. This key is personal to your account and is stored only for your MCP connection.</p>
  ${errorHtml}
  <form method="POST" action="/docs-api-key/submit">
    ${stateInput}
    <input type="password" name="apiKey" placeholder="Docs API key" required
      style="width:100%;padding:8px;font-size:14px;box-sizing:border-box" />
    <button type="submit" style="margin-top:12px;padding:8px 16px">Save</button>
  </form>
</body>
</html>`;
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

  // Docs MCP: no per-user OAuth with Help Scout — just a personal Docs API
  // key. Skip straight to completion if we already have one on file,
  // otherwise collect it via a short HTML form instead of the HS consent
  // redirect used by the mailbox connector below.
  if (isDocsResource(oauthReqInfo.resource)) {
    if (await userHasDocsApiKey(c.env, identity.email)) {
      logger.info("authorize: existing docs API key, completing auth", {
        requestId,
        email: identity.email,
      });
      return completeAuth(c.env, oauthReqInfo, {
        email: identity.email,
        name: identity.name,
      });
    }
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV, {
      accessIdentity: { email: identity.email, name: identity.name },
    });
    logger.info("authorize: prompting for docs API key", { requestId, email: identity.email });
    return c.html(docsApiKeyFormPage({ state: stateToken }));
  }

  // If the user already has valid HS tokens, skip the HS consent leg.
  if (await userHasValidTokens(c.env, identity.email)) {
    logger.info("authorize: existing HS tokens, completing auth", {
      requestId,
      email: identity.email,
    });
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

/**
 * Standalone key-rotation entry point — no OAuth state, just Access-gated.
 * Lets a user whose Docs API key was revoked/rotated update it without
 * re-running a client's full OAuth handshake.
 */
app.get("/docs-api-key/enter", async (c) => {
  logger.setLevel(c.env.LOG_LEVEL);
  try {
    await verifyAccessJwt(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof AccessAuthError) return c.text(err.message, err.status);
    throw err;
  }
  return c.html(docsApiKeyFormPage({}));
});

app.post("/docs-api-key/submit", async (c) => {
  logger.setLevel(c.env.LOG_LEVEL);
  const requestId = newRequestId();

  let identity;
  try {
    identity = await verifyAccessJwt(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof AccessAuthError) return c.text(err.message, err.status);
    throw err;
  }

  const body = await c.req.parseBody();
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const stateToken = typeof body.state === "string" ? body.state : undefined;

  if (!apiKey) {
    return c.html(docsApiKeyFormPage({ state: stateToken, error: "API key is required." }), 400);
  }

  if (!(await validateDocsApiKey(apiKey))) {
    logger.warn("docs-api-key/submit: validation failed", { requestId, email: identity.email });
    return c.html(
      docsApiKeyFormPage({
        state: stateToken,
        error: "Help Scout rejected that key. Double-check it and try again.",
      }),
      400,
    );
  }

  await storeDocsApiKeyInDO(c.env, identity.email, apiKey);
  logger.info("docs-api-key/submit: key stored", { requestId, email: identity.email });

  if (!stateToken) {
    return c.html(
      `<!doctype html><html><body style="font:16px system-ui;max-width:480px;margin:64px auto;padding:0 16px">
        <p>Docs API key saved. You can close this tab.</p>
      </body></html>`,
    );
  }

  const stored = await readOAuthState(stateToken, c.env.OAUTH_KV);
  if (!stored?.accessIdentity) {
    return c.text("State expired or not found", 400);
  }
  // Same cross-identity guard as the HS OAuth callback: the state token
  // alone isn't sufficient if it leaked to a different Access-authenticated
  // user within its TTL.
  if (stored.accessIdentity.email !== identity.email) {
    logger.warn("docs-api-key/submit: identity mismatch — refusing cross-identity completion", {
      requestId,
      submittedEmail: identity.email,
      stateEmail: stored.accessIdentity.email,
    });
    return c.text("Submitting identity does not match the initiating user", 403);
  }

  await deleteOAuthState(stateToken, c.env.OAUTH_KV);
  return completeAuth(c.env, stored.oauthReqInfo, {
    email: identity.email,
    name: identity.name,
  });
});

/**
 * Upload an inline image into a Docs article.
 *
 * Deliberately outside Cloudflare Access and outside the OAuth-protected MCP
 * handlers: the single-use token minted by the `createArticleImageUpload` tool
 * is the only credential, so a headless local uploader needs nothing
 * configured. The token carries the identity and the target article, both bound
 * server-side at mint time — see docs-assets.ts.
 */
app.post("/docs/assets/upload", async (c) => {
  logger.setLevel(c.env.LOG_LEVEL);
  const requestId = newRequestId();
  const started = Date.now();

  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const record = token ? await consumeUploadToken(c.env, token) : null;
  if (!record) {
    logger.warn("docs upload: token rejected", { requestId });
    return c.json(
      {
        error: "INVALID_UPLOAD_TOKEN",
        message: "Upload token is unknown, already used, or expired. Mint a new one.",
        requestId,
      },
      401,
    );
  }

  // Advisory only: catches a truthfully-declared oversized Content-Length
  // before buffering the body. An absent or understated header falls
  // through to formData() below, which buffers the whole body regardless —
  // the file.size check further down is what actually enforces the limit.
  // The allowance matters: Content-Length covers the whole multipart body,
  // so a legal file at the limit declares more than MAX_UPLOAD_BYTES and
  // must not be rejected here.
  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    logger.warn("docs upload: declared Content-Length too large", {
      requestId,
      email: record.email,
      articleId: record.articleId,
      declaredLength,
    });
    return c.json(
      {
        error: "FILE_TOO_LARGE",
        message: `Image exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`,
        requestId,
      },
      413,
    );
  }

  let file: File;
  try {
    const form = await c.req.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File)) {
      logger.warn("docs upload: missing file field", {
        requestId,
        email: record.email,
        articleId: record.articleId,
      });
      return c.json(
        { error: "MISSING_FILE", message: "Expected a `file` field holding the image.", requestId },
        400,
      );
    }
    file = candidate;
  } catch {
    logger.warn("docs upload: unparseable body", {
      requestId,
      email: record.email,
      articleId: record.articleId,
    });
    return c.json(
      {
        error: "INVALID_INPUT",
        message: "Body must be multipart/form-data with a `file` field.",
        requestId,
      },
      400,
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    logger.warn("docs upload: file too large", {
      requestId,
      email: record.email,
      articleId: record.articleId,
      bytes: file.size,
    });
    return c.json(
      {
        error: "FILE_TOO_LARGE",
        message: `Image exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`,
        requestId,
      },
      413,
    );
  }

  // Trust the bytes, not the declared Content-Type. SVG is rejected: Help
  // Scout serves assets from its own domain, so a scripted SVG is stored XSS.
  // Read the bytes once, sniff them, then forward a rebuilt File that carries
  // the sniffed (trustworthy) type instead of the caller-declared one, so a
  // mislabeled-but-honest upload doesn't propagate its wrong declared type
  // upstream either. The name gets the same treatment: sanitizeUploadFileName
  // strips path components and forces the extension to match the sniffed
  // type, so an attacker-chosen name can't smuggle a mismatched extension
  // through onto the stored asset.
  const bytes = await file.arrayBuffer();
  const sniffed = sniffImageMimeType(new Uint8Array(bytes));
  if (!sniffed) {
    logger.warn("docs upload: unsupported image type", {
      requestId,
      email: record.email,
      declaredType: file.type,
    });
    await recordToolCall(c.env, {
      email: record.email,
      tool: "uploadArticleImage",
      args: { articleId: record.articleId, fileName: record.fileName, bytes: file.size },
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "UNSUPPORTED_IMAGE_TYPE",
    });
    return c.json(
      {
        error: "UNSUPPORTED_IMAGE_TYPE",
        message: "Image must be PNG, JPEG, GIF, or WebP.",
        requestId,
      },
      415,
    );
  }
  const safeName = sanitizeUploadFileName(record.fileName ?? file.name, sniffed);
  const safeFile = new File([bytes], safeName, { type: sniffed });

  try {
    const asset = await uploadArticleImage(c.env, record, safeFile);
    logger.info("docs upload: asset stored", {
      requestId,
      email: record.email,
      articleId: record.articleId,
    });
    await recordToolCall(c.env, {
      email: record.email,
      tool: "uploadArticleImage",
      args: { articleId: record.articleId, fileName: record.fileName, bytes: file.size },
      durationMs: Date.now() - started,
      status: "ok",
    });
    return c.json(asset, 201);
  } catch (err) {
    const code = isHelpScoutApiError(err) ? err.code : "UNEXPECTED_ERROR";
    const status = isHelpScoutApiError(err) && err.status ? err.status : 500;
    // Never relay upstream response bodies or raw internal error text to the
    // token holder. Help Scout's error bodies/WAF pages can echo request
    // details — and docs-assets.ts puts the Docs API key in the very form
    // body a 4xx/5xx from that endpoint is erroring on — while a leaked
    // token's holder is not necessarily the key's owner. The error code and
    // requestId already give the caller everything actionable; full detail
    // goes to the log line below instead of the response.
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("docs upload: failed", {
      requestId,
      email: record.email,
      articleId: record.articleId,
      errorCode: code,
      detail,
    });
    await recordToolCall(c.env, {
      email: record.email,
      tool: "uploadArticleImage",
      args: { articleId: record.articleId, fileName: record.fileName, bytes: file.size },
      durationMs: Date.now() - started,
      status: "error",
      errorCode: code,
    });
    return c.json(
      {
        error: code,
        message: isHelpScoutApiError(err) ? "Help Scout rejected the upload." : "Upload failed.",
        requestId,
      },
      status as 400,
    );
  }
});

export { app as AuthHandler };
