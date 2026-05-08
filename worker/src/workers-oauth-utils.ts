/**
 * OAuth security utilities for Workers.
 *
 * Provides CSRF protection, OAuth state management (signed cookies + KV),
 * session binding, approved-client tracking, and a consent approval dialog.
 *
 * Adapted from Cloudflare's remote-mcp-github-oauth demo:
 * https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth
 */
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

// ── Cookie names ────────────────────────────────────────────────────────────

const APPROVED_CLIENTS_COOKIE = "mcp_approved_clients";
const CSRF_COOKIE = "mcp_csrf";
const SESSION_COOKIE = "mcp_session";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const TEN_MINUTES_SECONDS = 600;

// ── Crypto helpers (HMAC-SHA256) ────────────────────────────────────────────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signData(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bufferToHex(sig);
}

async function verifyData(secret: string, data: string, signature: string): Promise<boolean> {
  try {
    const expected = await signData(secret, data);
    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Cookie parsing / formatting ─────────────────────────────────────────────

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

// ── Approved clients (long-lived, signed cookie) ────────────────────────────

export async function isClientApproved(request: Request, clientId: string, secret: string): Promise<boolean> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const raw = cookies[APPROVED_CLIENTS_COOKIE];
  if (!raw) return false;
  const dot = raw.indexOf(".");
  if (dot === -1) return false;
  const sig = raw.slice(0, dot);
  const payload = raw.slice(dot + 1);
  if (!(await verifyData(secret, payload, sig))) return false;
  try {
    const list = JSON.parse(atob(payload)) as string[];
    return list.includes(clientId);
  } catch {
    return false;
  }
}

export async function addApprovedClient(
  request: Request,
  clientId: string,
  secret: string,
): Promise<string> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const raw = cookies[APPROVED_CLIENTS_COOKIE];
  let list: string[] = [];
  if (raw) {
    const dot = raw.indexOf(".");
    if (dot !== -1) {
      const sig = raw.slice(0, dot);
      const payload = raw.slice(dot + 1);
      if (await verifyData(secret, payload, sig)) {
        try {
          list = JSON.parse(atob(payload));
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!list.includes(clientId)) list.push(clientId);
  const payload = btoa(JSON.stringify(list));
  const sig = await signData(secret, payload);
  return serializeCookie(APPROVED_CLIENTS_COOKIE, `${sig}.${payload}`, {
    maxAge: ONE_YEAR_SECONDS,
    httpOnly: true,
  });
}

// ── CSRF tokens ─────────────────────────────────────────────────────────────

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = randomToken(16);
  const setCookie = serializeCookie(CSRF_COOKIE, token, {
    maxAge: TEN_MINUTES_SECONDS,
    httpOnly: true,
  });
  return { token, setCookie };
}

export async function validateCSRFToken(request: Request, token: string, _secret: string): Promise<boolean> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const cookieToken = cookies[CSRF_COOKIE];
  if (!cookieToken || !token) return false;
  if (cookieToken.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < cookieToken.length; i++) {
    diff |= cookieToken.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

// ── OAuth state (KV-backed, opaque) ─────────────────────────────────────────

export interface StoredOAuthState {
  oauthReqInfo: AuthRequest;
  // Added after Google login, used by Help Scout redirect
  googleUser?: { email: string; name: string };
}

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  extra?: Partial<StoredOAuthState>,
): Promise<{ stateToken: string }> {
  const stateToken = randomToken(32);
  const value: StoredOAuthState = { oauthReqInfo, ...extra };
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(value), {
    expirationTtl: TEN_MINUTES_SECONDS,
  });
  return { stateToken };
}

export async function readOAuthState(
  stateToken: string,
  kv: KVNamespace,
): Promise<StoredOAuthState | null> {
  if (!stateToken) return null;
  const raw = await kv.get(`oauth:state:${stateToken}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredOAuthState;
  } catch {
    return null;
  }
}

export async function updateOAuthState(
  stateToken: string,
  kv: KVNamespace,
  patch: Partial<StoredOAuthState>,
): Promise<StoredOAuthState | null> {
  const existing = await readOAuthState(stateToken, kv);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(merged), {
    expirationTtl: TEN_MINUTES_SECONDS,
  });
  return merged;
}

export async function deleteOAuthState(stateToken: string, kv: KVNamespace): Promise<void> {
  await kv.delete(`oauth:state:${stateToken}`);
}

// ── Session binding (prevents state reuse across sessions) ──────────────────

export function bindStateToSession(stateToken: string): { setCookie: string } {
  return {
    setCookie: serializeCookie(SESSION_COOKIE, stateToken, {
      maxAge: TEN_MINUTES_SECONDS,
      httpOnly: true,
    }),
  };
}

export function validateSessionBinding(request: Request, stateToken: string): boolean {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const sessionToken = cookies[SESSION_COOKIE];
  if (!sessionToken || sessionToken !== stateToken) return false;
  return true;
}

// ── Approval dialog ─────────────────────────────────────────────────────────

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: { name: string; description: string };
  state: { oauthReqInfo: AuthRequest };
  csrfToken: string;
  setCookie: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderApprovalDialog(_request: Request, opts: ApprovalDialogOptions): Response {
  const { client, server, state, csrfToken, setCookie } = opts;
  const clientName = escapeHtml(client?.clientName ?? "Unknown Client");
  const encodedState = btoa(JSON.stringify(state));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize ${escapeHtml(server.name)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 3rem auto; padding: 1.5rem; line-height: 1.5; }
    h1 { font-size: 1.35rem; margin-top: 0; }
    .card { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 1.25rem; }
    .muted { color: rgba(128,128,128,.9); font-size: .9rem; }
    button { background: #2563eb; color: white; border: 0; padding: .65rem 1.1rem; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button.secondary { background: transparent; color: inherit; border: 1px solid rgba(128,128,128,.5); margin-right: .5rem; }
    form { margin-top: 1.25rem; }
    code { background: rgba(128,128,128,.15); padding: .1rem .3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize access to ${escapeHtml(server.name)}</h1>
    <p><strong>${clientName}</strong> is requesting permission to access Help Scout data on your behalf.</p>
    <p class="muted">${escapeHtml(server.description)}</p>
    <p class="muted">You will first sign in with your Google account, then authorize Help Scout.</p>
    <form method="post" action="/authorize">
      <input type="hidden" name="state" value="${encodedState}">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <button type="submit">Approve &amp; Continue</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
    },
  });
}
