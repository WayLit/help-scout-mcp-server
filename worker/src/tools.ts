/**
 * Help Scout MCP tool registrations.
 *
 * Ported from src/tools/index.ts in the stdio server. Each tool is registered
 * on the given McpServer and uses the per-user HelpScoutAPI instance for
 * requests. PII redaction and `HELPSCOUT_DEFAULT_INBOX_ID` scoping are
 * intentionally omitted — the Worker deployment is per-user, so data never
 * crosses users, and users can pass inboxId explicitly when they want to
 * scope.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  HelpScoutAPI,
  HelpScoutApiError,
  PaginatedResponse,
  isHelpScoutApiError,
} from "./helpscout-api";
import {
  AdvancedConversationSearchShape,
  ComprehensiveConversationSearchShape,
  Conversation,
  Customer,
  CustomerAddress,
  GetConversationSummaryShape,
  GetCustomerContactsShape,
  GetCustomerShape,
  GetOrganizationConversationsShape,
  GetOrganizationMembersShape,
  GetOrganizationShape,
  GetThreadsShape,
  Inbox,
  ListAllInboxesShape,
  ListCustomersShape,
  ListOrganizationsShape,
  Organization,
  SearchConversationsShape,
  SearchCustomersByEmailShape,
  SearchInboxesShape,
  StructuredConversationFilterShape,
  Thread,
} from "./schemas";

// ── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_SORT_FIELD = "createdAt";
const DEFAULT_SORT_ORDER = "desc";

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown, toolName: string): CallToolResult {
  if (isHelpScoutApiError(error)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error.code,
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
              tool: toolName,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "UNEXPECTED_ERROR",
            message: error instanceof Error ? error.message : String(error),
            tool: toolName,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** Escape Help Scout query syntax to prevent injection. */
function escapeQueryTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Append a createdAt date range to an existing Help Scout query. */
function appendCreatedAtFilter(
  existingQuery: string | undefined,
  createdAfter?: string,
  createdBefore?: string,
): string | undefined {
  if (!createdAfter && !createdBefore) return existingQuery;
  const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/;
  if (createdAfter && !iso.test(createdAfter)) {
    throw new Error(`Invalid createdAfter: ${createdAfter}. Expected ISO 8601.`);
  }
  if (createdBefore && !iso.test(createdBefore)) {
    throw new Error(`Invalid createdBefore: ${createdBefore}. Expected ISO 8601.`);
  }
  const normalize = (d: string) => d.replace(/\.\d{3}(Z|[+-]\d{2}:\d{2})$/, "$1");
  const start = createdAfter ? normalize(createdAfter) : "*";
  const end = createdBefore ? normalize(createdBefore) : "*";
  const clause = `(createdAt:[${start} TO ${end}])`;
  if (!existingQuery) return clause;
  return `(${existingQuery}) AND ${clause}`;
}

function applyCreatedBeforeFilter(
  conversations: Conversation[],
  createdBefore: string,
): { filtered: Conversation[]; wasFiltered: boolean; removedCount: number } {
  const beforeDate = new Date(createdBefore);
  if (isNaN(beforeDate.getTime())) {
    throw new Error(`Invalid createdBefore date format: ${createdBefore}`);
  }
  const originalCount = conversations.length;
  const filtered = conversations.filter((c) => new Date(c.createdAt) < beforeDate);
  return {
    filtered,
    wasFiltered: originalCount - filtered.length > 0,
    removedCount: originalCount - filtered.length,
  };
}

function formatInboxScope(inboxId?: string): string {
  return inboxId ? `Specific inbox: ${inboxId}` : "ALL inboxes";
}

function buildFilteredPagination(
  filteredCount: number,
  apiPage: { totalElements?: number } | undefined,
  wasFiltered: boolean,
): unknown {
  if (!wasFiltered) return apiPage;
  return {
    totalResults: filteredCount,
    totalAvailable: apiPage?.totalElements,
    note: `Results filtered client-side by createdBefore. totalResults=${filteredCount}, totalAvailable=${apiPage?.totalElements}.`,
  };
}

