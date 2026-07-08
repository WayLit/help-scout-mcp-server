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

function setupServer() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const api = fakeApi();
  registerDocsTools(server, api as never);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { server, api, tools };
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

    const result = await tools.listCollections.handler({ visibility: "all", order: "asc", page: 1 }, {});
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string };
    expect(payload.error).toBe("REAUTH_REQUIRED");
  });
});
