/**
 * Help Scout MCP prompt registrations.
 *
 * Ported from src/prompts/index.ts in the stdio server. Each prompt is
 * registered with the high-level McpServer.registerPrompt API.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

function userMessage(text: string): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

export function registerPrompts(server: McpServer): void {
  // ── helpscout-best-practices ─────────────────────────────────────────────
  server.registerPrompt(
    "helpscout-best-practices",
    {
      description:
        "Essential workflow guide for using Help Scout MCP effectively - START HERE for correct search patterns",
    },
    async () => ({
      description: "Essential workflow guide for using Help Scout MCP effectively",
      ...userMessage(`# Help Scout MCP Best Practices Guide

## Inbox Discovery

Use \`searchInboxes("")\` to list available inboxes. The result includes IDs you can pass as \`inboxId\` to conversation tools. Inbox IDs are numeric.

When a user mentions an inbox by name:
1. Call \`searchInboxes\` with a substring of the name
2. Use the returned id directly
3. If multiple match, ask the user to clarify

## Tool Selection Guide

Use \`comprehensiveConversationSearch\` when:
- Searching by keywords in conversation content
- User wants a broad search
- You need simple array input format

Use \`searchConversations\` when:
- You need Help Scout query syntax (body:, subject:, email:, etc.)
- You need custom sorting or field selection
- Simple listing without keywords

Use \`advancedConversationSearch\` when:
- You need complex boolean logic
- Searching by email domain
- Combining multiple search criteria

## Status Handling

Both \`searchConversations\` and \`comprehensiveConversationSearch\` search active+pending+closed by default. Specify \`status\` only when you want to narrow.

## Pitfalls

- Don't guess inbox IDs — always look them up via \`searchInboxes\`
- Default timeframe is 60 days; pass \`createdAfter\` if you need longer
- For ticket numbers (#12345), use \`structuredConversationFilter\``),
    }),
  );

  // ── search-last-7-days ───────────────────────────────────────────────────
  server.registerPrompt(
    "search-last-7-days",
    {
      description: "Search recent conversations across all inboxes from the last 7 days",
      argsSchema: {
        inboxId: z.string().optional().describe("Optional: specific inbox ID"),
        status: z
          .string()
          .optional()
          .describe("Optional: active, pending, closed, spam"),
        tag: z.string().optional().describe("Optional: filter by tag"),
      },
    },
    async ({ inboxId, status, tag }) =>
      userMessage(`To search for conversations from the last 7 days:

1. Call \`getServerTime\` to get the current timestamp.
2. Subtract 7 days to get \`createdAfter\`.
${inboxId ? "" : '3. If the user mentioned a specific inbox by name, call `searchInboxes` first to get its ID.\n'}
${inboxId ? "3" : "4"}. Call \`searchConversations\`:
\`\`\`json
{
  "createdAfter": "<7-days-ago-iso>",
  "limit": 50,
  "sort": "createdAt",
  "order": "desc"${inboxId ? `,\n  "inboxId": "${inboxId}"` : ""}${status ? `,\n  "status": "${status}"` : ""}${tag ? `,\n  "tag": "${tag}"` : ""}
}
\`\`\`

Use \`getConversationSummary\` for quick overviews or \`getThreads\` for full history.`),
  );

  // ── find-urgent-tags ─────────────────────────────────────────────────────
  server.registerPrompt(
    "find-urgent-tags",
    {
      description: "Find conversations with urgent or priority tags",
      argsSchema: {
        inboxId: z.string().optional().describe("Optional: specific inbox ID"),
        timeframe: z.string().optional().describe('Optional: e.g. "24h", "7d", "30d"'),
      },
    },
    async ({ inboxId, timeframe }) => {
      const timeNote = timeframe
        ? `\nUse \`getServerTime\` and subtract ${timeframe} to derive \`createdAfter\`.`
        : "";
      const inboxPart = inboxId ? `,\n  "inboxId": "${inboxId}"` : "";
      const datePart = timeframe ? ',\n  "createdAfter": "<calculated_time>"' : "";
      return userMessage(`To find conversations with urgent/priority tags:${timeNote}

${inboxId ? "" : "If the user mentioned a specific inbox by name, call `searchInboxes` first.\n"}
Run multiple \`searchConversations\` calls — Help Scout tags vary by org:

\`\`\`json
{ "tag": "urgent",        "limit": 50, "sort": "createdAt", "order": "desc"${inboxPart}${datePart} }
{ "tag": "priority",      "limit": 50, "sort": "createdAt", "order": "desc"${inboxPart}${datePart} }
{ "tag": "high-priority", "limit": 50, "sort": "createdAt", "order": "desc"${inboxPart}${datePart} }
\`\`\`

Common urgent tag variations: urgent, priority, high-priority, escalated, critical, emergency.

Combine results, dedupe by id, then triage with \`getConversationSummary\`.`);
    },
  );

  // ── list-inbox-activity ──────────────────────────────────────────────────
  server.registerPrompt(
    "list-inbox-activity",
    {
      description: "Show activity in a given inbox over the last N hours",
      argsSchema: {
        inboxId: z.string().describe("Required: inbox ID to monitor"),
        hours: z.string().describe("Required: number of hours to look back"),
        includeThreads: z
          .string()
          .optional()
          .describe('Optional: "true" to include thread details'),
      },
    },
    async ({ inboxId, hours, includeThreads }) => {
      const hoursNum = Number(hours);
      if (!inboxId) throw new Error("inboxId is required");
      if (!Number.isFinite(hoursNum) || hoursNum <= 0) {
        throw new Error("hours must be a positive number");
      }
      const includeThreadsBool = includeThreads === "true";
      return userMessage(`To show activity in inbox "${inboxId}" over the last ${hoursNum} hours:

1. Call \`getServerTime\`. Subtract ${hoursNum} hours for \`createdAfter\`.
2. Call \`searchConversations\`:
\`\`\`json
{
  "inboxId": "${inboxId}",
  "createdAfter": "<${hoursNum}-hours-ago-iso>",
  "limit": 100,
  "sort": "createdAt",
  "order": "desc"
}
\`\`\`
3. Summarize: total count, status breakdown, most recent.
4. ${
        includeThreadsBool
          ? "Use `getConversationSummary` per conversation, then `getThreads` for important ones."
          : "Use `getConversationSummary` on the most recent for a quick overview."
      }`);
    },
  );
}
