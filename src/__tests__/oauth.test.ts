import { beforeEach, describe, expect, it } from "vitest";

import { isDocsResource } from "../auth-handler";
import { createOAuthRouter } from "../oauth";
import type { Env } from "../types";

const ISSUER = "https://mcp.example.com";
const REDIRECT_URI = "http://localhost:9999/cb";

/** Just enough of Workers KV for the provider: JSON get, put, delete, prefix list. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, opts?: unknown) {
      const value = store.get(key);
      if (value === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("OAuth router", () => {
  let env: Env;
  let seenResource: string | string[] | undefined;
  const router = createOAuthRouter(ISSUER, {
    mailbox: {
      fetch: (_req, _env, c) =>
        Response.json({ endpoint: "mailbox", props: (c as { props?: unknown }).props }),
    },
    docs: {
      fetch: (_req, _env, c) =>
        Response.json({ endpoint: "docs", props: (c as { props?: unknown }).props }),
    },
    app: {
      // Stands in for AuthHandler's /authorize: records the resource it routes on.
      async fetch(request, appEnv) {
        if (new URL(request.url).pathname !== "/authorize")
          return new Response(null, { status: 404 });
        const oauthReqInfo = await appEnv.OAUTH_PROVIDER.parseAuthRequest(request);
        seenResource = oauthReqInfo.resource;
        const { redirectTo } = await appEnv.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "user@example.com",
          scope: oauthReqInfo.scope,
          metadata: {},
          props: { email: "user@example.com", name: "User" },
        });
        return new Response(null, { status: 302, headers: { Location: redirectTo } });
      },
    },
  });
  const call = (path: string, init?: RequestInit) =>
    router.fetch(new Request(`${ISSUER}${path}`, init), env, ctx);

  beforeEach(() => {
    env = { OAUTH_KV: memoryKv(), OAUTH_ISSUER: ISSUER } as unknown as Env;
    seenResource = undefined;
  });

  /** Register a client, authorize for `resource`, and exchange the code for an access token. */
  async function authorize(resource: string | undefined): Promise<string> {
    const reg = await call("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const challenge = base64url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
    if (resource) query.set("resource", resource);
    const auth = await call(`/authorize?${query}`);
    expect(auth.status).toBe(302);
    const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id,
      code_verifier: verifier,
    });
    if (resource) body.set("resource", resource);
    const token = await call("/token", { method: "POST", body });
    expect(token.status).toBe(200);
    return ((await token.json()) as { access_token: string }).access_token;
  }

  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

  it("challenges each endpoint with its own protected-resource metadata", async () => {
    for (const path of ["/mcp", "/docs/mcp"]) {
      const res = await call(path);
      expect(res.status).toBe(401);
      const metadataUrl = `${ISSUER}/.well-known/oauth-protected-resource${path}`;
      expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${metadataUrl}"`);
      const metadata = (await (await call(new URL(metadataUrl).pathname)).json()) as {
        resource: string;
      };
      expect(metadata.resource).toBe(`${ISSUER}${path}`);
    }
  });

  it("routes a Docs authorization to the Docs flow and scopes its token to /docs/mcp", async () => {
    const token = await authorize(`${ISSUER}/docs/mcp`);
    expect(isDocsResource(seenResource)).toBe(true);

    const docs = await call("/docs/mcp", bearer(token));
    expect(await docs.json()).toEqual({
      endpoint: "docs",
      props: { email: "user@example.com", name: "User" },
    });
    expect((await call("/mcp", bearer(token))).status).toBe(401);
  });

  it("routes a mailbox authorization to the mailbox flow and scopes its token to /mcp", async () => {
    const token = await authorize(`${ISSUER}/mcp`);
    expect(isDocsResource(seenResource)).toBe(false);

    expect(
      ((await (await call("/mcp", bearer(token))).json()) as { endpoint: string }).endpoint,
    ).toBe("mailbox");
    expect((await call("/docs/mcp", bearer(token))).status).toBe(401);
  });

  it("defaults an authorization without a resource to the mailbox", async () => {
    const token = await authorize(undefined);
    expect(seenResource).toBe(`${ISSUER}/mcp`);
    expect((await call("/mcp", bearer(token))).status).toBe(200);
  });

  it("hands paths the authorization server doesn't own to the app", async () => {
    expect((await call("/healthz")).status).toBe(404); // the stub app 404s everything but /authorize
    const metadata = (await (
      await call("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.token_endpoint).toBe(`${ISSUER}/token`);
  });
});
