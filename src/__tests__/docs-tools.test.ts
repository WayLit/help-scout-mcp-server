import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { HelpScoutApiError } from "../helpscout-api";
import { registerDocsTools } from "../docs-tools";

const EXPECTED_TOOL_NAMES = [
  "listCollections",
  "getCollection",
  "createCollection",
  "updateCollection",
  "deleteCollection",
  "listArticles",
  "searchArticles",
  "getArticle",
  "createArticle",
  "updateArticle",
  "deleteArticle",
  "createArticleImageUpload",
];

type ToolHandler = (args: unknown, extra: unknown) => Promise<CallToolResult>;
type RegisteredTool = { description?: string; handler: ToolHandler };

function fakeApi() {
  return {
    get: vi.fn(),
    write: vi.fn(),
    userEmail: "tester@example.com",
  };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/**
 * `origin` defaults to a stub host. Pass `null` to simulate a tool call before
 * any request has been served, where getPublicOrigin() returns undefined.
 */
function setupServer(origin: string | null = "https://hs-mcp.example.com") {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const api = { ...fakeApi(), hasApiKey: vi.fn().mockResolvedValue(true) };
  const kv = fakeKv();
  registerDocsTools(server, api as never, {
    env: { OAUTH_KV: kv } as never,
    getPublicOrigin: () => origin ?? undefined,
  });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { server, api, tools, kv };
}

function parseResult(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text result");
  return JSON.parse(first.text);
}

describe("registerDocsTools", () => {
  it("registers exactly the expected tool names", () => {
    const { tools } = setupServer();
    expect(Object.keys(tools).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("attaches a non-empty description to every tool", () => {
    const { tools } = setupServer();
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(tools[name]?.description, `${name} missing description`).toBeTruthy();
    }
  });
});

describe("listCollections", () => {
  it("returns the collections envelope with usage hint", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      collections: { page: 1, pages: 1, count: 1, items: [{ id: "c1", name: "General" }] },
    });

    const result = await tools.listCollections.handler(
      { visibility: "all", order: "asc", page: 1 },
      {},
    );
    const payload = parseResult(result) as { items: unknown[]; usage: string };
    expect(payload.items).toHaveLength(1);
    expect(payload.usage).toContain("getCollection");
  });
});

describe("searchArticles", () => {
  it("passes query and collectionId through to the API", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({ articles: { page: 1, pages: 1, count: 0, items: [] } });

    await tools.searchArticles.handler(
      { query: "refund policy", collectionId: "c1", status: "all", visibility: "all", page: 1 },
      {},
    );

    expect(api.get).toHaveBeenCalledWith(
      "/search/articles",
      expect.objectContaining({ query: "refund policy", collectionId: "c1" }),
    );
  });
});

describe("createArticle", () => {
  it("defaults to notpublished when the tool default is used", async () => {
    const { api, tools } = setupServer();
    api.write.mockResolvedValue({ location: "https://docsapi.helpscout.net/v1/articles/a1" });

    const result = await tools.createArticle.handler(
      { collectionId: "c1", name: "New Article", text: "Body", status: "notpublished" },
      {},
    );

    expect(api.write).toHaveBeenCalledWith(
      "POST",
      "/articles?reload=true",
      expect.objectContaining({ collectionId: "c1", status: "notpublished" }),
    );
    const payload = parseResult(result) as { success: boolean };
    expect(payload.success).toBe(true);
  });
});

describe("updateArticle", () => {
  it("sends only the provided fields", async () => {
    const { api, tools } = setupServer();
    api.write.mockResolvedValue({});

    await tools.updateArticle.handler({ articleId: "a1", status: "published" }, {});

    expect(api.write).toHaveBeenCalledWith("PUT", "/articles/a1", { status: "published" });
  });
});

describe("deleteArticle", () => {
  it("calls DELETE on the article endpoint", async () => {
    const { api, tools } = setupServer();
    api.write.mockResolvedValue({});

    await tools.deleteArticle.handler({ articleId: "a1" }, {});

    expect(api.write).toHaveBeenCalledWith("DELETE", "/articles/a1");
  });
});

describe("error handling", () => {
  it("surfaces HelpScoutApiError as an isError CallToolResult", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new HelpScoutApiError("REAUTH_REQUIRED", "no key", 401));

    const result = await tools.listCollections.handler(
      { visibility: "all", order: "asc", page: 1 },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string };
    expect(payload.error).toBe("REAUTH_REQUIRED");
  });
});

