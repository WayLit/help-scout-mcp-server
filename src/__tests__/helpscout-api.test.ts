import { afterEach, describe, expect, it, vi } from "vitest";

import { HelpScoutAPI } from "../helpscout-api";
import type { Env, HelpScoutTokenRecord } from "../types";

/**
 * In-memory shim that satisfies the parts of DurableObjectStorage that
 * HelpScoutAPI uses (get / put / delete with a single string key + value).
 * Used here only as a per-session cache — token state lives in the fake user
 * DO below.
 */
function fakeStorage() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (keys: string | string[]): Promise<boolean | number> => {
      if (Array.isArray(keys)) {
        let count = 0;
        for (const key of keys) if (store.delete(key)) count++;
        return count;
      }
      return store.delete(keys);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }): Promise<Map<string, unknown>> => {
      const matches = new Map<string, unknown>();
      for (const [key, value] of store) {
        if (key.startsWith(prefix)) matches.set(key, value);
      }
      return matches;
    }),
    raw: store,
  };
}

/**
 * Fake email-named user DO. HelpScoutAPI RPCs into this stub for token state
 * and refresh — mirroring the production layout where the user DO owns
 * `/get-access-token` and `/has-valid-tokens` and the session DO is a thin
 * MCP transport. Tracks how many forced-refresh RPCs the API issued so we can
 * assert the once-per-request guard.
 */
function fakeUserDO(opts: { initialTokens?: HelpScoutTokenRecord; reauthRequired?: boolean }) {
  let stored: HelpScoutTokenRecord | null = opts.initialTokens ?? null;
  let oauthRefreshes = 0;
  let forcedRefreshes = 0;
  const stub = {
    fetch: vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/has-valid-tokens" && (!init?.method || init.method === "GET")) {
        const valid = Boolean(stored && stored.expiresAt - Date.now() >= 60_000);
        return Response.json({ valid });
      }
      if (url.pathname === "/get-access-token" && init?.method === "POST") {
        const body = init.body
          ? ((await new Response(init.body as BodyInit).json()) as { forceRefresh?: boolean })
          : {};
        if (!stored || opts.reauthRequired) {
          return Response.json({ code: "REAUTH_REQUIRED" }, { status: 401 });
        }
        const fresh = stored.expiresAt - Date.now() >= 60_000;
        if (!body.forceRefresh && fresh) {
          return Response.json({
            accessToken: stored.accessToken,
            expiresAt: stored.expiresAt,
          });
        }
        if (body.forceRefresh) forcedRefreshes++;
        oauthRefreshes++;
        stored = {
          accessToken: `refreshed-access-${oauthRefreshes}`,
          refreshToken: `refreshed-refresh-${oauthRefreshes}`,
          expiresAt: Date.now() + 3_600_000,
        };
        return Response.json({ accessToken: stored.accessToken, expiresAt: stored.expiresAt });
      }
      return new Response("not found", { status: 404 });
    }),
  };
  const namespace = {
    idFromName: vi.fn(() => ({ toString: () => "fake-do-id" })),
    get: vi.fn(() => stub),
  };
  return {
    namespace,
    stub,
    getOauthRefreshes: () => oauthRefreshes,
    getForcedRefreshes: () => forcedRefreshes,
    setStored: (t: HelpScoutTokenRecord | null) => {
      stored = t;
    },
    getStored: () => stored,
  };
}

const validTokens: HelpScoutTokenRecord = {
  accessToken: "current-access",
  refreshToken: "current-refresh",
  expiresAt: Date.now() + 3_600_000,
};

function buildEnv(userDoNamespace: unknown): Env {
  return {
    HELPSCOUT_APP_ID: "app-id",
    HELPSCOUT_APP_SECRET: "app-secret",
    MCP_OBJECT: userDoNamespace as never,
  } as unknown as Env;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("HelpScoutAPI.hasValidTokens", () => {
  it("RPCs into the user DO and returns false when no tokens stored", async () => {
    const ud = fakeUserDO({});
    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    expect(await api.hasValidTokens()).toBe(false);
    expect(ud.stub.fetch).toHaveBeenCalledWith("https://internal/has-valid-tokens");
  });

  it("returns true when the user DO reports valid tokens", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    expect(await api.hasValidTokens()).toBe(true);
  });

  it("uses the user's email as the DO routing key", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "alice@waylit.ai");
    await api.hasValidTokens();
    expect(ud.namespace.idFromName).toHaveBeenCalledWith("alice@waylit.ai");
  });
});

