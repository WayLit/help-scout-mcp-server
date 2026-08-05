/**
 * Docs article image uploads.
 *
 * Image bytes can't travel through an MCP tool call — tool arguments are JSON,
 * so bytes would have to be base64 the model literally emits. Instead a local
 * plugin script uploads the file to `POST /docs/assets/upload` (see
 * auth-handler.ts) using a single-use token minted here, and this module
 * forwards the bytes to Help Scout with the API key from the user's DO.
 *
 * Deliberately standalone rather than a method on HelpScoutDocsAPI: that class
 * is constructed with a DurableObjectStorage for GET caching, and the upload
 * route runs in the worker where no DO storage exists. Uploads need no cache.
 */
import type { Env } from "./types";

export const UPLOAD_TOKEN_TTL_SECONDS = 900;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const UPLOAD_TOKEN_PREFIX = "upload:";

/**
 * What a minted upload token authorizes. `email` and `articleId` are bound
 * server-side at mint time, so a leaked token can't be retargeted at another
 * article or another user's Docs API key.
 */
export interface UploadTokenRecord {
  email: string;
  articleId: string;
  fileName?: string;
}

/** Hex-encoded random token — same shape as `randomToken` in workers-oauth-utils.ts. */
function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function mintUploadToken(
  env: Env,
  email: string,
  articleId: string,
  fileName?: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32);
  const record: UploadTokenRecord = { email, articleId };
  if (fileName) record.fileName = fileName;
  await env.OAUTH_KV.put(`${UPLOAD_TOKEN_PREFIX}${token}`, JSON.stringify(record), {
    expirationTtl: UPLOAD_TOKEN_TTL_SECONDS,
  });
  return {
    token,
    expiresAt: new Date(Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Read and burn an upload token. Deletion happens before the caller does any
 * work, so a replayed token can't trigger a second upload even if the first
 * one is still in flight.
 */
export async function consumeUploadToken(
  env: Env,
  token: string,
): Promise<UploadTokenRecord | null> {
  if (!token) return null;
  const key = `${UPLOAD_TOKEN_PREFIX}${token}`;
  const raw = await env.OAUTH_KV.get(key);
  if (!raw) return null;
  await env.OAUTH_KV.delete(key);
  try {
    return JSON.parse(raw) as UploadTokenRecord;
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * Identify an image by its magic bytes rather than the declared Content-Type,
 * which is caller-supplied and therefore untrusted.
 *
 * SVG is intentionally absent: Help Scout serves assets from its own domain,
 * so a script-carrying SVG would be stored XSS.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return null;
}
