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
      : "  (No inboxes discovered yet — call searchInboxes once tokens are available)";

  return `Help Scout MCP Server - Search and retrieve Help Scout inbox, conversation, customer, and organization data.

## Available Inboxes (${inboxes.length} total)
${inboxList}

## Tool Selection Guide
| Task | Tool |
|------|------|
| Find tickets by keyword (billing, refund, bug) | comprehensiveConversationSearch |
| List recent/filtered tickets | searchConversations |
| Complex filters (email domain, multiple tags) | advancedConversationSearch |
| Lookup by ticket number (#12345) | structuredConversationFilter |
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
- **Keyword research**: comprehensiveConversationSearch → getThreads for details
- **Customer history**: searchCustomersByEmail → getCustomer → structuredConversationFilter/getThreads
- **Account review**: listOrganizations/getOrganization → getOrganizationMembers → getOrganizationConversations
- **Resolve a ticket**: locate it (search/lookup) → getThreads to confirm → updateConversationStatus
- **Reply to a ticket**: gatherReplyContext → compose the reply → draftReply to save it (review & send from Help Scout)

## Notes
- Always use inbox IDs from the list above (not names)
- searchConversations defaults to active+pending (pass status:"closed" to include closed); other search tools include closed by default
- updateConversationStatus is a write operation — it modifies the live ticket
- draftReply and createDraftConversation are write operations, but always create drafts — nothing is ever sent to a customer without a human action in Help Scout
- Use getServerTime for date-relative queries
- PII redaction is enabled by default (set REDACT_PII=false to disable)`;
}
