/**
 * Zod input schemas for the Help Scout MCP tools.
 *
 * These are `ZodRawShape` objects (plain maps of field → Zod schema) so they
 * can be passed directly to `server.tool()` in the MCP SDK, which will parse
 * the incoming arguments and hand the typed object to the handler.
 *
 * Ported from src/schema/types.ts in the stdio server, with zod 3 syntax.
 */
import { z } from "zod";

// ── Conversation tools ─────────────────────────────────────────────────────

const ConversationStatus = z.enum(["active", "pending", "closed", "spam"]);

export const SearchConversationsShape = {
  // Raw Help Scout query syntax, for callers who want full control.
  query: z
    .string()
    .optional()
    .describe(
      'Raw Help Scout query syntax, e.g. (body:"keyword"). The convenience filters below compile into query syntax and are AND-ed onto this.',
    ),

  // Content search
  searchTerms: z
    .array(z.string())
    .optional()
    .describe(
      "Match any of these terms in either the subject or the body. The right default for keyword search — contentTerms/subjectTerms narrow to one field.",
    ),
  contentTerms: z
    .array(z.string())
    .optional()
    .describe('Match any of these terms in the message body (compiled to body:"term").'),
  subjectTerms: z
    .array(z.string())
    .optional()
    .describe('Match any of these terms in the subject (compiled to subject:"term").'),

  // Identity
  customerEmail: z.string().optional().describe("Match conversations involving this email."),
  emailDomain: z
    .string()
    .optional()
    .describe('Match any email at this domain, e.g. "acme.com".'),
  customerIds: z
    .array(z.number().int().min(0))
    .max(100)
    .optional()
    .describe("Match conversations belonging to these customer IDs."),

  // Structural
  assignedTo: z.number().int().min(-1).optional().describe("Assignee user ID (-1 for unassigned)."),
  folderId: z.number().int().min(0).optional(),
  conversationNumber: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Look up a single ticket by its number, e.g. 12345."),

  // Scope
  inboxId: z.string().optional(),
  tags: z
    .array(z.string())
    .optional()
    .describe("Match any of these tags. One tag uses the native filter; several compile to an OR."),

  // Status
  status: z
    .union([ConversationStatus, z.literal("all"), z.array(ConversationStatus).min(1)])
    .optional()
    .describe(
      'Omit to search active+pending in parallel (closed excluded as noise), except for a conversationNumber lookup, which searches every status. Pass one status, an array of statuses to sweep and merge, or "all".',
    ),

  // Dates
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  modifiedSince: z.string().optional(),

  // Paging and shaping
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
  sort: z
    .enum([
      "createdAt",
      "modifiedAt",
      "number",
      "waitingSince",
      "customerName",
      "customerEmail",
      "mailboxId",
      "status",
      "subject",
    ])
    .default("createdAt")
    .describe(
      "On a multi-status search the ordering applies across the merged window, not globally: each status is paginated independently, so only the fetched rows can be ordered together. Rows whose payload omits the sort field keep a round-robin interleave of the per-status results, so no one status fills the window.",
    ),
  order: z.enum(["asc", "desc"]).default("desc"),
  fields: z.array(z.string()).optional(),
};

export const GetThreadsShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  limit: z.number().min(1).max(200).default(200),
  cursor: z.string().optional(),
};

export const GetConversationSummaryShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
};

export const GatherReplyContextShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  historyLimit: z
    .number()
    .min(0)
    .max(10)
    .default(5)
    .describe("How many of the customer's previous conversations to pull for context."),
  guidance: z
    .string()
    .optional()
    .describe("Optional extra instructions for the draft, e.g. tone or specific points to cover."),
};

export const DraftReplyShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  replyText: z
    .string()
    .min(1)
    .describe("The composed reply body to save as a Help Scout draft."),
};

export const ListAllInboxesShape = {
  query: z
    .string()
    .default("")
    .describe('Case-insensitive substring filter on inbox name. Omit or pass "" to list all.'),
  limit: z.number().min(1).max(100).default(100),
};

// ── Conversation write tools ────────────────────────────────────────────────

export const UpdateConversationStatusShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  status: z
    .enum(["active", "pending", "closed", "spam"])
    .describe("New conversation status"),
};

export const AssignConversationShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  userId: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Help Scout user ID to assign the conversation to. Omit to unassign."),
};

export const MoveConversationShape = {
  conversationId: z.string().regex(/^\d+$/, "Conversation ID must be numeric"),
  mailboxId: z.number().int().min(0).describe("Target mailbox ID to move the conversation to"),
};

