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
  "draftReply",
  "getThreads",
  "whoami",
  "getServerTime",
  "listAllInboxes",
  "advancedConversationSearch",
  "comprehensiveConversationSearch",
  "structuredConversationFilter",
  "updateConversationStatus",
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
    patch: vi.fn(),
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
  it("registers exactly the expected 20 tool names", () => {
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

describe("whoami", () => {
  it("returns the authenticated Help Scout user and the access email", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      id: 12345,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@helpscout.example",
      role: "owner",
      type: "user",
      timezone: "America/New_York",
    });

    const result = await tools.whoami.handler({}, {});
    const payload = parseResult(result) as {
      user: { id: number; email: string; role: string };
      accessEmail: string;
    };

    expect(api.get).toHaveBeenCalledWith("/users/me");
    expect(payload.user.id).toBe(12345);
    expect(payload.user.email).toBe("ada@helpscout.example");
    expect(payload.user.role).toBe("owner");
    expect(payload.accessEmail).toBe("tester@example.com");
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

describe("searchConversations status defaults", () => {
  const emptyPage = { _embedded: { conversations: [] }, page: { totalElements: 0 } };

  function queriedStatuses(api: ReturnType<typeof fakeApi>): string[] {
    return api.get.mock.calls
      .map((c) => (c[1] as { status?: string } | undefined)?.status)
      .filter((s): s is string => typeof s === "string");
  }

  it("defaults to active+pending and never queries closed", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    const result = await tools.searchConversations.handler(
      { limit: 50, sort: "createdAt", order: "desc" },
      {},
    );
    const payload = parseResult(result) as {
      searchInfo: { statusesSearched: string[] };
    };

    expect(queriedStatuses(api).sort()).toEqual(["active", "pending"]);
    expect(queriedStatuses(api)).not.toContain("closed");
    expect(payload.searchInfo.statusesSearched.sort()).toEqual(["active", "pending"]);
  });

  it("searches only closed when status:\"closed\" is requested", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { status: "closed", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(queriedStatuses(api)).toEqual(["closed"]);
  });
});

describe("draftReply", () => {
  it("returns a brief with the latest customer message and resolved prior history", async () => {
    const { api, tools } = setupServer();
    api.get.mockImplementation(async (endpoint: string, params?: Record<string, unknown>) => {
      if (endpoint === "/conversations/100") {
        return {
          id: 100,
          number: 5,
          subject: "Login broken",
          status: "active",
          tags: [],
          assignee: null,
          customer: { id: 7, firstName: "Ada", lastName: "L", email: "ada@x.com" },
        };
      }
      if (endpoint === "/conversations/100/threads") {
        return {
          _embedded: {
            threads: [
              { id: 1, type: "customer", body: "I can't log in", createdAt: "2026-01-01T00:00:00Z", createdBy: null },
              { id: 2, type: "message", body: "Tried a reset?", createdAt: "2026-01-02T00:00:00Z", createdBy: { id: 9 } },
              { id: 3, type: "customer", body: "Still broken", createdAt: "2026-01-03T00:00:00Z", createdBy: null },
            ],
          },
        };
      }
      if (endpoint === "/conversations" && params?.query === "customerIds:7") {
        return {
          _embedded: {
            conversations: [
              { id: 100, number: 5, subject: "Login broken", status: "active", createdAt: "2026-01-01T00:00:00Z" },
              { id: 90, number: 4, subject: "Billing question", status: "closed", createdAt: "2025-12-01T00:00:00Z" },
            ],
          },
          page: { totalElements: 2 },
        };
      }
      if (endpoint === "/conversations/90/threads") {
        return {
          _embedded: {
            threads: [
              { id: 11, type: "customer", body: "Charged twice?", createdAt: "2025-12-01T00:00:00Z", createdBy: null },
              { id: 12, type: "message", body: "Refunded the duplicate.", createdAt: "2025-12-02T00:00:00Z", createdBy: { id: 9 } },
            ],
          },
        };
      }
      return {};
    });

    const result = await tools.draftReply.handler(
      { conversationId: "100", historyLimit: 5 },
      {},
    );
    const payload = parseResult(result) as {
      currentConversation: { id: number };
      latestCustomerMessage: { body: string } | null;
      customerHistory: Array<{ id: number; customerAsk: string | null; resolution: string | null }>;
      draftingInstructions: string;
    };

    expect(payload.currentConversation.id).toBe(100);
    expect(payload.latestCustomerMessage?.body).toBe("Still broken");
    // current conversation (100) is excluded; only the prior one (90) remains
    expect(payload.customerHistory.map((h) => h.id)).toEqual([90]);
    expect(payload.customerHistory[0].customerAsk).toBe("Charged twice?");
    expect(payload.customerHistory[0].resolution).toBe("Refunded the duplicate.");
    expect(payload.draftingInstructions).toMatch(/reply to the latest customer message/i);
  });

  it("threads optional guidance into the drafting instructions", async () => {
    const { api, tools } = setupServer();
    api.get.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/conversations/100") {
        return { id: 100, number: 5, subject: "Hi", status: "active", tags: [], assignee: null, customer: { id: 7 } };
      }
      if (endpoint === "/conversations/100/threads") {
        return { _embedded: { threads: [] } };
      }
      return { _embedded: { conversations: [] }, page: { totalElements: 0 } };
    });

    const result = await tools.draftReply.handler(
      { conversationId: "100", historyLimit: 0, guidance: "Keep it under 3 sentences." },
      {},
    );
    const payload = parseResult(result) as { draftingInstructions: string };
    expect(payload.draftingInstructions).toContain("Keep it under 3 sentences.");
  });
});

describe("updateConversationStatus", () => {
  it("issues a JSONPatch replace op for /status and reports success", async () => {
    const { api, tools } = setupServer();
    api.patch.mockResolvedValue({});

    const result = await tools.updateConversationStatus.handler(
      { conversationId: "12345", status: "closed" },
      {},
    );

    expect(api.patch).toHaveBeenCalledWith("/conversations/12345", {
      op: "replace",
      path: "/status",
      value: "closed",
    });
    const payload = parseResult(result) as {
      success: boolean;
      conversationId: string;
      status: string;
    };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe("12345");
    expect(payload.status).toBe("closed");
  });

  it("surfaces a Help Scout API error as an isError result", async () => {
    const { api, tools } = setupServer();
    api.patch.mockRejectedValue(new HelpScoutApiError("NOT_FOUND", "no such conversation", 404));

    const result = await tools.updateConversationStatus.handler(
      { conversationId: "99999", status: "active" },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.tool).toBe("updateConversationStatus");
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
