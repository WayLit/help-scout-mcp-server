import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { HelpScoutApiError } from "../helpscout-api";
import { configureRedaction } from "../redaction";
import { SearchConversationsShape } from "../schemas";
import { registerTools } from "../tools";

const EXPECTED_TOOL_NAMES = [
  "searchConversations",
  "getConversationSummary",
  "gatherReplyContext",
  "draftReply",
  "getThreads",
  "whoami",
  "getServerTime",
  "listAllInboxes",
  "updateConversationStatus",
  "assignConversation",
  "moveConversation",
  "createDraftConversation",
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
    post: vi.fn(),
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

describe("listAllInboxes", () => {
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

    const result = await tools.listAllInboxes.handler({ query: "support", limit: 100 }, {});
    const payload = parseResult(result) as {
      inboxes: Array<{ id: number; name: string }>;
      totalInboxes: number;
      totalAvailable: number;
    };

    expect(api.get).toHaveBeenCalledWith("/mailboxes", { page: 1, size: 100 });
    expect(payload.inboxes.map((r) => r.id)).toEqual([1, 3]);
    expect(payload.totalInboxes).toBe(2);
    expect(payload.totalAvailable).toBe(3);
  });

  it("returns every inbox when query is empty", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: {
        mailboxes: [
          { id: 1, name: "Support" },
          { id: 2, name: "Billing" },
        ],
      },
    });

    const result = await tools.listAllInboxes.handler({ query: "", limit: 100 }, {});
    const payload = parseResult(result) as { inboxes: unknown[]; totalInboxes: number };
    expect(payload.inboxes).toHaveLength(2);
    expect(payload.totalInboxes).toBe(2);
  });

  it("returns an empty result set with a helpful hint when nothing matches", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({ _embedded: { mailboxes: [{ id: 1, name: "Support" }] } });

    const result = await tools.listAllInboxes.handler({ query: "nothing", limit: 100 }, {});
    const payload = parseResult(result) as { inboxes: unknown[]; usage: string };
    expect(payload.inboxes).toEqual([]);
    expect(payload.usage).toMatch(/No inboxes matched/);
  });
});

