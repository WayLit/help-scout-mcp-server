/**
 * Help Scout API client used inside MCP session Durable Objects.
 *
 * Token state (access + refresh + single-flight refresh) lives in the *user*
 * DO (named by email — see `HelpScoutMCP.handleInternal` in `index.ts`), not
 * here. Session DOs are named by transport session ID by `McpAgent.serve()`,
 * so the session storage we hold a reference to here is per-session and only
 * used for response caching. Token operations RPC into the email-named user
 * DO so concurrent sessions share one refresh promise — Help Scout refresh
 * tokens are single-use, and a parallel refresh would burn one with
 * `invalid_grant`.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";

import type { Env } from "./types";

const HELPSCOUT_API_BASE = "https://api.helpscout.net/v2";

/** Matches the parts of Help Scout's v2 paginated response we care about. */
export interface PaginatedResponse<T> {
  _embedded?: Record<string, T[]>;
  _links?: {
    next?: { href: string };
    prev?: { href: string };
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

export type HelpScoutErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "REAUTH_REQUIRED"
  | "RATE_LIMIT"
  | "UPSTREAM_ERROR";

/** Normalized API error — mirrors the stdio server's ApiError shape. */
export class HelpScoutApiError extends Error {
  constructor(
    public readonly code: HelpScoutErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HelpScoutApiError";
  }
}

export function isHelpScoutApiError(err: unknown): err is HelpScoutApiError {
  return err instanceof HelpScoutApiError;
}

export class HelpScoutAPI {
  constructor(
    private readonly env: Env,
    private readonly storage: DurableObjectStorage,
    public readonly userEmail: string,
  ) {}

  // ── Token RPC into the user DO ─────────────────────────────────────────

  /**
   * Look up the user DO stub. The user DO is named by email and holds the
   * canonical token record + single-flight refresh; this session DO is named
   * by transport session ID and never reads/writes tokens directly.
   */
  private getUserDoStub(): { fetch: (input: string, init?: RequestInit) => Promise<Response> } {
    const id = this.env.MCP_OBJECT.idFromName(this.userEmail);
    return this.env.MCP_OBJECT.get(id);
  }

  /** True if the user DO has tokens with at least 60s of life left. */
  async hasValidTokens(): Promise<boolean> {
    const stub = this.getUserDoStub();
    const res = await stub.fetch("https://internal/has-valid-tokens");
    if (!res.ok) return false;
    const json = (await res.json()) as { valid: boolean };
    return Boolean(json.valid);
  }

  /**
   * Fetch a usable access token from the user DO. `forceRefresh: true` makes
   * the user DO refresh even if the stored token still looks live — used on a
   * 401 from Help Scout, in case the token was revoked early.
   */
  private async fetchAccessToken(forceRefresh: boolean): Promise<string> {
    const stub = this.getUserDoStub();
    const res = await stub.fetch("https://internal/get-access-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forceRefresh }),
    });
    if (res.status === 401) {
      throw new HelpScoutApiError(
        "REAUTH_REQUIRED",
        "Help Scout authentication required. Please re-authenticate.",
        401,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HelpScoutApiError(
        "UPSTREAM_ERROR",
        `Failed to load Help Scout access token (${res.status}): ${text}`,
        res.status,
      );
    }
    const json = (await res.json()) as { accessToken: string };
    return json.accessToken;
  }

  // ── Request pipeline ───────────────────────────────────────────────────

  /**
   * Default cache TTL by endpoint family, mirroring stdio:
   *   /mailboxes  → 24h
   *   /conversations, /threads → 5min
   *   everything else → 5min
   * Pass `cacheOptions: { ttl: 0 }` to bypass cache for a single call.
   */
  private getDefaultCacheTtlSeconds(endpoint: string): number {
    if (endpoint.includes("/mailboxes")) return 86_400;
    if (endpoint.includes("/conversations")) return 300;
    if (endpoint.includes("/threads")) return 300;
    return 300;
  }

  private async getCached<T>(cacheKey: string): Promise<T | undefined> {
    const entry = await this.storage.get<{ value: T; expiresAt: number }>(cacheKey);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      await this.storage.delete(cacheKey);
      return undefined;
    }
    return entry.value;
  }

  private async setCached<T>(cacheKey: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.storage.put(cacheKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Stable cache key per endpoint+params. Per-user is implicit (each user has their own DO). */
  private buildCacheKey(endpoint: string, params?: Record<string, unknown>): string {
    const paramStr = params ? JSON.stringify(params, Object.keys(params).sort()) : "";
    return `cache:GET:${endpoint}:${paramStr}`;
  }

  /**
   * GET a Help Scout endpoint. `endpoint` may be a path relative to /v2
   * (e.g. "/conversations") or an absolute URL.
   */
  async get<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    cacheOptions?: { ttl?: number },
  ): Promise<T> {
    const cacheKey = this.buildCacheKey(endpoint, params);
    const cached = await this.getCached<T>(cacheKey);
    if (cached !== undefined) return cached;

    const url = this.buildUrl(endpoint, params);
    const result = await this.executeWithRetry<T>(url);

    const ttl = cacheOptions?.ttl ?? this.getDefaultCacheTtlSeconds(endpoint);
    await this.setCached(cacheKey, result, ttl);
    return result;
  }

  /**
   * Execute a GET with exponential backoff on transient errors (network, 5xx, 429).
   * Honors `Retry-After` for rate limits. After retries exhaust, throws a
   * normalized HelpScoutApiError.
   *
   * 401 handling: at most one forced refresh per request. If a second 401
   * arrives after a fresh token, fail with UNAUTHORIZED rather than spinning
   * the refresh loop and burning refresh tokens.
   */
  private async executeWithRetry<T>(url: string, maxRetries = 3): Promise<T> {
    const baseDelayMs = 1_000;
    const maxDelayMs = 10_000;

    let attempt = 0;
    let forcedRefreshAttempted = false;
    while (true) {
      const token = await this.fetchAccessToken(false);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        // Network error / timeout — retry if we have attempts left.
        if (attempt < maxRetries) {
          await this.sleep(this.calculateBackoff(attempt, baseDelayMs, maxDelayMs));
          attempt++;
          continue;
        }
        throw new HelpScoutApiError(
          "UPSTREAM_ERROR",
          `Help Scout request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 401 — force a refresh and retry once. Bail on the second 401 so we
      // don't spin forever burning refresh tokens.
      if (res.status === 401) {
        if (forcedRefreshAttempted) {
          throw new HelpScoutApiError(
            "UNAUTHORIZED",
            "Help Scout rejected the access token after a forced refresh.",
            401,
          );
        }
        forcedRefreshAttempted = true;
        await this.fetchAccessToken(true);
        continue;
      }

      // Retryable: 429 or 5xx.
      if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < maxRetries) {
        let delay: number;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
          delay = Math.min(retryAfter * 1000, maxDelayMs);
        } else {
          delay = this.calculateBackoff(attempt, baseDelayMs, maxDelayMs);
        }
        await this.sleep(delay);
        attempt++;
        continue;
      }

      if (!res.ok) {
        throw await this.transformError(res);
      }

      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HelpScoutApiError(
          "UPSTREAM_ERROR",
          "Help Scout returned a non-JSON response",
          res.status,
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private calculateBackoff(attempt: number, baseDelay: number, maxDelay: number): number {
    const exp = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exp;
    return Math.min(exp + jitter, maxDelay);
  }

  private buildUrl(endpoint: string, params?: Record<string, unknown>): string {
    const base = endpoint.startsWith("http")
      ? endpoint
      : `${HELPSCOUT_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const url = new URL(base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async transformError(res: Response): Promise<HelpScoutApiError> {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    const status = res.status;
    const message = bodyText || res.statusText || `HTTP ${status}`;
    if (status === 401 || status === 403) {
      return new HelpScoutApiError("UNAUTHORIZED", message, status);
    }
    if (status === 404) {
      return new HelpScoutApiError("NOT_FOUND", message, status);
    }
    if (status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
      return new HelpScoutApiError("RATE_LIMIT", message, status, retryAfter);
    }
    if (status >= 400 && status < 500) {
      return new HelpScoutApiError("INVALID_INPUT", message, status);
    }
    return new HelpScoutApiError("UPSTREAM_ERROR", message, status);
  }
}
