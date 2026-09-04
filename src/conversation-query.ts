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

/** Where one status of a merged sweep resumes: an upstream page, and how many
 *  of that page's rows a previous response already delivered. */
export interface StatusPosition {
  page: number;
  skip: number;
}

export type StatusPositions = Record<string, StatusPosition>;

/**
 * Marks a cursor as a merged multi-status position set. A plain page number
 * and a Help Scout page URL are the other two cursor forms `searchConversations`
 * accepts, and neither can start with this, so the prefix alone decides which
 * parser runs.
 */
export const MERGED_CURSOR_PREFIX = "hsm1.";

const MERGED_CURSOR_VERSION = 1;

/** Positions are stored as `[page, skip]` pairs: a cursor rides in a JSON tool
 *  result and then back out in the next call, so the compact form is worth it. */
type EncodedPosition = [number, number];

export function isMergedCursor(cursor: string): boolean {
  return cursor.startsWith(MERGED_CURSOR_PREFIX);
}

/**
 * Encode one position per status into an opaque cursor.
 *
 * Opaque on purpose. A merged sweep paginates each status independently, so
 * the position set is the only honest description of "where the last response
 * stopped" — but its shape is ours to change, and a caller that parsed it
 * would pin it. Base64url keeps it safe to hand back through a query string.
 */
export function encodeMergedCursor(positions: StatusPositions): string {
  const pos: Record<string, EncodedPosition> = {};
  for (const [status, { page, skip }] of Object.entries(positions)) {
    pos[status] = [page, skip];
  }
  const packed = btoa(JSON.stringify({ v: MERGED_CURSOR_VERSION, pos }));
  return MERGED_CURSOR_PREFIX + packed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a merged cursor, or return undefined if it is not one we can use —
 * wrong prefix, corrupt payload, a version we don't know, or a position that
 * isn't a plausible page/skip pair.
 *
 * Every field is re-validated rather than trusted: the cursor makes a round
 * trip through the caller, so a forged one could otherwise drive `page` to a
 * negative or fractional value in an upstream request, or `skip` to a value
 * that silently discards a whole window.
 */
export function parseMergedCursor(cursor: string): StatusPositions | undefined {
  if (!isMergedCursor(cursor)) return undefined;
  const packed = cursor.slice(MERGED_CURSOR_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(packed.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const { v, pos } = decoded as { v?: unknown; pos?: unknown };
  if (v !== MERGED_CURSOR_VERSION) return undefined;
  if (typeof pos !== "object" || pos === null) return undefined;

  const positions: StatusPositions = {};
  for (const [status, value] of Object.entries(pos as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [page, skip] = value;
    if (!Number.isInteger(page) || (page as number) < 1) return undefined;
    if (!Number.isInteger(skip) || (skip as number) < 0) return undefined;
    positions[status] = { page: page as number, skip: skip as number };
  }
  // An empty set would resume nothing; a cursor that resumes nothing is a bug
  // at the other end, not an empty result set.
  return Object.keys(positions).length > 0 ? positions : undefined;
}
