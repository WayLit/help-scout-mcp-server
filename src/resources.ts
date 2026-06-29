/**
 * Help Scout MCP resource registrations.
 *
 * Ported from src/resources/index.ts in the stdio server.
 *
 * URI scheme: helpscout://<path>?<query>
 *   - helpscout://inboxes          (page, size)
 *   - helpscout://conversations    (mailbox, status, tag, modifiedSince, page, size)
 *   - helpscout://threads          (conversationId, page, size)
 *   - helpscout://clock
 *
 * Each queryable resource is registered twice: once as a static URI (so the
 * bare form appears in `resources/list`) and once as a `{+rest}` resource
 * template (so requests with arbitrary query strings still resolve). The
 * SDK's `?`-operator templates require every parameter present in the
 * declared order, which doesn't fit how clients actually invoke these.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import {
  HelpScoutAPI,
  type PaginatedResponse,
} from "./helpscout-api";
import { redactThreadBodies } from "./redaction";

interface Inbox {
  id: number;
  name: string;
  email: string;
}

interface Conversation {
  id: number;
  number: number;
  subject: string;
}

interface Thread {
  id: number;
  type: string;
  body: string;
}

function jsonResource(uri: string, payload: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function parseSearchParams(uri: string): Record<string, string> {
  const u = new URL(uri);
  return Object.fromEntries(u.searchParams.entries());
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function registerResources(server: McpServer, api: HelpScoutAPI): void {
  // ── inboxes ──────────────────────────────────────────────────────────
  const readInboxes = async (uri: URL): Promise<ReadResourceResult> => {
    const params = parseSearchParams(uri.href);
    const page = parseBoundedInt(params.page, 1, 1, 10_000, "page");
    const size = parseBoundedInt(params.size, 50, 1, 50, "size");
    const response = await api.get<PaginatedResponse<Inbox>>("/mailboxes", { page, size });
    return jsonResource(uri.href, {
      inboxes: response._embedded?.mailboxes ?? [],
      pagination: response.page,
      links: response._links,
    });
  };
  server.registerResource(
    "helpscout-inboxes",
    "helpscout://inboxes",
    {
      description: "All Help Scout inboxes the user has access to",
      mimeType: "application/json",
    },
    readInboxes,
  );
  server.registerResource(
    "helpscout-inboxes-paged",
    new ResourceTemplate("helpscout://inboxes{+rest}", { list: undefined }),
    {
      description: "All Help Scout inboxes — paged variant",
      mimeType: "application/json",
    },
    (uri) => readInboxes(uri),
  );

  // ── conversations ────────────────────────────────────────────────────
  const readConversations = async (uri: URL): Promise<ReadResourceResult> => {
    const params = parseSearchParams(uri.href);
    const queryParams: Record<string, unknown> = {
      page: parseBoundedInt(params.page, 1, 1, 10_000, "page"),
      size: parseBoundedInt(params.size, 50, 1, 50, "size"),
    };
    if (params.mailbox) queryParams.mailbox = params.mailbox;
    if (params.status) queryParams.status = params.status;
    if (params.tag) queryParams.tag = params.tag;
    if (params.modifiedSince) queryParams.modifiedSince = params.modifiedSince;
    const response = await api.get<PaginatedResponse<Conversation>>(
      "/conversations",
      queryParams,
    );
    return jsonResource(uri.href, {
      conversations: response._embedded?.conversations ?? [],
      pagination: response.page,
      links: response._links,
    });
  };
  server.registerResource(
    "helpscout-conversations",
    "helpscout://conversations",
    {
      description: "Conversations matching filters (use query parameters)",
      mimeType: "application/json",
    },
    readConversations,
  );
  server.registerResource(
    "helpscout-conversations-filtered",
    new ResourceTemplate("helpscout://conversations{+rest}", { list: undefined }),
    {
      description: "Conversations — filtered/paged variant",
      mimeType: "application/json",
    },
    (uri) => readConversations(uri),
  );

  // ── threads ──────────────────────────────────────────────────────────
  const readThreads = async (uri: URL): Promise<ReadResourceResult> => {
    const params = parseSearchParams(uri.href);
    const conversationId = params.conversationId;
    if (!conversationId) {
      throw new Error("conversationId parameter is required");
    }
    if (!/^\d+$/.test(conversationId)) {
      throw new Error("conversationId must be numeric");
    }
    const page = parseBoundedInt(params.page, 1, 1, 10_000, "page");
    const size = parseBoundedInt(params.size, 50, 1, 50, "size");
    const response = await api.get<PaginatedResponse<Thread>>(
      `/conversations/${conversationId}/threads`,
      { page, size },
    );
    const threads = await redactThreadBodies(response._embedded?.threads ?? []);
    return jsonResource(uri.href, {
      conversationId,
      threads,
      pagination: response.page,
      links: response._links,
    });
  };
  server.registerResource(
    "helpscout-threads",
    "helpscout://threads",
    {
      description: "Full thread messages for a conversation (requires conversationId)",
      mimeType: "application/json",
    },
    readThreads,
  );
  server.registerResource(
    "helpscout-threads-query",
    new ResourceTemplate("helpscout://threads{+rest}", { list: undefined }),
    {
      description: "Conversation threads — query-string variant (conversationId required)",
      mimeType: "application/json",
    },
    (uri) => readThreads(uri),
  );

  // ── clock ────────────────────────────────────────────────────────────
  server.registerResource(
    "helpscout-clock",
    "helpscout://clock",
    {
      description: "Current server timestamp for time-relative queries",
      mimeType: "application/json",
    },
    async () => {
      const now = new Date();
      return jsonResource("helpscout://clock", {
        isoTime: now.toISOString(),
        unixTime: Math.floor(now.getTime() / 1000),
      });
    },
  );
}
