/**
 * Help Scout Docs API client used inside the Docs MCP session Durable Objects.
 *
 * Unlike the mailbox API (`helpscout-api.ts`), Docs API access is a single
 * static personal API key (Basic Auth) — no OAuth, no refresh, no expiry.
 * The key is entered once via the `/docs-api-key/enter` web form and stored
 * in the user's DO (`MCP_OBJECT`, keyed by email — the same DO that holds
 * mailbox OAuth tokens). This client RPCs into that DO to read it; the
 * session DO instance itself never writes it.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";

import { HelpScoutApiError } from "./helpscout-api";
import type { Env } from "./types";

export const HELPSCOUT_DOCS_API_BASE = "https://docsapi.helpscout.net/v1";

/**
 * Read the user's Docs API key from their mailbox DO.
 * Used by both HelpScoutDocsAPI and the standalone uploadArticleImage function.
 */
export async function fetchDocsApiKey(env: Env, email: string): Promise<string> {
  const id = env.MCP_OBJECT.idFromName(email);
  const stub = env.MCP_OBJECT.get(id);
  const res = await stub.fetch("https://internal/get-docs-key", { method: "POST" });
  if (res.status === 401) {
    throw new HelpScoutApiError(
      "REAUTH_REQUIRED",
      "Help Scout Docs API key required. Visit /docs-api-key/enter to connect one.",
      401,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HelpScoutApiError(
      "UPSTREAM_ERROR",
      `Failed to load Help Scout Docs API key (${res.status}): ${text}`,
      res.status,
    );
  }
  const json = (await res.json()) as { apiKey: string };
  return json.apiKey;
}

export class HelpScoutDocsAPI {
  constructor(
    private readonly env: Env,
    private readonly storage: DurableObjectStorage,
    public readonly userEmail: string,
  ) {}

  private getUserDoStub(): { fetch: (input: string, init?: RequestInit) => Promise<Response> } {
    const id = this.env.MCP_OBJECT.idFromName(this.userEmail);
    return this.env.MCP_OBJECT.get(id);
  }

  /** True if the user DO has a stored Docs API key. */
  async hasApiKey(): Promise<boolean> {
    const stub = this.getUserDoStub();
    const res = await stub.fetch("https://internal/has-docs-key");
    if (!res.ok) return false;
    const json = (await res.json()) as { valid: boolean };
    return Boolean(json.valid);
  }

  private async fetchApiKey(): Promise<string> {
    return fetchDocsApiKey(this.env, this.userEmail);
  }

  // ── Request pipeline ───────────────────────────────────────────────────

  private getDefaultCacheTtlSeconds(endpoint: string): number {
    if (endpoint.includes("/collections")) return 300;
    return 60;
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

  private buildCacheKey(endpoint: string, params?: Record<string, unknown>): string {
    const paramStr = params ? JSON.stringify(params, Object.keys(params).sort()) : "";
    return `cache:docs:GET:${endpoint}:${paramStr}`;
  }

  async get<T>(
    endpoint: string,
    params?: Record<string, unknown>,
    cacheOptions?: { ttl?: number },
  ): Promise<T> {
    const cacheKey = this.buildCacheKey(endpoint, params);
    const cached = await this.getCached<T>(cacheKey);
    if (cached !== undefined) return cached;

    const url = this.buildUrl(endpoint, params);
    const result = await this.executeWithRetry<T>(url, { method: "GET" });

    const ttl = cacheOptions?.ttl ?? this.getDefaultCacheTtlSeconds(endpoint);
    await this.setCached(cacheKey, result, ttl);
    return result;
  }

  /** POST/PUT/DELETE a Docs endpoint. Never cached; invalidates cached GETs for the endpoint prefix. */
  async write<T = unknown>(
    method: "POST" | "PUT" | "DELETE",
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(endpoint);
    const result = await this.executeWithRetry<T>(url, { method, body });
    await this.invalidateEndpointCache(endpoint);
    return result;
  }

  private async invalidateEndpointCache(endpoint: string): Promise<void> {
    // Invalidate the endpoint's own cache plus its parent collection (e.g.
    // writing /articles/123 should also drop cached /articles listings).
    const base = endpoint.split("/").slice(0, 2).join("/") || endpoint;
    for (const prefix of [`cache:docs:GET:${endpoint}`, `cache:docs:GET:${base}`]) {
      const stale = await this.storage.list({ prefix });
      if (stale.size > 0) await this.storage.delete([...stale.keys()]);
    }
  }

  private async executeWithRetry<T>(
    url: string,
    init: { method: string; body?: unknown },
    maxRetries = 3,
  ): Promise<T> {
    const baseDelayMs = 1_000;
    const maxDelayMs = 10_000;
    const hasBody = init.body !== undefined;
    const serializedBody = hasBody ? JSON.stringify(init.body) : undefined;

    let attempt = 0;
    while (true) {
      const apiKey = await this.fetchApiKey();
      let res: Response;
      try {
        const headers: Record<string, string> = {
          Authorization: `Basic ${btoa(`${apiKey}:X`)}`,
          Accept: "application/json",
        };
        if (hasBody) headers["Content-Type"] = "application/json";
        res = await fetch(url, {
          method: init.method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await this.sleep(this.calculateBackoff(attempt, baseDelayMs, maxDelayMs));
          attempt++;
          continue;
        }
        throw new HelpScoutApiError(
          "UPSTREAM_ERROR",
          `Help Scout Docs request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // The key is static — a 401 means it's wrong/revoked, not a transient
      // token expiry. No forced-refresh retry; surface it immediately.
      if (res.status === 401) {
        throw new HelpScoutApiError(
          "REAUTH_REQUIRED",
          "Help Scout rejected the Docs API key. Visit /docs-api-key/enter to reconnect.",
          401,
        );
      }

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

      // Create returns 201 with a Location header and often no body.
      if (res.status === 201) {
        const location = res.headers.get("Location") ?? undefined;
        const text = await res.text();
        if (!text) return { location } as T;
        try {
          return { ...(JSON.parse(text) as object), location } as T;
        } catch {
          return { location } as T;
        }
      }

      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HelpScoutApiError(
          "UPSTREAM_ERROR",
          "Help Scout Docs API returned a non-JSON response",
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
      : `${HELPSCOUT_DOCS_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
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
    if (status === 403) {
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
