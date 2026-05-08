/**
 * Help Scout API client for Workers.
 *
 * Unlike the stdio server, each user has their own Authorization Code
 * token pair stored in KV. This client loads, refreshes, and writes back
 * tokens transparently for every call.
 */
import type { Env, HelpScoutTokenRecord } from "./types";
import { helpScoutTokensKey } from "./types";

const HELPSCOUT_API_BASE = "https://api.helpscout.net/v2";
const HELPSCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

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

/** Normalized API error — mirrors the stdio server's ApiError shape. */
export class HelpScoutApiError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "UNAUTHORIZED"
      | "RATE_LIMIT"
      | "UPSTREAM_ERROR",
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
    private readonly userEmail: string,
  ) {}

  // ── Token lifecycle ────────────────────────────────────────────────────

  private async loadTokens(): Promise<HelpScoutTokenRecord> {
    const raw = await this.env.OAUTH_KV.get(helpScoutTokensKey(this.userEmail));
    if (!raw) {
      throw new HelpScoutApiError(
        "UNAUTHORIZED",
        "No Help Scout tokens found for this user. Please re-authenticate.",
      );
    }
    return JSON.parse(raw) as HelpScoutTokenRecord;
  }

  private async storeTokens(record: HelpScoutTokenRecord): Promise<void> {
    await this.env.OAUTH_KV.put(helpScoutTokensKey(this.userEmail), JSON.stringify(record));
  }

  private async refreshTokens(refreshToken: string): Promise<HelpScoutTokenRecord> {
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
    });
    if (!res.ok) {
      throw new HelpScoutApiError(
        "UNAUTHORIZED",
        `Help Scout token refresh failed (${res.status}). User must re-authenticate.`,
        res.status,
      );
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
    await this.storeTokens(record);
    return record;
  }

  private async getAccessToken(): Promise<string> {
    const record = await this.loadTokens();
    // Refresh 60s before expiry
    if (record.expiresAt - Date.now() >= 60_000) return record.accessToken;

    // Re-read KV first: another concurrent request in this DO may have
    // already refreshed and written a new token. Help Scout refresh tokens
    // are typically single-use, so a second refresh would fail with
    // invalid_grant and lock out the user.
    const fresh = await this.loadTokens();
    if (fresh.expiresAt - Date.now() >= 60_000) return fresh.accessToken;

    const refreshed = await this.refreshTokens(fresh.refreshToken);
    return refreshed.accessToken;
  }

  // ── Request pipeline ───────────────────────────────────────────────────

  /**
   * GET a Help Scout endpoint. `endpoint` may be a path relative to /v2
   * (e.g. "/conversations") or an absolute URL (for v3 calls).
   */
  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    const url = this.buildUrl(endpoint, params);

    // First attempt
    let token = await this.getAccessToken();
    let res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    // On 401, force a refresh once and retry. But first re-read KV: a
    // concurrent request may have already refreshed and stored a new token,
    // in which case we should use that rather than burn the refresh token
    // again (Help Scout refresh tokens are single-use).
    if (res.status === 401) {
      const stored = await this.loadTokens();
      let refreshedToken: string;
      if (stored.accessToken !== token && stored.expiresAt - Date.now() >= 60_000) {
        // Another request already refreshed — use the new token.
        refreshedToken = stored.accessToken;
      } else {
        const refreshed = await this.refreshTokens(stored.refreshToken);
        refreshedToken = refreshed.accessToken;
      }
      token = refreshedToken;
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    }

    if (!res.ok) {
      throw await this.transformError(res);
    }

    // 204 / empty body safety
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
