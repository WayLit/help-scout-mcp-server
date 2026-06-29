import { describe, expect, it, vi } from "vitest";

import {
  createOAuthState,
  deleteOAuthState,
  readOAuthState,
} from "../workers-oauth-utils";

function fakeKv() {
  const store = new Map<string, { value: string; opts?: { expirationTtl?: number } }>();
  return {
    store,
    put: vi.fn(
      async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, { value, opts });
      },
    ),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace & {
    store: Map<string, { value: string; opts?: { expirationTtl?: number } }>;
    put: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

const oauthReqInfo = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://claude.ai/cb",
  scope: ["mcp"],
  state: "abc",
  codeChallenge: "ch",
  codeChallengeMethod: "S256",
};

describe("createOAuthState", () => {
  it("writes state to KV with 10-minute TTL and returns an opaque token", async () => {
    const kv = fakeKv();
    const { stateToken } = await createOAuthState(oauthReqInfo as never, kv);

    expect(stateToken).toMatch(/^[a-f0-9]{64}$/);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, raw, opts] = kv.put.mock.calls[0];
    expect(key).toBe(`oauth:state:${stateToken}`);
    expect(JSON.parse(raw as string)).toEqual({ oauthReqInfo });
    expect((opts as { expirationTtl: number }).expirationTtl).toBe(600);
  });

  it("persists additional fields like accessIdentity alongside oauthReqInfo", async () => {
    const kv = fakeKv();
    const accessIdentity = { email: "alice@example.com", name: "Alice" };
    const { stateToken } = await createOAuthState(oauthReqInfo as never, kv, {
      accessIdentity,
    });

    const stored = kv.store.get(`oauth:state:${stateToken}`)!;
    expect(JSON.parse(stored.value)).toEqual({ oauthReqInfo, accessIdentity });
  });

  it("generates a fresh token per call (no collisions)", async () => {
    const kv = fakeKv();
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => createOAuthState(oauthReqInfo as never, kv)),
    );
    const unique = new Set(tokens.map((t) => t.stateToken));
    expect(unique.size).toBe(8);
  });
});

describe("readOAuthState", () => {
  it("returns the stored payload for a valid token", async () => {
    const kv = fakeKv();
    const { stateToken } = await createOAuthState(oauthReqInfo as never, kv);

    const result = await readOAuthState(stateToken, kv);
    expect(result?.oauthReqInfo).toEqual(oauthReqInfo);
  });

  it("returns null for an empty token without hitting KV", async () => {
    const kv = fakeKv();
    expect(await readOAuthState("", kv)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token", async () => {
    const kv = fakeKv();
    expect(await readOAuthState("nonexistent", kv)).toBeNull();
  });

  it("returns null when stored JSON is corrupt rather than throwing", async () => {
    const kv = fakeKv();
    kv.store.set("oauth:state:bad", { value: "{not json" });
    expect(await readOAuthState("bad", kv)).toBeNull();
  });
});

describe("deleteOAuthState", () => {
  it("removes the stored state", async () => {
    const kv = fakeKv();
    const { stateToken } = await createOAuthState(oauthReqInfo as never, kv);
    expect(await readOAuthState(stateToken, kv)).not.toBeNull();

    await deleteOAuthState(stateToken, kv);
    expect(await readOAuthState(stateToken, kv)).toBeNull();
  });
});