export const CreateDraftConversationShape = {
  mailboxId: z.number().int().min(0).describe("Inbox to create the draft conversation in"),
  customerId: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Existing Help Scout customer ID. Takes precedence over customerEmail if both are given.",
    ),
  customerEmail: z
    .string()
    .email()
    .optional()
    .describe(
      "Customer email. Help Scout finds or creates the customer by this address if customerId is omitted.",
    ),
  customerFirstName: z
    .string()
    .optional()
    .describe("Used only with customerEmail, when creating a new customer."),
  customerLastName: z
    .string()
    .optional()
    .describe("Used only with customerEmail, when creating a new customer."),
  subject: z.string().min(1),
  text: z.string().min(1).describe("The draft message body."),
  tags: z.array(z.string()).optional(),
};

// ── Customer tools ─────────────────────────────────────────────────────────

export const GetCustomerShape = {
  customerId: z.string().regex(/^\d+$/, "Customer ID must be numeric"),
};

export const ListCustomersShape = {
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional().describe('Advanced query syntax, e.g. (email:"john@example.com")'),
  mailbox: z.number().optional(),
  modifiedSince: z.string().optional(),
  sortField: z
    .enum(["createdAt", "firstName", "lastName", "modifiedAt"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().min(1).default(1),
};

export const SearchCustomersByEmailShape = {
  email: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  query: z.string().optional(),
  modifiedSince: z.string().optional(),
  createdSince: z.string().optional(),
  cursor: z.string().optional(),
};

export const GetCustomerContactsShape = {
  customerId: z.string().regex(/^\d+$/, "Customer ID must be numeric"),
};

// ── Organization tools ─────────────────────────────────────────────────────

export const GetOrganizationShape = {
  organizationId: z.string().regex(/^\d+$/, "Organization ID must be numeric"),
  includeCounts: z.boolean().default(true),
  includeProperties: z.boolean().default(false),
};

export const ListOrganizationsShape = {
  sortField: z
    .enum(["name", "customerCount", "conversationCount", "lastInteractionAt"])
    .default("lastInteractionAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().min(1).default(1),
};

export const GetOrganizationMembersShape = {
  organizationId: z.string().regex(/^\d+$/, "Organization ID must be numeric"),
  page: z.number().min(1).default(1),
};

export const GetOrganizationConversationsShape = {
  organizationId: z.string().regex(/^\d+$/, "Organization ID must be numeric"),
  page: z.number().min(1).default(1),
};

// ── API response types ─────────────────────────────────────────────────────

export interface Inbox {
  id: number;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: number;
  number: number;
  subject: string;
  status: "active" | "pending" | "closed" | "spam";
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  assignee: { id: number; firstName: string; lastName: string; email: string } | null;
  customer: { id: number; firstName: string; lastName: string; email: string };
  mailbox: { id: number; name: string };
  tags: Array<{ id: number; name: string; color: string }>;
  threads: number;
  /**
   * How long the customer has been waiting. Both spellings are optional
   * because neither is guaranteed: the documented Mailbox API conversation
   * payload carries `customerWaitingSince` as an object, and accepts
   * `waitingSince` only as a `sortField` — no top-level `waitingSince` field
   * appears in the documented response. Modelling both lets the client-side
   * merge sort read whichever a payload actually supplies and degrade to
   * "missing" when it supplies neither. See MERGE_SORT_VALUES in ./tools.
   */
  customerWaitingSince?: { time?: string; friendly?: string };
  waitingSince?: string;
}

export interface Thread {
  id: number;
  type: "customer" | "note" | "lineitem" | "phone" | "message";
  status: string;
  state: string;
  action: { type: string; text: string } | null;
  body: string;
  source: { type: string; via: string };
  customer: { id: number; firstName: string; lastName: string; email: string } | null;
  createdBy: { id: number; firstName: string; lastName: string; email: string } | null;
  assignedTo: { id: number; firstName: string; lastName: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  gender?: string;
  jobTitle?: string | null;
  location?: string | null;
  organizationId?: number | null;
  photoType?: string;
  photoUrl?: string | null;
  age?: string | null;
  background?: string | null;
  conversationCount?: number;
  createdAt: string;
  updatedAt: string;
  draft?: boolean;
  _embedded?: {
    emails?: Array<{ id: number; value: string; type: string }>;
    phones?: Array<{ id: number; value: string; type: string }>;
    chats?: Array<{ id: number; value: string; type: string }>;
    social_profiles?: Array<{ id: number; value: string; type: string }>;
    websites?: Array<{ id: number; value: string }>;
    properties?: Array<Record<string, unknown>>;
  };
}

export interface CustomerAddress {
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  lines?: string[];
}

export interface Organization {
  id: number;
  name: string;
  website?: string | null;
  description?: string | null;
  location?: string | null;
  logoUrl?: string | null;
  note?: string | null;
  domains?: string[];
  phones?: string[];
  brandColor?: string | null;
  customerCount?: number;
  conversationCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Help Scout user (mailbox agent), as returned by `GET /v2/users/me`. */
export interface User {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  timezone?: string;
  type?: string;
  photoUrl?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