describe("HelpScoutAPI.get error mapping", () => {
  it("404 → NOT_FOUND", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/conversations/1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("429 → RATE_LIMIT after retries exhaust", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    ) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/conversations")).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it(
    "500 retried then transformed to UPSTREAM_ERROR",
    async () => {
      const ud = fakeUserDO({ initialTokens: validTokens });
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response("boom", { status: 500 });
      }) as typeof fetch;

      const api = new HelpScoutAPI(
        buildEnv(ud.namespace),
        fakeStorage() as never,
        "user@example.com",
      );
      await expect(api.get("/conversations")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(calls).toBe(4); // 1 initial + 3 retries
    },
    20_000,
  );
});

describe("HelpScoutAPI auth flows", () => {
  it("propagates REAUTH_REQUIRED from the user DO when no tokens are stored", async () => {
    const ud = fakeUserDO({}); // no tokens
    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/conversations")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  });

  it("forces a refresh on 401 then retries once with the fresh token", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    let attempt = 0;
    let usedToken = "";
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempt++;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (attempt === 1) {
        return new Response("expired", { status: 401 });
      }
      usedToken = auth.replace(/^Bearer\s+/, "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await api.get("/conversations");

    expect(attempt).toBe(2);
    expect(ud.getForcedRefreshes()).toBe(1);
    expect(usedToken).toBe("refreshed-access-1");
  });

  it("gives up with UNAUTHORIZED after a second 401, instead of looping refreshes", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt++;
      return new Response("still 401", { status: 401 });
    }) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/conversations")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
    // First call: 401 → force refresh + retry. Second call: 401 → bail.
    expect(attempt).toBe(2);
    // Exactly one forced refresh — not an infinite loop.
    expect(ud.getForcedRefreshes()).toBe(1);
  });
});

describe("HelpScoutAPI cache", () => {
  it("returns cached responses without re-RPC'ing for an access token", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    let hsCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      hsCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await api.get("/mailboxes");
    await api.get("/mailboxes");
    expect(hsCalls).toBe(1); // second call cached
  });

  it("returns the parsed response body directly (not wrapped in { data, headers })", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    const result = await api.get<{ ok: boolean }>("/mailboxes");
    expect(result).toEqual({ ok: true });
  });
});

describe("HelpScoutAPI.post", () => {
  it("returns the parsed body and response headers", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response(null, {
        status: 201,
        headers: {
          "Resource-Id": "999",
          "Web-Location": "https://secure.helpscout.net/conversation/999",
        },
      }),
    ) as typeof fetch;

    const api = new HelpScoutAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    const { data, headers } = await api.post("/conversations", { subject: "Hi" });

    expect(data).toEqual({});
    expect(headers.get("Resource-Id")).toBe("999");
    expect(headers.get("Web-Location")).toBe("https://secure.helpscout.net/conversation/999");
  });

  it("invalidates the cache for the posted endpoint by default", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const storage = fakeStorage();
    const api = new HelpScoutAPI(buildEnv(ud.namespace), storage as never, "user@example.com");
    await api.get("/conversations");
    expect(storage.raw.has("cache:GET:/conversations:")).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response(null, { status: 201 })) as typeof fetch;
    await api.post("/conversations", { subject: "Hi" });

    expect(storage.raw.has("cache:GET:/conversations:")).toBe(false);
  });

  it("invalidates every endpoint passed via opts.invalidate", async () => {
    const ud = fakeUserDO({ initialTokens: validTokens });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const storage = fakeStorage();
    const api = new HelpScoutAPI(buildEnv(ud.namespace), storage as never, "user@example.com");
    await api.get("/conversations/1");
    await api.get("/conversations/1/threads");
    expect(storage.raw.has("cache:GET:/conversations/1:")).toBe(true);
    expect(storage.raw.has("cache:GET:/conversations/1/threads:")).toBe(true);

    globalThis.fetch = vi.fn(async () => new Response(null, { status: 201 })) as typeof fetch;
    await api.post(
      "/conversations/1/reply",
      { text: "hi" },
      { invalidate: ["/conversations/1", "/conversations/1/threads"] },
    );

    expect(storage.raw.has("cache:GET:/conversations/1:")).toBe(false);
    expect(storage.raw.has("cache:GET:/conversations/1/threads:")).toBe(false);
  });
});
