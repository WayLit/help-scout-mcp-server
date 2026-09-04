/**
 * Help Scout query-syntax compilation for conversation search.
 *
 * Lives outside `tools.ts` so the compiler can be unit-tested directly
 * without standing up an McpServer, and so `tools.ts` stops growing. Nothing
 * here does I/O or touches MCP types.
 */

/**
 * Escape Help Scout query syntax to prevent injection.
 *
 * Every user-supplied term below is interpolated into a double-quoted query
 * value. Without this, a term containing `"` closes the quote early and the
 * rest of it is parsed as query syntax — the caller's search silently becomes
 * whatever operators, fields, or boolean clauses the term smuggled in.
 * Backslashes are escaped first so an escape character in the term cannot
 * neutralize the quote escaping that follows.
 */
export function escapeQueryTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface ConversationQueryFilters {
  searchTerms?: string[];
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
 *
 * `searchTerms` matches either field, so it is the right default for "find
 * tickets mentioning X"; `contentTerms`/`subjectTerms` stay field-specific and,
 * being separate groups, AND with each other.
 */
export function buildConversationQuery(input: ConversationQueryFilters): string | undefined {
  const parts: string[] = [];
  if (input.searchTerms?.length) {
    // One group per term, each matching either field, all OR-ed together.
    const perTerm = input.searchTerms.map(
      (t) => `(body:"${escapeQueryTerm(t)}" OR subject:"${escapeQueryTerm(t)}")`,
    );
    parts.push(perTerm.length === 1 ? perTerm[0] : `(${perTerm.join(" OR ")})`);
  }
  if (input.contentTerms?.length) {
    parts.push(`(${input.contentTerms.map((t) => `body:"${escapeQueryTerm(t)}"`).join(" OR ")})`);
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

/**
 * AND a compiled filter expression onto a caller-supplied raw query.
 *
 * The raw query is parenthesized before the AND: a caller-supplied top-level
 * OR (`body:"a" OR body:"b"`) would otherwise bind as
 * `body:"a" OR (body:"b" AND ...)` under Lucene precedence and silently return
 * the wrong rows. Every group buildConversationQuery emits is already
 * self-parenthesized, so the raw operand is the only one that needs wrapping —
 * and only when there is something to AND it with.
 */
export function combineQueries(
  rawQuery: string | undefined,
  compiled: string | undefined,
): string | undefined {
  if (!rawQuery) return compiled;
  if (!compiled) return rawQuery;
  return `(${rawQuery}) AND ${compiled}`;
}

export type StatusPlan = { mode: "single"; status: string } | { mode: "multi"; statuses: string[] };

/**
 * Resolve the `status` input into a concrete request plan.
 *
 * Omitted means active+pending merged: closed tickets are usually noise for
 * "what's open right now". "all" is Help Scout's own all-status request, so it
 * stays a single call rather than becoming a client-side merge.
 *
 * A status array is de-duplicated first (first-seen order wins): a repeated
 * status would otherwise issue an identical request per copy and double-count
 * the merged `totalAvailable`.
 */
export function resolveStatusPlan(status: string | string[] | undefined): StatusPlan {
  if (status === undefined) {
    return { mode: "multi", statuses: ["active", "pending"] };
  }
  if (Array.isArray(status)) {
    const unique = [...new Set(status)];
    return unique.length === 1
      ? { mode: "single", status: unique[0] }
      : { mode: "multi", statuses: unique };
  }
  return { mode: "single", status };
}
