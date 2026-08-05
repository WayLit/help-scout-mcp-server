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
import { HELPSCOUT_DOCS_API_BASE, fetchDocsApiKey } from "./helpscout-docs-api";
import { HelpScoutApiError } from "./helpscout-api";
import type { Env } from "./types";

export const UPLOAD_TOKEN_TTL_SECONDS = 900;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Slack allowed on top of MAX_UPLOAD_BYTES when screening a whole multipart
 * body — both the declared `Content-Length` and the metered stream in
 * `parseBoundedFormData`.
 *
 * A body measures more than its image: boundary lines, part headers, the
 * caller's file name, the closing boundary. Comparing that total to
 * MAX_UPLOAD_BYTES directly would 413 a legal file sitting within a few
 * hundred bytes of the limit and burn its single-use token. Real overhead is a
 * few hundred bytes; 8 KiB leaves room for a long name while still catching a
 * body that is wildly oversized.
 */
export const MAX_MULTIPART_OVERHEAD_BYTES = 8 * 1024;

/** Thrown by `parseBoundedFormData` when a body outgrows the cap mid-stream. */
export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Multipart body exceeded ${maxBytes} bytes.`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Parse a multipart body without letting it buffer past `maxBytes`.
 *
 * `formData()` reads the whole body into memory before any check can look at
 * it, and a request that declares no `Content-Length` — a chunked upload, say
 * — offers nothing for the route to screen beforehand. Cloudflare accepts
 * request bodies up to 100 MB (500 MB on Enterprise) while an isolate gets
 * 128 MB of memory shared across every request in flight on it, so an
 * unbounded parse here could push the isolate over that ceiling and take
 * unrelated requests down with it. Metering the bytes as they stream through
 * caps the exposure at the same allowance the declared-length screen uses.
 *
 * `exceeded` is tracked separately because the rejection `formData()` surfaces
 * for an errored source is the runtime's own error, not the one handed to
 * `controller.error`.
 */
export async function parseBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  // Nothing to meter — let formData() raise its own parse failure.
  if (!request.body) return await request.formData();

  let seen = 0;
  let exceeded = false;
  const bounded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          exceeded = true;
          controller.error(new UploadTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    return await new Response(bounded, {
      headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
    }).formData();
  } catch (err) {
    if (exceeded) throw new UploadTooLargeError(maxBytes);
    throw err;
  }
}

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
 * Read and burn an upload token.
 *
 * Best-effort single-use, not a strict guarantee: this is a KV get-then-delete
 * with no compare-and-swap, and KV reads are colo-cached (default ~60s) with
 * eventually-consistent invalidation across colos. Two concurrent POSTs with
 * the same token, or a replay landing on a colo shortly after the first use,
 * can both read the record before the delete is visible there, letting both
 * uploads through. The blast radius is bounded and non-escalating either way:
 * the token stays bound to one article and one user's key (set at mint time),
 * so the worst case is an extra asset on an article, uploaded by someone who
 * already held a valid token for it. A strict single-use guarantee would
 * require doing the burn in the user's Durable Object (strongly consistent)
 * instead of KV — out of scope here.
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

/** Help Scout's 201 response from POST /assets/article. */
export interface UploadedAsset {
  filelink: string;
  filename: string;
  width?: number;
  height?: number;
}

/**
 * Canonical extension for each type `sniffImageMimeType` can return. Used by
 * `sanitizeUploadFileName` to make the stored name agree with the sniffed
 * bytes rather than whatever extension the caller supplied.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MAX_FILE_NAME_LENGTH = 100;
const DEFAULT_FILE_NAME = "image";

/**
 * Turn a caller-supplied (and therefore untrusted) file name into a safe one
 * that matches the sniffed image type.
 *
 * `fileName` can come straight from an MCP tool argument (prompt-injectable)
 * or a local uploader's file path, and had no charset/length/extension
 * constraint. This: (1) drops any directory components, so a path-traversal
 * attempt like `../../evil.png` can't survive; (2) strips whatever extension
 * was supplied and replaces it with the canonical one for `sniffed`, so
 * `logo.svg` carrying real PNG bytes is stored as `logo.png` rather than
 * under an extension that could make some other system serve it as
 * HTML/SVG; (3) collapses anything outside a conservative safe set; and
 * (4) caps the length. Falls back to a generic name if nothing usable
 * remains.
 */
export function sanitizeUploadFileName(name: string | undefined, mimeType: string): string {
  const extension = MIME_EXTENSIONS[mimeType] ?? "";
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const withoutExtension = base.replace(/\.[^./\\]*$/, "");
  const safe = withoutExtension.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_FILE_NAME_LENGTH);
  return `${safe || DEFAULT_FILE_NAME}${extension}`;
}

async function transformUploadError(res: Response): Promise<HelpScoutApiError> {
  // Deliberately not the response body: Help Scout's error bodies/WAF pages
  // can echo request details, and uploadArticleImage below puts the Docs API
  // key in the very form body a 4xx/5xx here is erroring on. This message
  // has no client-facing consumer (auth-handler.ts's route returns a fixed
  // string instead) — its only reader is the `logger.warn` call there, so it
  // must not carry anything Help Scout echoed back.
  const message = `Help Scout rejected the asset upload with HTTP ${res.status}.`;
  if (res.status === 401) {
    return new HelpScoutApiError(
      "REAUTH_REQUIRED",
      "Help Scout rejected the Docs API key. Visit /docs-api-key/enter to reconnect.",
      401,
    );
  }
  if (res.status === 403) return new HelpScoutApiError("UNAUTHORIZED", message, res.status);
  if (res.status === 404) return new HelpScoutApiError("NOT_FOUND", message, res.status);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
    return new HelpScoutApiError("RATE_LIMIT", message, res.status, retryAfter);
  }
  if (res.status >= 400 && res.status < 500) {
    return new HelpScoutApiError("INVALID_INPUT", message, res.status);
  }
  return new HelpScoutApiError("UPSTREAM_ERROR", message, res.status);
}

/**
 * Forward already-validated bytes to Help Scout as an inline article image.
 *
 * Not retried: the body is a single-use upload and Help Scout has no
 * idempotency key here, so a retry could duplicate the asset.
 */
export async function uploadArticleImage(
  env: Env,
  record: UploadTokenRecord,
  file: File,
): Promise<UploadedAsset> {
  const apiKey = await fetchDocsApiKey(env, record.email);

  const form = new FormData();
  // Help Scout wants the key in the body as well as in the Basic auth header.
  form.set("key", apiKey);
  form.set("articleId", record.articleId);
  form.set("assetType", "image");
  // `file.name` is authoritative here, not `record.fileName`: the caller
  // (the /docs/assets/upload route) has already resolved the fileName
  // precedence and run it through sanitizeUploadFileName, rebuilding `file`
  // with that sanitized name. Re-deferring to the raw `record.fileName` here
  // would undo that sanitization.
  form.set("fileName", file.name);
  form.set("file", file, file.name);

  const res = await fetch(`${HELPSCOUT_DOCS_API_BASE}/assets/article`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${apiKey}:X`)}`,
      Accept: "application/json",
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw await transformUploadError(res);

  const text = await res.text();
  try {
    return JSON.parse(text) as UploadedAsset;
  } catch {
    throw new HelpScoutApiError(
      "UPSTREAM_ERROR",
      "Help Scout returned a non-JSON response from the asset upload",
      res.status,
    );
  }
}
