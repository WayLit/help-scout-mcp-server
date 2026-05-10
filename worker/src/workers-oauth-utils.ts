/**
 * OAuth state utilities (KV-backed, opaque tokens).
 *
 * Cloudflare Access handles identity, MFA, consent UI, CSRF, and session
 * binding for us — all that's left here is opaque state passed through the
 * Help Scout authorization-code flow so the callback can recover the original
 * MCP authorize request and the verified user identity.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const TEN_MINUTES_SECONDS = 600;

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface StoredOAuthState {
  oauthReqInfo: AuthRequest;
  /** Verified Access identity (email + display name) carried into HS callback. */
  accessIdentity?: { email: string; name: string };
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

export async function deleteOAuthState(stateToken: string, kv: KVNamespace): Promise<void> {
  await kv.delete(`oauth:state:${stateToken}`);
}