describe("SearchConversationsShape", () => {
  const schema = z.object(SearchConversationsShape);

  it("accepts a status array and rejects an empty one", () => {
    expect(schema.safeParse({ status: ["active", "closed"] }).success).toBe(true);
    expect(schema.safeParse({ status: [] }).success).toBe(false);
  });

  it("accepts the structured sort fields", () => {
    expect(schema.safeParse({ sort: "waitingSince" }).success).toBe(true);
    expect(schema.safeParse({ sort: "customerEmail" }).success).toBe(true);
  });

  it("accepts tags as an array and rejects a bare string", () => {
    expect(schema.safeParse({ tags: ["urgent"] }).success).toBe(true);
    expect(schema.safeParse({ tags: "urgent" }).success).toBe(false);
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

describe("searchConversations cursor pagination", () => {
  const emptyPage = { _embedded: { conversations: [] }, page: { totalElements: 0 } };

  it("advances to the requested page for a numeric cursor with status set", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { status: "active", cursor: "3", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    const [, params] = api.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.page).toBe(3);
  });

  it("fetches the page URL directly for a URL cursor with status set", async () => {
    const { api, tools } = setupServer();
    const nextHref = "https://api.helpscout.net/v2/conversations?page=2&status=active";
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { status: "active", cursor: nextHref, limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(nextHref);
  });

  it("rejects a URL cursor when status is not set (ambiguous multi-status merge)", async () => {
    const { tools } = setupServer();
    const nextHref = "https://api.helpscout.net/v2/conversations?page=2";

    const result = await tools.searchConversations.handler(
      { cursor: nextHref, limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
  });

  it("rejects a non-numeric, non-URL cursor", async () => {
    const { tools } = setupServer();

    const result = await tools.searchConversations.handler(
      { status: "active", cursor: "not-a-page", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
  });

  it("rejects a cursor URL pointing at a non-Help Scout host (SSRF)", async () => {
    const { api, tools } = setupServer();

    const result = await tools.searchConversations.handler(
      {
        status: "active",
        cursor: "https://attacker.example.com/steal?token=1",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("rejects a cursor URL with a Help Scout-lookalike host (SSRF)", async () => {
    const { api, tools } = setupServer();

    const result = await tools.searchConversations.handler(
      {
        status: "active",
        cursor: "https://api.helpscout.net.attacker.com/v2/conversations?page=2",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("applies a numeric cursor to both parallel status calls in the default merge", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { cursor: "2", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    for (const call of api.get.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.page).toBe(2);
    }
  });

  it("surfaces nextCursor from the API response for single-status search", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: { conversations: [] },
      page: { totalElements: 0 },
      _links: { next: { href: "https://api.helpscout.net/v2/conversations?page=2" } },
    });

    const result = await tools.searchConversations.handler(
      { status: "active", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    const payload = parseResult(result) as { nextCursor?: string };
    expect(payload.nextCursor).toBe("https://api.helpscout.net/v2/conversations?page=2");
  });
});

describe("searchConversations structural cursor pagination", () => {
  const page = { _embedded: { conversations: [] }, page: { totalElements: 0 } };

  it("advances to the requested page for a numeric cursor", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(page);

    await tools.searchConversations.handler(
      { assignedTo: 1, cursor: "4", status: "all", sort: "createdAt", order: "desc", limit: 50 },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    const [, params] = api.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.page).toBe(4);
  });

  it("fetches the page URL directly for a URL cursor", async () => {
    const { api, tools } = setupServer();
    const nextHref = "https://api.helpscout.net/v2/conversations?page=2&assigned_to=1";
    api.get.mockResolvedValue(page);

    await tools.searchConversations.handler(
      {
        assignedTo: 1,
        cursor: nextHref,
        status: "all",
        sort: "createdAt",
        order: "desc",
        limit: 50,
      },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(nextHref);
  });

  it("rejects a non-numeric, non-URL cursor", async () => {
    const { tools } = setupServer();

    const result = await tools.searchConversations.handler(
      {
        assignedTo: 1,
        cursor: "bogus",
        status: "all",
        sort: "createdAt",
        order: "desc",
        limit: 50,
      },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
  });

  it("rejects a URL cursor on a multi-status sweep", async () => {
    const { tools } = setupServer();

    const result = await tools.searchConversations.handler(
      {
        cursor: "https://api.helpscout.net/v2/conversations?page=2",
        status: ["active", "closed"],
        sort: "createdAt",
        order: "desc",
        limit: 50,
      },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
  });
});

describe("gatherReplyContext", () => {
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

    const result = await tools.gatherReplyContext.handler(
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

  it("keeps operator guidance in its own trusted field, not concatenated with customer content", async () => {
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

    const result = await tools.gatherReplyContext.handler(
      { conversationId: "100", historyLimit: 0, guidance: "Keep it under 3 sentences." },
      {},
    );
    const payload = parseResult(result) as {
      draftingInstructions: string;
      operatorGuidance: string | null;
    };
    expect(payload.operatorGuidance).toBe("Keep it under 3 sentences.");
    // Untrusted customer content and operator guidance must stay separated:
    // guidance is never spliced into the instruction prose.
    expect(payload.draftingInstructions).not.toContain("Keep it under 3 sentences.");
    expect(payload.draftingInstructions).toMatch(/untrusted content written by the customer/i);
  });
});

describe("draftReply", () => {
  it("saves a draft reply and returns the new thread id", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      id: 100,
      number: 5,
      subject: "Login broken",
      status: "pending",
      customer: { id: 7, firstName: "Ada", lastName: "L", email: "ada@x.com" },
    });
    api.post.mockResolvedValue({
      data: {},
      headers: new Headers({ "Resource-Id": "567" }),
    });

    const result = await tools.draftReply.handler(
      { conversationId: "100", replyText: "Thanks for reaching out!" },
      {},
    );

    expect(api.post).toHaveBeenCalledWith(
      "/conversations/100/reply",
      {
        customer: { id: 7 },
        text: "Thanks for reaching out!",
        draft: true,
        status: "pending",
      },
      { invalidate: ["/conversations/100", "/conversations/100/threads"] },
    );
    const payload = parseResult(result) as {
      success: boolean;
      conversationId: string;
      threadId: number | null;
    };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe("100");
    expect(payload.threadId).toBe(567);
  });

  it("errors without calling post when the conversation has no customer", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      id: 100,
      number: 5,
      subject: "Hi",
      status: "active",
      customer: null,
    });

    const result = await tools.draftReply.handler(
      { conversationId: "100", replyText: "Hi there" },
      {},
    );

    expect(api.post).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("INVALID_INPUT");
    expect(payload.tool).toBe("draftReply");
  });

  it("surfaces a Help Scout API error as an isError result", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new HelpScoutApiError("NOT_FOUND", "no such conversation", 404));

    const result = await tools.draftReply.handler(
      { conversationId: "99999", replyText: "Hi" },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.tool).toBe("draftReply");
  });
});

describe("PII redaction in read tools", () => {
  beforeEach(() => {
    configureRedaction({ REDACT_PII: "true" } as never);
  });

  it("tokenizes embedded customer email but leaves names intact in conversation search results", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: {
        conversations: [
          {
            id: 1,
            createdAt: "2026-01-01T00:00:00Z",
            customer: { id: 7, firstName: "Ada", lastName: "Lovelace", email: "ada@x.com" },
          },
        ],
      },
      page: { totalElements: 1 },
    });

    const result = await tools.searchConversations.handler(
      { status: "active", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );
    const payload = parseResult(result) as {
      results: Array<{ customer: { firstName: string; lastName: string; email: string } }>;
    };
    expect(payload.results[0].customer.firstName).toBe("Ada");
    expect(payload.results[0].customer.lastName).toBe("Lovelace");
    expect(payload.results[0].customer.email).toBe("[EMAIL_REDACTED]");
  });

  it("tokenizes all contact channel values in getCustomerContacts", async () => {
    const { api, tools } = setupServer();
    api.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/emails"))
        return { _embedded: { emails: [{ id: 1, value: "ada@x.com", type: "home" }] } };
      if (endpoint.endsWith("/phones"))
        return { _embedded: { phones: [{ id: 2, value: "+15551234", type: "mobile" }] } };
      if (endpoint.endsWith("/chats"))
        return { _embedded: { chats: [{ id: 3, value: "ada#1234", type: "aim" }] } };
      if (endpoint.endsWith("/social-profiles"))
        return { _embedded: { social_profiles: [{ id: 4, value: "@ada", type: "twitter" }] } };
      if (endpoint.endsWith("/websites"))
        return { _embedded: { websites: [{ id: 5, value: "ada.dev" }] } };
      if (endpoint.endsWith("/address"))
        return { city: "London", state: "X", postalCode: "EC1", lines: ["1 Main St"] };
      return {};
    });

    const result = await tools.getCustomerContacts.handler({ customerId: "7" }, {});
    const payload = parseResult(result) as {
      emails: Array<{ value: string }>;
      phones: Array<{ value: string }>;
      chats: Array<{ value: string }>;
      socialProfiles: Array<{ value: string }>;
      websites: Array<{ value: string }>;
      address: { city: string; lines: string[] };
    };
    expect(payload.emails[0].value).toBe("[EMAIL_REDACTED]");
    expect(payload.phones[0].value).toBe("[PHONE_REDACTED]");
    expect(payload.chats[0].value).toBe("[CHAT_REDACTED]");
    expect(payload.socialProfiles[0].value).toBe("[SOCIAL_REDACTED]");
    expect(payload.websites[0].value).toBe("[WEBSITE_REDACTED]");
    expect(payload.address.city).toBe("[CITY_REDACTED]");
    expect(payload.address.lines[0]).toBe("[ADDRESS_REDACTED]");
  });

  it("tokenizes primaryEmail but leaves names intact in listCustomers results", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: {
        customers: [
          {
            id: 7,
            firstName: "Ada",
            lastName: "Lovelace",
            _embedded: { emails: [{ id: 1, value: "ada@x.com" }] },
          },
        ],
      },
      page: { totalElements: 1 },
    });

    const result = await tools.listCustomers.handler(
      { page: 1, sortField: "createdAt", sortOrder: "desc" },
      {},
    );
    const payload = parseResult(result) as {
      results: Array<{ firstName: string; lastName: string; primaryEmail: string }>;
    };
    expect(payload.results[0].firstName).toBe("Ada");
    expect(payload.results[0].lastName).toBe("Lovelace");
    expect(payload.results[0].primaryEmail).toBe("[EMAIL_REDACTED]");
  });

  it("leaves customer fields intact when redaction is disabled", async () => {
    configureRedaction({ REDACT_PII: "false" } as never);
    const { api, tools } = setupServer();
    api.get.mockResolvedValue({
      _embedded: {
        conversations: [
          { id: 1, createdAt: "2026-01-01T00:00:00Z", customer: { id: 7, firstName: "Ada" } },
        ],
      },
      page: { totalElements: 1 },
    });

    const result = await tools.searchConversations.handler(
      { status: "active", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );
    const payload = parseResult(result) as {
      results: Array<{ customer: { firstName: string } }>;
    };
    expect(payload.results[0].customer.firstName).toBe("Ada");
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

describe("assignConversation", () => {
  it("issues a JSONPatch replace op for /assignTo and reports success", async () => {
    const { api, tools } = setupServer();
    api.patch.mockResolvedValue({});

    const result = await tools.assignConversation.handler(
      { conversationId: "12345", userId: 42 },
      {},
    );

    expect(api.patch).toHaveBeenCalledWith("/conversations/12345", {
      op: "replace",
      path: "/assignTo",
      value: 42,
    });
    const payload = parseResult(result) as {
      success: boolean;
      conversationId: string;
      userId: number;
    };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe("12345");
    expect(payload.userId).toBe(42);
  });

  it("issues a JSONPatch remove op for /assignTo when userId is omitted", async () => {
    const { api, tools } = setupServer();
    api.patch.mockResolvedValue({});

    const result = await tools.assignConversation.handler({ conversationId: "12345" }, {});

    expect(api.patch).toHaveBeenCalledWith("/conversations/12345", {
      op: "remove",
      path: "/assignTo",
    });
    const payload = parseResult(result) as { success: boolean; conversationId: string };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe("12345");
  });

  it("surfaces a Help Scout API error as an isError result", async () => {
    const { api, tools } = setupServer();
    api.patch.mockRejectedValue(new HelpScoutApiError("NOT_FOUND", "no such conversation", 404));

    const result = await tools.assignConversation.handler(
      { conversationId: "99999", userId: 1 },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.tool).toBe("assignConversation");
  });
});

describe("moveConversation", () => {
  it("issues a JSONPatch move op for /mailboxId and reports success", async () => {
    const { api, tools } = setupServer();
    api.patch.mockResolvedValue({});

    const result = await tools.moveConversation.handler(
      { conversationId: "12345", mailboxId: 456 },
      {},
    );

    expect(api.patch).toHaveBeenCalledWith("/conversations/12345", {
      op: "move",
      path: "/mailboxId",
      value: 456,
    });
    const payload = parseResult(result) as {
      success: boolean;
      conversationId: string;
      mailboxId: number;
    };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe("12345");
    expect(payload.mailboxId).toBe(456);
  });

  it("surfaces a Help Scout API error as an isError result", async () => {
    const { api, tools } = setupServer();
    api.patch.mockRejectedValue(new HelpScoutApiError("NOT_FOUND", "no such conversation", 404));

    const result = await tools.moveConversation.handler(
      { conversationId: "99999", mailboxId: 456 },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.tool).toBe("moveConversation");
  });
});

describe("createDraftConversation", () => {
  it("creates a draft conversation from an existing customerId", async () => {
    const { api, tools } = setupServer();
    api.post.mockResolvedValue({
      data: {},
      headers: new Headers({
        "Resource-Id": "12345",
        "Web-Location": "https://secure.helpscout.net/conversation/12345/",
      }),
    });

    const result = await tools.createDraftConversation.handler(
      { mailboxId: 85, customerId: 7, subject: "Following up", text: "Just checking in!" },
      {},
    );

    expect(api.post).toHaveBeenCalledWith(
      "/conversations",
      {
        subject: "Following up",
        type: "email",
        status: "active",
        mailboxId: 85,
        customer: { id: 7 },
        threads: [{ type: "reply", customer: { id: 7 }, text: "Just checking in!", draft: true }],
      },
      { invalidate: ["/conversations"] },
    );
    const payload = parseResult(result) as {
      success: boolean;
      conversationId: number | null;
      webLocation: string | null;
    };
    expect(result.isError).toBeFalsy();
    expect(payload.success).toBe(true);
    expect(payload.conversationId).toBe(12345);
    expect(payload.webLocation).toBe("https://secure.helpscout.net/conversation/12345/");
  });

  it("finds-or-creates the customer by email, name, and tags when customerId is omitted", async () => {
    const { api, tools } = setupServer();
    api.post.mockResolvedValue({ data: {}, headers: new Headers({ "Resource-Id": "999" }) });

    await tools.createDraftConversation.handler(
      {
        mailboxId: 85,
        customerEmail: "bear@acme.com",
        customerFirstName: "Vernon",
        customerLastName: "Bear",
        subject: "Welcome",
        text: "Hi there",
        tags: ["vip"],
      },
      {},
    );

    expect(api.post).toHaveBeenCalledWith(
      "/conversations",
      {
        subject: "Welcome",
        type: "email",
        status: "active",
        mailboxId: 85,
        customer: { email: "bear@acme.com", firstName: "Vernon", lastName: "Bear" },
        threads: [
          {
            type: "reply",
            customer: { email: "bear@acme.com", firstName: "Vernon", lastName: "Bear" },
            text: "Hi there",
            draft: true,
          },
        ],
        tags: ["vip"],
      },
      { invalidate: ["/conversations"] },
    );
  });

  it("errors without calling post when neither customerId nor customerEmail is given", async () => {
    const { api, tools } = setupServer();

    const result = await tools.createDraftConversation.handler(
      { mailboxId: 85, subject: "Hi", text: "Hi there" },
      {},
    );

    expect(api.post).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("INVALID_INPUT");
    expect(payload.tool).toBe("createDraftConversation");
  });

  it("surfaces a Help Scout API error as an isError result", async () => {
    const { api, tools } = setupServer();
    api.post.mockRejectedValue(new HelpScoutApiError("UPSTREAM_ERROR", "boom", 500));

    const result = await tools.createDraftConversation.handler(
      { mailboxId: 85, customerId: 7, subject: "Hi", text: "Hi there" },
      {},
    );
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBe("UPSTREAM_ERROR");
    expect(payload.tool).toBe("createDraftConversation");
  });

  it("uses customerId when both customerId and customerEmail are provided (precedence)", async () => {
    const { api, tools } = setupServer();
    api.post.mockResolvedValue({
      data: {},
      headers: new Headers({ "Resource-Id": "999" }),
    });

    await tools.createDraftConversation.handler(
      {
        mailboxId: 85,
        customerId: 7,
        customerEmail: "different@acme.com",
        subject: "Test",
        text: "Testing precedence",
      },
      {},
    );

    expect(api.post).toHaveBeenCalledWith(
      "/conversations",
      expect.objectContaining({
        customer: { id: 7 },
        threads: [
          expect.objectContaining({
            customer: { id: 7 },
          }),
        ],
      }),
      { invalidate: ["/conversations"] },
    );
  });

  it("treats customerId: 0 as a valid customer ID, not as missing", async () => {
    const { api, tools } = setupServer();
    api.post.mockResolvedValue({
      data: {},
      headers: new Headers({ "Resource-Id": "888" }),
    });

    const result = await tools.createDraftConversation.handler(
      { mailboxId: 85, customerId: 0, subject: "Test", text: "Testing zero ID" },
      {},
    );

    // Should not error; customerId: 0 is valid
    expect(result.isError).toBeFalsy();
    expect(api.post).toHaveBeenCalledWith(
      "/conversations",
      expect.objectContaining({
        customer: { id: 0 },
        threads: [
          expect.objectContaining({
            customer: { id: 0 },
          }),
        ],
      }),
      { invalidate: ["/conversations"] },
    );
    const payload = parseResult(result) as { success: boolean };
    expect(payload.success).toBe(true);
  });
});

describe("error handling", () => {
  it("wraps HelpScoutApiError as an isError result with the error code", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new HelpScoutApiError("RATE_LIMIT", "rate limited", 429, 30));

    const result = await tools.listAllInboxes.handler({ query: "", limit: 100 }, {});
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
    expect(payload.tool).toBe("listAllInboxes");
    expect(payload.requestId).toBeTruthy();
  });

  it("wraps generic errors into an INTERNAL_ERROR envelope", async () => {
    const { api, tools } = setupServer();
    api.get.mockRejectedValue(new Error("boom"));

    const result = await tools.listAllInboxes.handler({ query: "", limit: 100 }, {});
    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: string; tool: string };
    expect(payload.error).toBeTruthy();
    expect(payload.tool).toBe("listAllInboxes");
  });
});

describe("searchConversations merged filters", () => {
  const emptyPage = { _embedded: { conversations: [] }, page: { totalElements: 0 } };

  function paramsOf(api: ReturnType<typeof fakeApi>, call = 0): Record<string, unknown> {
    return api.get.mock.calls[call][1] as Record<string, unknown>;
  }

  it("compiles contentTerms into body query syntax", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { contentTerms: ["refund"], status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(paramsOf(api).query).toBe('(body:"refund")');
  });

  it("searches both subject and body for searchTerms", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { searchTerms: ["refund"], status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(paramsOf(api).query).toBe('(body:"refund" OR subject:"refund")');
  });

  it("ANDs a raw query with compiled convenience filters", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      {
        query: 'tag:"vip"',
        subjectTerms: ["invoice"],
        status: "all",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    expect(paramsOf(api).query).toBe('(tag:"vip") AND (subject:"invoice")');
  });

  it("passes a single tag as the native tag parameter", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { tags: ["urgent"], status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(paramsOf(api).tag).toBe("urgent");
    expect(paramsOf(api).query).toBeUndefined();
  });

  it("compiles multiple tags into query syntax instead", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { tags: ["urgent", "vip"], status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(paramsOf(api).tag).toBeUndefined();
    expect(paramsOf(api).query).toBe('(tag:"urgent" OR tag:"vip")');
  });

  it("passes structural filters as native request parameters", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      {
        assignedTo: 7,
        folderId: 3,
        conversationNumber: 12345,
        modifiedSince: "2026-01-01T00:00:00Z",
        status: "all",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    const params = paramsOf(api);
    expect(params.assigned_to).toBe(7);
    expect(params.folder).toBe(3);
    expect(params.number).toBe(12345);
    expect(params.modifiedSince).toBe("2026-01-01T00:00:00Z");
  });

  it("sweeps every status in a status array and merges the results", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    const result = await tools.searchConversations.handler(
      {
        contentTerms: ["bug"],
        status: ["active", "pending", "closed"],
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    const queried = api.get.mock.calls
      .map((c) => (c[1] as { status?: string } | undefined)?.status)
      .filter((s): s is string => typeof s === "string");
    expect(queried.sort()).toEqual(["active", "closed", "pending"]);

    const payload = parseResult(result) as { searchInfo: { statusesSearched: string[] } };
    expect(payload.searchInfo.statusesSearched.sort()).toEqual([
      "active",
      "closed",
      "pending",
    ]);
  });

  it("issues one native request for status:\"all\"", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(paramsOf(api).status).toBe("all");
  });

  it("echoes the structural filters it applied", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    const result = await tools.searchConversations.handler(
      { conversationNumber: 999, status: "all", limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    const payload = parseResult(result) as {
      searchInfo: { filtersApplied?: { conversationNumber?: number } };
    };
    expect(payload.searchInfo.filtersApplied?.conversationNumber).toBe(999);
  });

  it("accepts the widened sort enum", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { status: "all", limit: 50, sort: "waitingSince", order: "asc" },
      {},
    );

    expect(paramsOf(api).sortField).toBe("waitingSince");
    expect(paramsOf(api).sortOrder).toBe("asc");
  });

  it("rejects a page-URL cursor for a multi-status array", async () => {
    const { api, tools } = setupServer();

    const result = await tools.searchConversations.handler(
      {
        status: ["active", "closed"],
        cursor: "https://api.helpscout.net/v2/conversations?page=2",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    const payload = parseResult(result) as { error?: string };
    expect(result.isError).toBe(true);
    expect(payload.error).toBe("INVALID_INPUT");
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("searchConversations conversationNumber lookup", () => {
  const emptyPage = { _embedded: { conversations: [] }, page: { totalElements: 0 } };

  function queriedStatuses(api: ReturnType<typeof fakeApi>): string[] {
    return api.get.mock.calls
      .map((c) => (c[1] as { status?: string } | undefined)?.status)
      .filter((s): s is string => typeof s === "string");
  }

  it("searches every status when only a conversationNumber is given", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { conversationNumber: 12345, limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(queriedStatuses(api)).toEqual(["all"]);
  });

  it("lets an explicit status win over the conversationNumber default", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      {
        conversationNumber: 12345,
        status: "active",
        limit: 50,
        sort: "createdAt",
        order: "desc",
      },
      {},
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(queriedStatuses(api)).toEqual(["active"]);
  });

  it("leaves the active+pending default alone for searches without a conversationNumber", async () => {
    const { api, tools } = setupServer();
    api.get.mockResolvedValue(emptyPage);

    await tools.searchConversations.handler(
      { searchTerms: ["refund"], limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    expect(queriedStatuses(api).sort()).toEqual(["active", "pending"]);
    expect(queriedStatuses(api)).not.toContain("all");
    expect(queriedStatuses(api)).not.toContain("closed");
  });
});

describe("searchConversations merged ordering", () => {
  function pageOf(conversations: Array<Record<string, unknown>>) {
    return {
      _embedded: { conversations },
      page: { totalElements: conversations.length },
    };
  }

  it("orders the merged window by the requested sort field and direction", async () => {
    const { api, tools } = setupServer();
    api.get
      .mockResolvedValueOnce(pageOf([{ id: 1, number: 30, createdAt: "2026-01-03T00:00:00Z" }]))
      .mockResolvedValueOnce(
        pageOf([
          { id: 2, number: 10, createdAt: "2026-01-01T00:00:00Z" },
          { id: 3, number: 20, createdAt: "2026-01-02T00:00:00Z" },
        ]),
      );

    const result = await tools.searchConversations.handler(
      { status: ["active", "pending"], limit: 50, sort: "number", order: "asc" },
      {},
    );

    const payload = parseResult(result) as { results: Array<{ number: number }> };
    expect(payload.results.map((r) => r.number)).toEqual([10, 20, 30]);
  });

  it("still returns createdAt desc for the default merged search", async () => {
    const { api, tools } = setupServer();
    api.get
      .mockResolvedValueOnce(pageOf([{ id: 1, number: 30, createdAt: "2026-01-01T00:00:00Z" }]))
      .mockResolvedValueOnce(
        pageOf([
          { id: 2, number: 10, createdAt: "2026-01-03T00:00:00Z" },
          { id: 3, number: 20, createdAt: "2026-01-02T00:00:00Z" },
        ]),
      );

    const result = await tools.searchConversations.handler(
      { limit: 50, sort: "createdAt", order: "desc" },
      {},
    );

    const payload = parseResult(result) as { results: Array<{ id: number }> };
    expect(payload.results.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("leaves the as-fetched order alone for a sort with no client-side field", async () => {
    const { api, tools } = setupServer();
    api.get
      .mockResolvedValueOnce(pageOf([{ id: 1, number: 30, createdAt: "2026-01-01T00:00:00Z" }]))
      .mockResolvedValueOnce(
        pageOf([
          { id: 2, number: 10, createdAt: "2026-01-03T00:00:00Z" },
          { id: 3, number: 20, createdAt: "2026-01-02T00:00:00Z" },
        ]),
      );

    const result = await tools.searchConversations.handler(
      { status: ["active", "pending"], limit: 50, sort: "waitingSince", order: "desc" },
      {},
    );

    // waitingSince isn't on the conversation payload, so the merged list keeps
    // the per-request API order rather than being re-sorted by something else.
    const payload = parseResult(result) as { results: Array<{ id: number }> };
    expect(payload.results.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
