import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerTools } from "../tools";

/**
 * Bloat ceiling for the mailbox tool surface — not a target to hit, a limit
 * not to cross.
 *
 * Task 5 of the conversation-search-consolidation plan collapsed
 * `searchInboxes`, `advancedConversationSearch`, `comprehensiveConversationSearch`,
 * and `structuredConversationFilter` into `searchConversations` /
 * `listAllInboxes`, taking the surface from 24 tools down to 20. The plan
 * projected this would also shrink the serialized tool surface to roughly
 * 2,600 tokens; it didn't. Measured after the consolidation: 20 tools,
 * 12,827 chars, ~3,207 approx tokens — `searchConversations` alone accounts
 * for 3,355 of those chars (26% of the whole surface), because it now
 * carries the parameters of all four retired tools. That is the correct,
 * expected shape: trimming its `.describe()` text to chase a token budget
 * would make the merged tool harder to use correctly.
 *
 * This test exists to catch *future* bloat, not to enforce the abandoned
 * 2,600 target. The 3,300-token ceiling below leaves headroom over the
 * measured ~3,207 for incidental description wording changes, while still
 * failing if a future change (e.g. adding another tool, or a large new
 * parameter block) meaningfully grows the surface again.
 */
describe("mailbox tool surface", () => {
  it("stays at 20 tools and under the token bloat ceiling", () => {
    const server = new McpServer({ name: "surface-check", version: "0.0.0" });
    const api = { get: () => {}, post: () => {}, patch: () => {}, userEmail: "x@y.z" };
    registerTools(server, api as never);

    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string; inputSchema?: z.ZodTypeAny }>;
      }
    )._registeredTools;

    const entries = Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema
        ? z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" })
        : {},
    }));

    const json = JSON.stringify(entries);
    const approxTokens = Math.round(json.length / 4);

    expect(entries.length).toBe(20);
    expect(approxTokens).toBeLessThanOrEqual(3300);
  });
});
