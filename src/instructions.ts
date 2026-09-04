/**
 * Build the MCP `instructions` string injected into the initialize handshake.
 * Mirrors stdio's discoverAndBuildInstructions but per-user (the worker is
 * one DO instance per email, so each user gets their own scoped list).
 *
 * Lives in its own module (not `index.ts`) so unit tests can import it without
 * pulling in the `cloudflare:`/`agents/mcp` graph that the DO entry point uses.
 */
export function buildInstructions(inboxes: Array<{ id: number; name: string }>): string {
  const inboxList =
    inboxes.length > 0
      ? inboxes.map((i) => `  - "${i.name}" (ID: ${i.id})`).join("\n")
      : "  (No inboxes discovered yet — call listAllInboxes once tokens are available)";

  return `Help Scout MCP Server - Search and retrieve Help Scout inbox, conversation, customer, and organization data.

## Available Inboxes (${inboxes.length} total)
${inboxList}

## Tool Selection Guide
| Task | Tool |
|------|------|
| Find, list, or filter tickets (keyword via \`searchTerms\`, tag, assignee, ticket number) | searchConversations |
| Browse customers by name or query | listCustomers |
| Find a customer by email | searchCustomersByEmail |
| Get a full customer profile | getCustomer |
| Get customer contact channels | getCustomerContacts |
| Browse organizations | listOrganizations |
| Get an organization profile | getOrganization |
| See everyone in an organization | getOrganizationMembers |
| See all conversations for an organization | getOrganizationConversations |
| Get full conversation thread | getThreads |
| Quick conversation preview | getConversationSummary |
| Gather context before replying to a conversation | gatherReplyContext |
| Save a composed reply as a Help Scout draft (nothing sent) | draftReply |
| Start a new outbound conversation as a draft (not a reply) | createDraftConversation |
| Identify the current Help Scout user (your id/email/role) | whoami |
| Change a ticket's status (active/pending/closed/spam) | updateConversationStatus |

## Workflow Patterns
- **Ticket investigation**: searchConversations → getConversationSummary → getThreads
- **Keyword research**: searchConversations (\`searchTerms\` matches subject or body; \`contentTerms\`/\`subjectTerms\` target one field — passing both requires a match in both) → getThreads for details
- **Customer history**: searchCustomersByEmail → getCustomer → searchConversations (customerIds with status:"all" — a history review wants resolved tickets too, which the active+pending default omits) → getThreads
- **Account review**: listOrganizations/getOrganization → getOrganizationMembers → getOrganizationConversations
- **Resolve a ticket**: locate it (search/lookup) → getThreads to confirm → updateConversationStatus
- **Reply to a ticket**: gatherReplyContext → compose the reply → draftReply to save it (review & send from Help Scout)

## Notes
- Always use inbox IDs from the list above (not names)
- searchConversations defaults to active+pending; pass status:"closed", a status array like ["active","pending","closed"], or "all" to widen
- A conversationNumber lookup searches every status automatically, so a closed ticket is still found by number without widening status
- Tags are passed as an array: tags:["urgent"] filters natively, tags:["urgent","vip"] matches either
- updateConversationStatus is a write operation — it modifies the live ticket
- draftReply and createDraftConversation are write operations, but always create drafts — nothing is ever sent to a customer without a human action in Help Scout
- Use getServerTime for date-relative queries
- PII redaction is enabled by default (set REDACT_PII=false to disable)`;
}

/**
 * Build the MCP `instructions` string for the Docs connector (`/docs/mcp`),
 * distinct from `buildInstructions` above (which is for the mailbox
 * connector at `/mcp`). Extracted for the same reason: so unit tests can
 * assert its content — in particular the one-`updateArticle`-per-batch rule,
 * which is deliberately stated in three places in this codebase (here, in
 * the `createArticleImageUpload` tool description, and in that tool's
 * `usage` field) and would otherwise be free to drift unnoticed here.
 */
export function buildDocsInstructions(connected: boolean): string {
  return connected
    ? "Help Scout Docs MCP: read and write access to your Docs knowledge base " +
        "(collections and articles). Use searchArticles to find stale content by " +
        "keyword, getArticle to read the full body, and updateArticle to fix it. " +
        "createArticle defaults to status=notpublished so drafts can be reviewed " +
        "before publishing. To add images, call createArticleImageUpload, have the " +
        "local uploader post the file, then insert every returned filelink as an " +
        "<img> tag in a single updateArticle call."
    : "No Help Scout Docs API key on file yet — visit /docs-api-key/enter to connect one " +
        "before calling any tool here.";
}
