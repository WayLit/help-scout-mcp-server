import { afterEach, describe, expect, it, vi } from "vitest";

import { HelpScoutDocsAPI } from "../helpscout-docs-api";
import type { Env } from "../types";

/** In-memory shim for the session DO's own cache storage. */
function fakeStorage() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => {
      const matches = new Map(
        [...store.entries()].filter(([k]) => k.startsWith(prefix)),
      );
      return { size: matches.size, keys: () => matches.keys() } as never;
    }),
    raw: store,
  };
}

/** Fake email-named user DO (MCP_OBJECT) holding the Docs API key. */
function fakeUserDO(opts: { apiKey?: string }) {
  let apiKey = opts.apiKey ?? null;
  const stub = {
    fetch: vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/has-docs-key") {
        return Response.json({ valid: Boolean(apiKey) });
      }
      if (url.pathname === "/get-docs-key" && init?.method === "POST") {
        if (!apiKey) return Response.json({ code: "REAUTH_REQUIRED" }, { status: 401 });
        return Response.json({ apiKey });
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
    setApiKey: (k: string | null) => {
      apiKey = k;
    },
  };
}

function buildEnv(userDoNamespace: unknown): Env {
  return { MCP_OBJECT: userDoNamespace as never } as unknown as Env;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("HelpScoutDocsAPI.hasApiKey", () => {
  it("returns false when no key is stored", async () => {
    const ud = fakeUserDO({});
    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    expect(await api.hasApiKey()).toBe(false);
    expect(ud.stub.fetch).toHaveBeenCalledWith("https://internal/has-docs-key");
  });

  it("returns true when a key is stored", async () => {
    const ud = fakeUserDO({ apiKey: "key-123" });
    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    expect(await api.hasApiKey()).toBe(true);
  });
});

describe("HelpScoutDocsAPI auth", () => {
  it("propagates REAUTH_REQUIRED when no key is stored", async () => {
    const ud = fakeUserDO({});
    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/collections")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  });

  it("sends the key as HTTP Basic Auth with a dummy password", async () => {
    const ud = fakeUserDO({ apiKey: "abc123" });
    let authHeader = "";
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await api.get("/collections");

    expect(authHeader).toBe(`Basic ${btoa("abc123:X")}`);
  });

  it("does not retry on 401 — a static key rejection is immediate REAUTH_REQUIRED", async () => {
    const ud = fakeUserDO({ apiKey: "revoked-key" });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/collections")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(calls).toBe(1);
  });
});

describe("HelpScoutDocsAPI error mapping", () => {
  it("404 → NOT_FOUND", async () => {
    const ud = fakeUserDO({ apiKey: "key" });
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/articles/1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("429 → RATE_LIMIT after retries exhaust", async () => {
    const ud = fakeUserDO({ apiKey: "key" });
    globalThis.fetch = vi.fn(async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
    ) as typeof fetch;
    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await expect(api.get("/articles")).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });
});

describe("HelpScoutDocsAPI cache", () => {
  it("returns cached GET responses without a second HTTP call", async () => {
    const ud = fakeUserDO({ apiKey: "key" });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ collections: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await api.get("/collections");
    await api.get("/collections");
    expect(calls).toBe(1);
  });

  it("write() invalidates the cached GET for the same endpoint", async () => {
    const ud = fakeUserDO({ apiKey: "key" });
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls++;
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ article: { id: "1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const api = new HelpScoutDocsAPI(buildEnv(ud.namespace), fakeStorage() as never, "user@example.com");
    await api.get("/articles/1");
    await api.write("PUT", "/articles/1", { name: "New name" });
    await api.get("/articles/1");
    expect(calls).toBe(3); // GET, PUT, GET again (not served from cache)
  });
});