function calculateTimeRange(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildSearchQuery(terms: string[], searchIn: string[]): string {
  const queries: string[] = [];
  for (const term of terms) {
    const escaped = escapeQueryTerm(term);
    const parts: string[] = [];
    if (searchIn.includes("body") || searchIn.includes("both")) {
      parts.push(`body:"${escaped}"`);
    }
    if (searchIn.includes("subject") || searchIn.includes("both")) {
      parts.push(`subject:"${escaped}"`);
    }
    if (parts.length > 0) queries.push(`(${parts.join(" OR ")})`);
  }
  return queries.join(" OR ");
}

// ── Tool registration ──────────────────────────────────────────────────────

export function registerTools(server: McpServer, api: HelpScoutAPI): void {
  // ── searchInboxes ────────────────────────────────────────────────────
  server.tool(
    "searchInboxes",
    "List or search inboxes by name. Use empty string to list all.",
    SearchInboxesShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Inbox>>("/mailboxes", {
          page: 1,
          size: input.limit,
        });
        const inboxes = response._embedded?.mailboxes || [];
        const filtered = inboxes.filter((i) =>
          i.name.toLowerCase().includes(input.query.toLowerCase()),
        );
        return textResult({
          results: filtered.map((i) => ({
            id: i.id,
            name: i.name,
            email: i.email,
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
          })),
          query: input.query,
          totalFound: filtered.length,
          totalAvailable: inboxes.length,
          usage:
            filtered.length > 0
              ? 'Use the "id" field with conversation search tools.'
              : 'No inboxes matched. Try "" to list all.',
        });
      } catch (err) {
        return errorResult(err, "searchInboxes");
      }
    },
  );

  // ── searchConversations ──────────────────────────────────────────────
  server.tool(
    "searchConversations",
    "List conversations by status, date, inbox, or tag. Searches active/pending/closed in parallel by default. For keyword search use comprehensiveConversationSearch.",
    SearchConversationsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const baseParams: Record<string, unknown> = {
          page: 1,
          size: input.limit,
          sortField: input.sort,
          sortOrder: input.order,
        };
        if (input.query) baseParams.query = input.query;
        if (input.inboxId) baseParams.mailbox = input.inboxId;
        if (input.tag) baseParams.tag = input.tag;

        // NOTE: Only createdAfter goes into the query — createdBefore is
        // applied client-side below. This matches the stdio server behavior;
        // Help Scout's query syntax does not reliably honor a date upper bound.
        const queryWithDate = appendCreatedAtFilter(
          baseParams.query as string | undefined,
          input.createdAfter,
        );
        if (queryWithDate) baseParams.query = queryWithDate;

        let conversations: Conversation[] = [];
        let searchedStatuses: string[];
        let pagination: unknown;

        if (input.status) {
          const response = await api.get<PaginatedResponse<Conversation>>(
            "/conversations",
            { ...baseParams, status: input.status },
          );
          conversations = response._embedded?.conversations || [];
          searchedStatuses = [input.status];
          pagination = response.page;
        } else {
          const statuses = ["active", "pending", "closed"] as const;
          searchedStatuses = [...statuses];
          const results = await Promise.allSettled(
            statuses.map((status) =>
              api.get<PaginatedResponse<Conversation>>("/conversations", {
                ...baseParams,
                status,
              }),
            ),
          );

          const seen = new Set<number>();
          const failed: Array<{ status: string; message: string; code: string }> = [];
          const totalByStatus: Record<string, number> = {};
          let totalAvailable = 0;

          for (const [i, r] of results.entries()) {
            if (r.status === "fulfilled") {
              const statusName = statuses[i];
              const statusTotal = r.value.page?.totalElements || 0;
              totalByStatus[statusName] = statusTotal;
              totalAvailable += statusTotal;
              for (const c of r.value._embedded?.conversations || []) {
                if (!seen.has(c.id)) {
                  seen.add(c.id);
                  conversations.push(c);
                }
              }
            } else {
              const reason = r.reason;
              if (!isHelpScoutApiError(reason)) throw reason;
              if (reason.code === "UNAUTHORIZED" || reason.code === "INVALID_INPUT") {
                throw reason;
              }
              failed.push({
                status: statuses[i],
                message: reason.message,
                code: reason.code,
              });
            }
          }

          if (failed.length > 0) {
            searchedStatuses = statuses.filter(
              (s) => !failed.some((f) => f.status === s),
            );
          }
          conversations.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
          if (conversations.length > input.limit) {
            conversations = conversations.slice(0, input.limit);
          }

          pagination = {
            totalResults: conversations.length,
            totalAvailable:
              Object.keys(totalByStatus).length > 0 ? totalAvailable : undefined,
            totalByStatus:
              Object.keys(totalByStatus).length > 0 ? totalByStatus : undefined,
            errors: failed.length > 0 ? failed : undefined,
            note:
              failed.length > 0
                ? `[WARNING] ${failed.length} status(es) failed. Results incomplete.`
                : `Merged results from ${Object.keys(totalByStatus).length} statuses. Returned ${conversations.length} of ${totalAvailable}.`,
          };
        }

        // Client-side createdBefore filter — must rebuild pagination so
        // results.length matches pagination.totalResults regardless of
        // which path (single-status vs merged multi-status) we took.
        let clientSideFiltered = false;
        if (input.createdBefore) {
          const r = applyCreatedBeforeFilter(conversations, input.createdBefore);
          conversations = r.filtered;
          clientSideFiltered = r.wasFiltered;
          if (clientSideFiltered) {
            if (input.status) {
              // Single-status: pagination is Help Scout's `page` object
              pagination = buildFilteredPagination(
                conversations.length,
                pagination as { totalElements?: number } | undefined,
                true,
              );
            } else {
              // Multi-status: pagination is the custom merged object built above.
              // Preserve totalAvailable / totalByStatus / errors but update
              // totalResults to match the post-filter count.
              const merged = pagination as {
                totalAvailable?: number;
                totalByStatus?: Record<string, number>;
                errors?: Array<{ status: string; message: string; code: string }>;
                note?: string;
              } | null;
              pagination = {
                totalResults: conversations.length,
                totalAvailable: merged?.totalAvailable,
                totalByStatus: merged?.totalByStatus,
                errors: merged?.errors,
                note: `Client-side createdBefore filter applied to merged results. totalResults=${conversations.length} (filtered), totalAvailable=${merged?.totalAvailable ?? "unknown"} (pre-filter API total). ${merged?.note ?? ""}`.trim(),
              };
            }
          }
        }

        // Field selection
        if (input.fields && input.fields.length > 0) {
          const selected = new Set(input.fields);
          conversations = conversations.map((c) => {
            const source = c as unknown as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(source)) {
              if (selected.has(k)) out[k] = source[k];
            }
            return out as unknown as Conversation;
          });
        }

        return textResult({
          results: conversations,
          pagination,
          searchInfo: {
            query: input.query,
            statusesSearched: searchedStatuses,
            inboxScope: formatInboxScope(input.inboxId),
            clientSideFiltering: clientSideFiltered
              ? "createdBefore applied after API fetch"
              : undefined,
          },
        });
      } catch (err) {
        return errorResult(err, "searchConversations");
      }
    },
  );

  // ── getConversationSummary ───────────────────────────────────────────
  server.tool(
    "getConversationSummary",
    "Get conversation summary with first customer message and latest staff reply.",
    GetConversationSummaryShape,
    async (input): Promise<CallToolResult> => {
      try {
        const conversation = await api.get<Conversation>(
          `/conversations/${input.conversationId}`,
        );
        const threadsResponse = await api.get<PaginatedResponse<Thread>>(
          `/conversations/${input.conversationId}/threads`,
          { page: 1, size: 50 },
        );
        const threads = threadsResponse._embedded?.threads || [];
        const customerThreads = threads.filter((t) => t.type === "customer");
        const staffThreads = threads.filter((t) => t.type === "message" && t.createdBy);
        const firstCustomerMessage = customerThreads.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )[0];
        const latestStaffReply = staffThreads.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0];

        return textResult({
          conversation: {
            id: conversation.id,
            subject: conversation.subject,
            status: conversation.status,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            customer: conversation.customer,
            assignee: conversation.assignee,
            tags: conversation.tags,
          },
          firstCustomerMessage: firstCustomerMessage
            ? {
                id: firstCustomerMessage.id,
                body: firstCustomerMessage.body,
                createdAt: firstCustomerMessage.createdAt,
                customer: firstCustomerMessage.customer,
              }
            : null,
          latestStaffReply: latestStaffReply
            ? {
                id: latestStaffReply.id,
                body: latestStaffReply.body,
                createdAt: latestStaffReply.createdAt,
                createdBy: latestStaffReply.createdBy,
              }
            : null,
        });
      } catch (err) {
        return errorResult(err, "getConversationSummary");
      }
    },
  );

  // ── getThreads ───────────────────────────────────────────────────────
  server.tool(
    "getThreads",
    "Retrieve full message history for a conversation.",
    GetThreadsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Thread>>(
          `/conversations/${input.conversationId}/threads`,
          { page: 1, size: input.limit },
        );
        return textResult({
          conversationId: input.conversationId,
          threads: response._embedded?.threads || [],
          pagination: response.page,
          nextCursor: response._links?.next?.href,
        });
      } catch (err) {
        return errorResult(err, "getThreads");
      }
    },
  );

  // ── getServerTime ────────────────────────────────────────────────────
  server.tool(
    "getServerTime",
    "Get current server timestamp. Use before date-relative searches.",
    {},
    async (): Promise<CallToolResult> => {
      const now = new Date();
      return textResult({
        isoTime: now.toISOString(),
        unixTime: Math.floor(now.getTime() / 1000),
      });
    },
  );

  // ── listAllInboxes ───────────────────────────────────────────────────
  server.tool(
    "listAllInboxes",
    "List all inboxes with IDs.",
    ListAllInboxesShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Inbox>>("/mailboxes", {
          page: 1,
          size: input.limit,
        });
        const inboxes = response._embedded?.mailboxes || [];
        return textResult({
          inboxes: inboxes.map((i) => ({
            id: i.id,
            name: i.name,
            email: i.email,
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
          })),
          totalInboxes: inboxes.length,
          usage:
            'Use the "id" field from these results with conversation search tools.',
        });
      } catch (err) {
        return errorResult(err, "listAllInboxes");
      }
    },
  );

  // ── advancedConversationSearch ───────────────────────────────────────
  server.tool(
    "advancedConversationSearch",
    "Filter conversations by email domain, customer email, or multiple tags.",
    AdvancedConversationSearchShape,
    async (input): Promise<CallToolResult> => {
      try {
        const parts: string[] = [];
        if (input.contentTerms?.length) {
          parts.push(
            `(${input.contentTerms.map((t) => `body:"${escapeQueryTerm(t)}"`).join(" OR ")})`,
          );
        }
        if (input.subjectTerms?.length) {
          parts.push(
            `(${input.subjectTerms.map((t) => `subject:"${escapeQueryTerm(t)}"`).join(" OR ")})`,
          );
        }
        if (input.customerEmail) {
          parts.push(`email:"${escapeQueryTerm(input.customerEmail)}"`);
        }
        if (input.emailDomain) {
          parts.push(`email:"${escapeQueryTerm(input.emailDomain.replace("@", ""))}"`);
        }
        if (input.tags?.length) {
          parts.push(
            `(${input.tags.map((t) => `tag:"${escapeQueryTerm(t)}"`).join(" OR ")})`,
          );
        }
        const queryString = parts.length > 0 ? parts.join(" AND ") : undefined;

        const queryParams: Record<string, unknown> = {
          page: 1,
          size: input.limit,
          sortField: "createdAt",
          sortOrder: "desc",
          status: input.status || "all",
        };
        if (queryString) queryParams.query = queryString;
        if (input.inboxId) queryParams.mailbox = input.inboxId;

        // createdBefore is applied client-side (matches stdio behavior).
        const withDate = appendCreatedAtFilter(
          queryParams.query as string | undefined,
          input.createdAfter,
        );
        if (withDate) queryParams.query = withDate;

        const response = await api.get<PaginatedResponse<Conversation>>(
          "/conversations",
          queryParams,
        );
        let conversations = response._embedded?.conversations || [];
        let clientSideFiltered = false;
        const originalCount = conversations.length;
        if (input.createdBefore) {
          const r = applyCreatedBeforeFilter(conversations, input.createdBefore);
          conversations = r.filtered;
          clientSideFiltered = r.wasFiltered;
        }

        return textResult({
          results: conversations,
          searchQuery: queryString,
          inboxScope: formatInboxScope(input.inboxId),
          searchCriteria: {
            contentTerms: input.contentTerms,
            subjectTerms: input.subjectTerms,
            customerEmail: input.customerEmail,
            emailDomain: input.emailDomain,
            tags: input.tags,
          },
          pagination: buildFilteredPagination(
            conversations.length,
            response.page,
            clientSideFiltered,
          ),
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered
            ? `createdBefore removed ${originalCount - conversations.length} of ${originalCount} results`
            : undefined,
        });
      } catch (err) {
        return errorResult(err, "advancedConversationSearch");
      }
    },
  );

  // ── comprehensiveConversationSearch ──────────────────────────────────
  server.tool(
    "comprehensiveConversationSearch",
    "Search conversation content by keywords across subject and body. Multi-status parallel search.",
    ComprehensiveConversationSearchShape,
    async (input): Promise<CallToolResult> => {
      try {
        const createdAfter = input.createdAfter || calculateTimeRange(input.timeframeDays);
        const searchQuery = buildSearchQuery(input.searchTerms, input.searchIn);

        interface StatusResult {
          status: string;
          totalCount: number;
          totalCountBeforeFilter?: number;
          conversations: Conversation[];
          searchQuery: string;
          filteredByCreatedBefore?: boolean;
          error?: string;
        }

        const allResults: StatusResult[] = [];
        for (const status of input.statuses) {
          try {
            const withDate = appendCreatedAtFilter(searchQuery, createdAfter);
            const params: Record<string, unknown> = {
              page: 1,
              size: input.limitPerStatus,
              sortField: DEFAULT_SORT_FIELD,
              sortOrder: DEFAULT_SORT_ORDER,
              query: withDate || searchQuery,
              status,
            };
            if (input.inboxId) params.mailbox = input.inboxId;

            const response = await api.get<PaginatedResponse<Conversation>>(
              "/conversations",
              params,
            );
            let convs = response._embedded?.conversations || [];
            const apiTotal = response.page?.totalElements || convs.length;
            let filteredByDate = false;
            if (input.createdBefore) {
              const r = applyCreatedBeforeFilter(convs, input.createdBefore);
              convs = r.filtered;
              filteredByDate = r.wasFiltered;
            }
            allResults.push({
              status,
              totalCount: filteredByDate ? convs.length : apiTotal,
              totalCountBeforeFilter: filteredByDate ? apiTotal : undefined,
              conversations: convs,
              searchQuery,
              filteredByCreatedBefore: filteredByDate,
            });
          } catch (err) {
            if (!isHelpScoutApiError(err)) throw err;
            if (err.code === "UNAUTHORIZED" || err.code === "INVALID_INPUT") throw err;
            allResults.push({
              status,
              totalCount: 0,
              conversations: [],
              searchQuery,
              error: `Search failed (${err.code}): ${err.message}`,
            });
          }
        }

        const totalConversations = allResults.reduce(
          (sum, r) => sum + r.conversations.length,
          0,
        );
        const totalAvailable = allResults.reduce((sum, r) => sum + r.totalCount, 0);
        const hasClientSideFiltering = allResults.some((r) => r.filteredByCreatedBefore);
        const totalBeforeFilter = hasClientSideFiltering
          ? allResults.reduce(
              (sum, r) => sum + (r.totalCountBeforeFilter || r.totalCount),
              0,
            )
          : undefined;

        return textResult({
          searchTerms: input.searchTerms,
          searchQuery,
          searchIn: input.searchIn,
          inboxScope: formatInboxScope(input.inboxId),
          timeframe: {
            createdAfter,
            createdBefore: input.createdBefore,
            days: input.timeframeDays,
          },
          totalConversationsFound: totalConversations,
          totalAvailableAcrossStatuses: totalAvailable,
          totalBeforeClientSideFiltering: totalBeforeFilter,
          clientSideFilteringApplied: hasClientSideFiltering
            ? `createdBefore applied. totalConversationsFound=${totalConversations}, totalBeforeClientSideFiltering=${totalBeforeFilter}`
            : undefined,
          failedStatuses: allResults
            .filter((r) => r.error)
            .map((r) => `[WARNING] Status "${r.status}": ${r.error}`),
          resultsByStatus: allResults,
        });
      } catch (err) {
        return errorResult(err, "comprehensiveConversationSearch");
      }
    },
  );

  // ── structuredConversationFilter ─────────────────────────────────────
  server.tool(
    "structuredConversationFilter",
    "Lookup by ticket number or filter by assignee/customer/folder IDs. Must use at least one unique field.",
    StructuredConversationFilterShape,
    async (input): Promise<CallToolResult> => {
      try {
        // Enforce .refine() rule from stdio server
        const uniqueSorts = ["waitingSince", "customerName", "customerEmail"];
        const hasUniqueField =
          input.assignedTo !== undefined ||
          input.folderId !== undefined ||
          input.customerIds !== undefined ||
          input.conversationNumber !== undefined ||
          uniqueSorts.includes(input.sortBy);
        if (!hasUniqueField) {
          throw new HelpScoutApiError(
            "INVALID_INPUT",
            "Must use at least one unique field: assignedTo, folderId, customerIds, conversationNumber, or unique sorting (waitingSince/customerName/customerEmail). For content search, use comprehensiveConversationSearch.",
          );
        }

        const queryParams: Record<string, unknown> = {
          page: 1,
          size: input.limit,
          sortField: input.sortBy,
          sortOrder: input.sortOrder,
        };
        if (input.assignedTo !== undefined) queryParams.assigned_to = input.assignedTo;
        if (input.folderId !== undefined) queryParams.folder = input.folderId;
        if (input.conversationNumber !== undefined)
          queryParams.number = input.conversationNumber;
        if (input.customerIds && input.customerIds.length > 0) {
          queryParams.query = `(${input.customerIds.map((id) => `customerIds:${id}`).join(" OR ")})`;
        }
        if (input.inboxId) queryParams.mailbox = input.inboxId;
        queryParams.status = input.status;
        if (input.tag) queryParams.tag = input.tag;
        if (input.modifiedSince) queryParams.modifiedSince = input.modifiedSince;

        const withDate = appendCreatedAtFilter(
          queryParams.query as string | undefined,
          input.createdAfter,
        );
        if (withDate) queryParams.query = withDate;

        const response = await api.get<PaginatedResponse<Conversation>>(
          "/conversations",
          queryParams,
        );
        let conversations = response._embedded?.conversations || [];
        let clientSideFiltered = false;
        const originalCount = conversations.length;
        if (input.createdBefore) {
          const r = applyCreatedBeforeFilter(conversations, input.createdBefore);
          conversations = r.filtered;
          clientSideFiltered = r.wasFiltered;
        }

        return textResult({
          results: conversations,
          filterApplied: {
            filterType: "structural",
            assignedTo: input.assignedTo,
            folderId: input.folderId,
            customerIds: input.customerIds,
            conversationNumber: input.conversationNumber,
            uniqueSorting: uniqueSorts.includes(input.sortBy) ? input.sortBy : undefined,
          },
          inboxScope: formatInboxScope(input.inboxId),
          pagination: buildFilteredPagination(
            conversations.length,
            response.page,
            clientSideFiltered,
          ),
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered
            ? `createdBefore removed ${originalCount - conversations.length} of ${originalCount}`
            : undefined,
        });
      } catch (err) {
        return errorResult(err, "structuredConversationFilter");
      }
    },
  );

  // ── getCustomer ──────────────────────────────────────────────────────
  server.tool(
    "getCustomer",
    "Get a customer profile by ID with contact details and address.",
    GetCustomerShape,
    async (input): Promise<CallToolResult> => {
      try {
        const [customerRes, addressRes] = await Promise.allSettled([
          api.get<Customer>(`/customers/${input.customerId}`),
          api.get<CustomerAddress>(`/customers/${input.customerId}/address`),
        ]);
        if (customerRes.status === "rejected") throw customerRes.reason;
        const customer = customerRes.value;

        let address: CustomerAddress | null = null;
        let addressNote: string | undefined;
        if (addressRes.status === "fulfilled") {
          address = addressRes.value;
        } else {
          const reason = addressRes.reason;
          const is404 =
            isHelpScoutApiError(reason) && reason.code === "NOT_FOUND";
          if (!is404) {
            if (
              isHelpScoutApiError(reason) &&
              (reason.code === "UNAUTHORIZED" || reason.code === "RATE_LIMIT")
            ) {
              throw reason;
            }
            if (!isHelpScoutApiError(reason)) throw reason;
            addressNote = `Address lookup failed: ${reason.message}`;
          }
        }

        const result: Record<string, unknown> = { ...customer };
        if (address) result.address = address;
        if (addressNote) result.addressNote = addressNote;

        return textResult({
          customer: result,
          usage:
            "NEXT STEPS: Use organizationId with getOrganization. Use customer.id with structuredConversationFilter(customerIds).",
        });
      } catch (err) {
        return errorResult(err, "getCustomer");
      }
    },
  );

  // ── listCustomers ────────────────────────────────────────────────────
  server.tool(
    "listCustomers",
    "List or search customers by name, query syntax, or modification date. Page-based v2 pagination.",
    ListCustomersShape,
    async (input): Promise<CallToolResult> => {
      try {
        const params: Record<string, unknown> = {
          page: input.page,
          sortField: input.sortField,
          sortOrder: input.sortOrder,
          firstName: input.firstName,
          lastName: input.lastName,
          query: input.query,
          mailbox: input.mailbox,
          modifiedSince: input.modifiedSince,
        };
        const response = await api.get<PaginatedResponse<Customer>>("/customers", params);
        const customers = response._embedded?.customers || [];
        const slim = customers.map((c) => {
          const {
            _embedded,
            ...rest
          } = c as Customer & { _links?: unknown };
          const slimRecord = rest as Record<string, unknown>;
          // Strip _links if present
          delete slimRecord._links;
          // Extract primary email
          const emails = _embedded?.emails;
          if (emails && emails.length > 0) {
            slimRecord.primaryEmail = emails[0].value;
          }
          return slimRecord;
        });
        return textResult({
          results: slim,
          returnedCount: customers.length,
          pagination: response.page,
          usage:
            "Use customer.id with getCustomer for full profile or structuredConversationFilter(customerIds).",
        });
      } catch (err) {
        return errorResult(err, "listCustomers");
      }
    },
  );

  // ── searchCustomersByEmail ───────────────────────────────────────────
  server.tool(
    "searchCustomersByEmail",
    "Search customers by email using the v3 API with cursor-based pagination.",
    SearchCustomersByEmailShape,
    async (input): Promise<CallToolResult> => {
      try {
        const params: Record<string, unknown> = {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          query: input.query,
          modifiedSince: input.modifiedSince,
          createdSince: input.createdSince,
          cursor: input.cursor,
        };
        // v3 endpoint is an absolute URL
        const response = await api.get<{
          _embedded: { customers: Customer[] };
          _links?: { next?: { href: string } };
        }>("https://api.helpscout.net/v3/customers", params);

        const customers = response._embedded?.customers || [];
        let nextCursor: string | undefined;
        const nextHref = response._links?.next?.href;
        if (nextHref) {
          try {
            const url = new URL(nextHref);
            nextCursor = url.searchParams.get("cursor") || nextHref;
          } catch {
            nextCursor = nextHref;
          }
        }

        return textResult({
          results: customers,
          returnedCount: customers.length,
          searchedEmail: input.email,
          nextCursor,
          note:
            "v3 API uses cursor-based pagination. Pass nextCursor back as cursor for more results.",
        });
      } catch (err) {
        return errorResult(err, "searchCustomersByEmail");
      }
    },
  );

  // ── getCustomerContacts ──────────────────────────────────────────────
  server.tool(
    "getCustomerContacts",
    "Get all contact details for a customer: emails, phones, chats, social profiles, websites, and address.",
    GetCustomerContactsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const cid = input.customerId;
        const [emailsR, phonesR, chatsR, socialR, websitesR, addressR] =
          await Promise.allSettled([
            api.get<{ _embedded?: { emails?: Array<{ id: number; value: string; type: string }> } }>(
              `/customers/${cid}/emails`,
            ),
            api.get<{ _embedded?: { phones?: Array<{ id: number; value: string; type: string }> } }>(
              `/customers/${cid}/phones`,
            ),
            api.get<{ _embedded?: { chats?: Array<{ id: number; value: string; type: string }> } }>(
              `/customers/${cid}/chats`,
            ),
            api.get<{
              _embedded?: { social_profiles?: Array<{ id: number; value: string; type: string }> };
            }>(`/customers/${cid}/social-profiles`),
            api.get<{ _embedded?: { websites?: Array<{ id: number; value: string }> } }>(
              `/customers/${cid}/websites`,
            ),
            api.get<CustomerAddress>(`/customers/${cid}/address`),
          ]);

        const extract = <T>(
          settled: PromiseSettledResult<T>,
          label: string,
        ): { data: T | null; error?: string } => {
          if (settled.status === "fulfilled") return { data: settled.value };
          const reason = settled.reason;
          if (isHelpScoutApiError(reason) && reason.code === "NOT_FOUND") {
            return { data: null };
          }
          if (
            isHelpScoutApiError(reason) &&
            (reason.code === "UNAUTHORIZED" || reason.code === "RATE_LIMIT")
          ) {
            throw reason;
          }
          if (!isHelpScoutApiError(reason)) throw reason;
          return { data: null, error: `${label} (${reason.code}): ${reason.message}` };
        };

        const emails = extract(emailsR, "emails");
        const phones = extract(phonesR, "phones");
        const chats = extract(chatsR, "chats");
        const social = extract(socialR, "social profiles");
        const websites = extract(websitesR, "websites");
        const address = extract(addressR, "address");

        const result: Record<string, unknown> = {
          customerId: cid,
          emails: emails.data?._embedded?.emails || [],
          phones: phones.data?._embedded?.phones || [],
          chats: chats.data?._embedded?.chats || [],
          socialProfiles: social.data?._embedded?.social_profiles || [],
          websites: websites.data?._embedded?.websites || [],
          address: address.data || null,
        };
        const errors = [emails, phones, chats, social, websites, address]
          .map((r) => r.error)
          .filter(Boolean);
        if (errors.length > 0) result.partialErrors = errors;
        const allEmpty =
          !emails.data && !phones.data && !chats.data && !social.data && !websites.data && !address.data;
        if (allEmpty && errors.length === 0) {
          result.warning = "No contact data found. Verify customerId with getCustomer.";
        }

        return textResult({
          ...result,
          usage:
            "Returns all contact channels for a customer. Use getCustomer for full profile.",
        });
      } catch (err) {
        return errorResult(err, "getCustomerContacts");
      }
    },
  );

  // ── getOrganization ──────────────────────────────────────────────────
  server.tool(
    "getOrganization",
    "Get an organization by ID with optional counts.",
    GetOrganizationShape,
    async (input): Promise<CallToolResult> => {
      try {
        const params: Record<string, unknown> = {};
        if (input.includeCounts) params.includeCounts = true;
        if (input.includeProperties) params.includeProperties = true;
        const org = await api.get<Organization>(
          `/organizations/${input.organizationId}`,
          params,
        );
        return textResult({
          organization: org,
          usage:
            "NEXT STEPS: getOrganizationMembers for customers, getOrganizationConversations for support history.",
        });
      } catch (err) {
        return errorResult(err, "getOrganization");
      }
    },
  );

  // ── listOrganizations ────────────────────────────────────────────────
  server.tool(
    "listOrganizations",
    "List all organizations with sorting. Returns 50 per page.",
    ListOrganizationsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Organization>>("/organizations", {
          page: input.page,
          sort: `${input.sortField},${input.sortOrder}`,
        });
        const organizations = response._embedded?.organizations || [];
        return textResult({
          results: organizations,
          returnedCount: organizations.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href
            ? (response.page?.number ?? 0) + 1
            : undefined,
          usage:
            "Use organization.id with getOrganization, getOrganizationMembers, or getOrganizationConversations.",
        });
      } catch (err) {
        return errorResult(err, "listOrganizations");
      }
    },
  );

  // ── getOrganizationMembers ───────────────────────────────────────────
  server.tool(
    "getOrganizationMembers",
    "Get all customers belonging to an organization. Returns 50 per page.",
    GetOrganizationMembersShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Customer>>(
          `/organizations/${input.organizationId}/customers`,
          { page: input.page },
        );
        const customers = response._embedded?.customers || [];
        return textResult({
          organizationId: input.organizationId,
          members: customers,
          returnedCount: customers.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href
            ? (response.page?.number ?? 0) + 1
            : undefined,
          usage:
            "Use customer.id with getCustomer or structuredConversationFilter(customerIds).",
        });
      } catch (err) {
        return errorResult(err, "getOrganizationMembers");
      }
    },
  );

  // ── getOrganizationConversations ─────────────────────────────────────
  server.tool(
    "getOrganizationConversations",
    "Get all conversations associated with an organization. Returns 50 per page.",
    GetOrganizationConversationsShape,
    async (input): Promise<CallToolResult> => {
      try {
        const response = await api.get<PaginatedResponse<Conversation>>(
          `/organizations/${input.organizationId}/conversations`,
          { page: input.page },
        );
        const conversations = response._embedded?.conversations || [];
        return textResult({
          organizationId: input.organizationId,
          conversations: conversations.map((c) => ({
            id: c.id,
            number: c.number,
            subject: c.subject,
            status: c.status,
            customer: c.customer,
            assignee: c.assignee,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            closedAt: c.closedAt,
            tags: c.tags,
          })),
          returnedCount: conversations.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href
            ? (response.page?.number ?? 0) + 1
            : undefined,
          usage: "Use conversation.id with getThreads or getConversationSummary.",
        });
      } catch (err) {
        return errorResult(err, "getOrganizationConversations");
      }
    },
  );
}
