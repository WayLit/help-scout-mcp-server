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

export const SearchInboxesShape = {
  query: z.string().describe('Case-insensitive substring match. Use "" to list all inboxes.'),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
};

export const SearchConversationsShape = {
  query: z.string().optional().describe('Help Scout query syntax, e.g. (body:"keyword")'),
  inboxId: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(["active", "pending", "closed", "spam"]).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
  sort: z.enum(["createdAt", "modifiedAt", "number"]).default("createdAt"),
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

export const DraftReplyShape = {
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

export const AdvancedConversationSearchShape = {
  contentTerms: z.array(z.string()).optional(),
  subjectTerms: z.array(z.string()).optional(),
  customerEmail: z.string().optional(),
  emailDomain: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inboxId: z.string().optional(),
  status: z.enum(["active", "pending", "closed", "spam"]).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
};

export const ComprehensiveConversationSearchShape = {
  searchTerms: z.array(z.string()).min(1, "At least one search term is required"),
  inboxId: z.string().optional(),
  statuses: z
    .array(z.enum(["active", "pending", "closed", "spam"]))
    .default(["active", "pending", "closed"]),
  searchIn: z.array(z.enum(["body", "subject", "both"])).default(["both"]),
  timeframeDays: z.number().min(1).max(365).default(60),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limitPerStatus: z.number().min(1).max(100).default(25),
};

export const StructuredConversationFilterShape = {
  assignedTo: z.number().int().min(-1).optional().describe("User ID (-1 for unassigned)"),
  folderId: z.number().int().min(0).optional(),
  customerIds: z.array(z.number().int().min(0)).max(100).optional(),
  conversationNumber: z.number().int().min(1).optional(),
  status: z.enum(["active", "pending", "closed", "spam", "all"]).default("all"),
  inboxId: z.string().optional(),
  tag: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  modifiedSince: z.string().optional(),
  sortBy: z
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
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
};

export const ListAllInboxesShape = {
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
