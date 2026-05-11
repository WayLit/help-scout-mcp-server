import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HelpScoutApiError } from "../helpscout-api";
import { configureRedaction } from "../redaction";
import { registerTools } from "../tools";

const EXPECTED_TOOL_NAMES = [
  "searchInboxes",
  "searchConversations",
  "getConversationSummary",
  "getThreads",
  "getServerTime",
  "listAllInboxes",
  "advancedConversationSearch",
  "comprehensiveConversationSearch",
  "structuredConversationFilter",
  "getCustomer",
  "listCustomers",
  "searchCustomersByEmail",
  "getCustomerContacts",
  "getOrganization",
  "listOrganizations",
  "getOrganizationMembers",
  "getOrganizationConversations",
];

type ToolHandler = (args: unknown, extra: unknown) => Promise<CallToolResult>;
type RegisteredTool = { description?: string; handler: ToolHandler };

function fakeApi() {
  return {
    get: vi.fn(),
    userEmail: "tester@example.com",
  };
}

function setupServer() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const api = fakeApi();
  registerTools(server, api as never);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { server, api, tools };
}

function parseResult(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text result");
  return JSON.parse(first.text);
}

beforeEach(() => {
  configureRedaction({ REDACT_PII: "false" } as never);
});

describe("registerTools", () => {
  it("registers exactly the expected 17 tool names", () => {
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

describe("getServerTime", () => {
  it("returns the current server time without hitting Help Scout", async () => {
    const { api, tools } = setupServer();
    const before = Date.now();
    const result = await tools.getServerTime.handler({}, {});
    const after = Date.now();

    const payload = parseResult(result) as { isoTime: string; unixTime: number };
    expect(new Date(payload.isoTime).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(payload.isoTime).getTime()).toBeLessThanOrEqual(after);
    expect(payload.unixTime).toBe(Math.floor(new Date(payload.isoTime).getTime() / 1000));
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("searchInboxes", () => {
  it("filters discovered inboxes by case-insensitive substring", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: {
        mailboxes: [
          { id: 1, name: "Support" },
          { id: 2, name: "Billing" },
          { id: 3, name: "Customer Support EU" },
        ],
      },
    });

    const result = await tools.searchInboxes.handler({ query: "support", limit: 50 }, {});
    const payload = parseResult(result) as {
      results: Array<{ id: number; name: string }>;
      totalFound: number;
      totalAvailable: number;
    };

    expect(api.get).toHaveBeenCalledWith("/mailboxes", { page: 1, size: 50 });
    expect(payload.results.map((r) => r.id)).toEqual([1, 3]);
    expect(payload.totalFound).toBe(2);
    expect(payload.totalAvailable).toBe(3);
  });

  it("returns an empty result set with a helpful hint when nothing matches", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({ _embedded: { mailboxes: [{ id: 1, name: "Support" }] } });

    const result = await tools.searchInboxes.handler({ query: "nothing", limit: 50 }, {});
    const payload = parseResult(result) as { results: unknown[]; usage: string };
    expect(payload.results).toEqual([]);
    expect(payload.usage).toMatch(/No inboxes matched/);
  });
});

describe("error handling", () => {
  it("wraps HelpScoutApiError as an isError result with the error code", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new HelpScoutApiError("RATE_LIMIT", "rate limited", 429, 30));

    const result = await tools.searchInboxes.handler({ query: "", limit: 50 }, {});
    expect(result.isError).toBe(true);

    const payload = parseResult(result) as {
      error: string;
      status: number;
      retryAfter: number;
      tool: string;
      requestId: string;
    };
    expect(payload.error).toBe("RATE_LIMIT");
    expect(payload.status).toBe(429);
    expect(payload.retryAfter).toBe(30);
    expect(payload.tool).toBe("searchInboxes");
    expect(payload.requestId).toBeTruthy();
  });

  it("wraps generic errors into an INTERNAL_ERROR envelope", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new Error("boom"));

    const result = await tools.searchInboxes.handler({ query: "", limit: 50 }, {});
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBeTruthy();
    expect(payload.tool).toBe("searchInboxes");
  });
});