describe("createArticleImageUpload", () => {
  it("returns an absolute uploadUrl, a token, and an expiry", async () => {
    const { api, tools, kv } = setupServer();
    api.get.mockResolvedValue({ article: { id: "42", name: "Refunds" } });

    const result = await tools.createArticleImageUpload.handler({ articleId: "42" }, {});
    const payload = parseResult(result) as {
      uploadUrl: string;
      uploadToken: string;
      expiresAt: string;
      articleId: string;
      usage: string;
    };

    expect(payload.uploadUrl).toBe("https://hs-mcp.example.com/docs/assets/upload");
    expect(payload.uploadToken).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.articleId).toBe("42");
    expect(Date.parse(payload.expiresAt)).not.toBeNaN();
    expect(kv.store.has(`upload:${payload.uploadToken}`)).toBe(true);
  });

  it("verifies the article exists before minting a token", async () => {
    const { api, tools, kv } = setupServer();
    api.get.mockRejectedValue(new HelpScoutApiError("NOT_FOUND", "no such article", 404));

    const result = await tools.createArticleImageUpload.handler({ articleId: "999" }, {});

    expect(result.isError).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/articles/999");
    expect(kv.store.size).toBe(0);
  });

  it("mints against the resolved article id when the caller passes an article number", async () => {
    const { api, tools, kv } = setupServer();
    // GET /articles/{id or number} accepts both; POST /assets/article takes
    // only the id, so the number must not reach the token record.
    api.get.mockResolvedValue({ article: { id: "5215163545667acd25394b5c", number: 121 } });

    const result = await tools.createArticleImageUpload.handler({ articleId: "121" }, {});
    const payload = parseResult(result) as { uploadToken: string; articleId: string };

    expect(api.get).toHaveBeenCalledWith("/articles/121");
    expect(payload.articleId).toBe("5215163545667acd25394b5c");
    expect(JSON.parse(kv.store.get(`upload:${payload.uploadToken}`) as string)).toMatchObject({
      articleId: "5215163545667acd25394b5c",
    });
  });

  it("falls back to the caller's articleId when the article payload carries no id", async () => {
    const { api, tools, kv } = setupServer();
    api.get.mockResolvedValue({ article: { name: "Refunds" } });

    const result = await tools.createArticleImageUpload.handler({ articleId: "42" }, {});
    const payload = parseResult(result) as { uploadToken: string; articleId: string };

    expect(payload.articleId).toBe("42");
    expect(JSON.parse(kv.store.get(`upload:${payload.uploadToken}`) as string)).toMatchObject({
      articleId: "42",
    });
  });

  it("fails with REAUTH_REQUIRED when no Docs API key is on file", async () => {
    const { api, tools, kv } = setupServer();
    api.hasApiKey.mockResolvedValue(false);

    const result = await tools.createArticleImageUpload.handler({ articleId: "42" }, {});
    const payload = parseResult(result) as { error: string };

    expect(result.isError).toBe(true);
    expect(payload.error).toBe("REAUTH_REQUIRED");
    expect(api.get).not.toHaveBeenCalled();
    expect(kv.store.size).toBe(0);
  });

  it("binds the supplied fileName into the token record", async () => {
    const { api, tools, kv } = setupServer();
    api.get.mockResolvedValue({ article: { id: "42" } });

    const result = await tools.createArticleImageUpload.handler(
      { articleId: "42", fileName: "diagram.png" },
      {},
    );
    const { uploadToken } = parseResult(result) as { uploadToken: string };

    expect(JSON.parse(kv.store.get(`upload:${uploadToken}`) as string)).toEqual({
      email: "tester@example.com",
      articleId: "42",
      fileName: "diagram.png",
    });
  });

  it("falls back to a relative uploadUrl when the origin is unknown", async () => {
    const { api, tools } = setupServer(null);
    api.get.mockResolvedValue({ article: { id: "42" } });

    const result = await tools.createArticleImageUpload.handler({ articleId: "42" }, {});
    const payload = parseResult(result) as { uploadUrl: string };
    expect(payload.uploadUrl).toBe("/docs/assets/upload");
  });

  it("tells the agent to batch every image into one updateArticle call", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({ article: { id: "42" } });

    expect(tools.createArticleImageUpload.description).toContain("one updateArticle");

    const result = await tools.createArticleImageUpload.handler({ articleId: "42" }, {});
    const payload = parseResult(result) as { usage: string };
    expect(payload.usage).toContain("one updateArticle");
  });
});
