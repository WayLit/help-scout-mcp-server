/**
 * Help Scout query-syntax compilation for conversation search.
 *
 * Lives outside `tools.ts` so the compiler can be unit-tested directly
 * without standing up an McpServer, and so `tools.ts` stops growing. Nothing
 * here does I/O or touches MCP types.
 */

/** Escape a user-supplied term for interpolation into a quoted query value. */
export function escapeQueryTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface ConversationQueryFilters {
  contentTerms?: string[];
  subjectTerms?: string[];
  customerEmail?: string;
  emailDomain?: string;
  customerIds?: number[];
  tags?: string[];
}

/**
 * Compile the convenience filters into Help Scout query syntax: each group is
 * OR-ed internally, groups are AND-ed together. Returns undefined when no
 * filter was supplied, so callers can fall back to a raw `query`.
 *
 * A single tag is deliberately NOT compiled here — the caller passes it as the
 * native `tag` request parameter instead. Only a multi-tag OR needs query
 * syntax, and the native parameter is the path already proven in production.
 */
export function buildConversationQuery(
  input: ConversationQueryFilters,
): string | undefined {
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
  if (input.customerIds?.length) {
    parts.push(`(${input.customerIds.map((id) => `customerIds:${id}`).join(" OR ")})`);
  }
  if (input.tags && input.tags.length > 1) {
    parts.push(`(${input.tags.map((t) => `tag:"${escapeQueryTerm(t)}"`).join(" OR ")})`);
  }
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/** AND a compiled filter expression onto a caller-supplied raw query. */
export function combineQueries(
  rawQuery: string | undefined,
  compiled: string | undefined,
): string | undefined {
  const parts = [rawQuery, compiled].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}
