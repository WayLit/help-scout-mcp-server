import { describe, expect, it } from "vitest";

import {
  MERGED_CURSOR_PREFIX,
  buildConversationQuery,
  combineQueries,
  encodeMergedCursor,
  escapeQueryTerm,
  isMergedCursor,
  parseMergedCursor,
  resolveStatusPlan,
} from "../conversation-query";

describe("escapeQueryTerm", () => {
  it("escapes backslashes before quotes", () => {
    expect(escapeQueryTerm(String.raw`a\b"c`)).toBe(String.raw`a\\b\"c`);
  });

  it("doubles a lone backslash", () => {
    expect(escapeQueryTerm("\\")).toBe(String.raw`\\`);
  });

  it("escapes a lone quote so it cannot close the quoted value", () => {
    expect(escapeQueryTerm('"')).toBe(String.raw`\"`);
  });

  it("returns an empty string unchanged", () => {
    expect(escapeQueryTerm("")).toBe("");
  });

  it("re-escapes a term that already looks escaped", () => {
    // The backslash is data, not an escape character: escaping it first is
    // what stops `\"` from surviving as a live quote escape and letting the
    // following `"` close the value.
    expect(escapeQueryTerm(String.raw`a\"b`)).toBe(String.raw`a\\\"b`);
  });
});

describe("buildConversationQuery", () => {
  it("returns undefined when no filters are supplied", () => {
    expect(buildConversationQuery({})).toBeUndefined();
  });

  it("ORs content terms inside a single group", () => {
    expect(buildConversationQuery({ contentTerms: ["refund", "chargeback"] })).toBe(
      '(body:"refund" OR body:"chargeback")',
    );
  });

  it("ORs subject terms inside a single group", () => {
    expect(buildConversationQuery({ subjectTerms: ["invoice"] })).toBe('(subject:"invoice")');
  });

  it("searches both body and subject for a single searchTerm", () => {
    expect(buildConversationQuery({ searchTerms: ["refund"] })).toBe(
      '(body:"refund" OR subject:"refund")',
    );
  });

  it("ORs the per-term groups for several searchTerms", () => {
    expect(buildConversationQuery({ searchTerms: ["refund", "chargeback"] })).toBe(
      '((body:"refund" OR subject:"refund") OR (body:"chargeback" OR subject:"chargeback"))',
    );
  });

  it("ANDs searchTerms with another filter group", () => {
    expect(buildConversationQuery({ searchTerms: ["refund"], tags: ["vip", "urgent"] })).toBe(
      '(body:"refund" OR subject:"refund") AND (tag:"vip" OR tag:"urgent")',
    );
  });

  it("ANDs distinct filter groups together", () => {
    expect(buildConversationQuery({ contentTerms: ["bug"], subjectTerms: ["crash"] })).toBe(
      '(body:"bug") AND (subject:"crash")',
    );
  });

  it("compiles a customer email into an email clause", () => {
    expect(buildConversationQuery({ customerEmail: "rob@acme.com" })).toBe('email:"rob@acme.com"');
  });

  it("strips a leading @ from an email domain", () => {
    expect(buildConversationQuery({ emailDomain: "@acme.com" })).toBe('email:"acme.com"');
  });

  it("compiles customer IDs as an OR group", () => {
    expect(buildConversationQuery({ customerIds: [1, 2] })).toBe(
      "(customerIds:1 OR customerIds:2)",
    );
  });

  it("compiles multiple tags as an OR group", () => {
    expect(buildConversationQuery({ tags: ["urgent", "vip"] })).toBe('(tag:"urgent" OR tag:"vip")');
  });

  it("leaves a single tag to the native request parameter", () => {
    expect(buildConversationQuery({ tags: ["urgent"] })).toBeUndefined();
  });

  it("escapes quotes in user-supplied terms", () => {
    expect(buildConversationQuery({ contentTerms: ['say "hi"'] })).toBe(
      String.raw`(body:"say \"hi\"")`,
    );
  });
});

describe("combineQueries", () => {
  it("returns undefined when both sides are empty", () => {
    expect(combineQueries(undefined, undefined)).toBeUndefined();
  });

  it("returns the raw query alone when nothing was compiled", () => {
    expect(combineQueries('body:"x"', undefined)).toBe('body:"x"');
  });

  it("returns the compiled query alone when no raw query was given", () => {
    expect(combineQueries(undefined, '(body:"x")')).toBe('(body:"x")');
  });

  it("ANDs a raw query with a compiled one", () => {
    expect(combineQueries('tag:"vip"', '(body:"x")')).toBe('(tag:"vip") AND (body:"x")');
  });

  it("parenthesizes the raw query so a top-level OR can't escape the AND", () => {
    expect(combineQueries('body:"a" OR body:"b"', '(body:"x")')).toBe(
      '(body:"a" OR body:"b") AND (body:"x")',
    );
  });

  it("leaves the raw query unwrapped when there is nothing to AND it with", () => {
    expect(combineQueries('body:"a" OR body:"b"', undefined)).toBe('body:"a" OR body:"b"');
  });
});

describe("resolveStatusPlan", () => {
  it("defaults to an active+pending merge when status is omitted", () => {
    expect(resolveStatusPlan(undefined)).toEqual({
      mode: "multi",
      statuses: ["active", "pending"],
    });
  });

  it("never includes closed in the default sweep", () => {
    const plan = resolveStatusPlan(undefined);
    expect(plan.mode).toBe("multi");
    expect(plan.mode === "multi" && plan.statuses).not.toContain("closed");
  });

  it("treats a single string as one request", () => {
    expect(resolveStatusPlan("closed")).toEqual({ mode: "single", status: "closed" });
  });

  it('treats "all" as one native request, not a merge', () => {
    expect(resolveStatusPlan("all")).toEqual({ mode: "single", status: "all" });
  });

  it("collapses a one-element array to a single request", () => {
    expect(resolveStatusPlan(["spam"])).toEqual({ mode: "single", status: "spam" });
  });

  it("treats a multi-element array as a merge", () => {
    expect(resolveStatusPlan(["active", "pending", "closed"])).toEqual({
      mode: "multi",
      statuses: ["active", "pending", "closed"],
    });
  });

  it("collapses an array of one repeated status to a single request", () => {
    expect(resolveStatusPlan(["active", "active"])).toEqual({
      mode: "single",
      status: "active",
    });
  });

  it("drops duplicate statuses while preserving first-seen order", () => {
    expect(resolveStatusPlan(["active", "pending", "active"])).toEqual({
      mode: "multi",
      statuses: ["active", "pending"],
    });
  });
});

describe("merged status cursor", () => {
  it("round-trips a position per status", () => {
    const positions = { active: { page: 1, skip: 40 }, pending: { page: 2, skip: 0 } };
    expect(parseMergedCursor(encodeMergedCursor(positions))).toEqual(positions);
  });

  it("emits an opaque token, not a readable page number", () => {
    const cursor = encodeMergedCursor({ active: { page: 3, skip: 7 } });
    expect(isMergedCursor(cursor)).toBe(true);
    expect(cursor).not.toContain("active");
    expect(Number(cursor)).toBeNaN();
  });

  it("stays inside the base64url alphabet so it survives a query string", () => {
    const cursor = encodeMergedCursor({
      active: { page: 1, skip: 1 },
      pending: { page: 1, skip: 2 },
    });
    expect(cursor.slice(MERGED_CURSOR_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not claim a plain page number or a page URL", () => {
    expect(isMergedCursor("3")).toBe(false);
    expect(isMergedCursor("https://api.helpscout.net/v2/conversations?page=2")).toBe(false);
  });

  it("rejects a payload that is not valid base64url JSON", () => {
    expect(parseMergedCursor(`${MERGED_CURSOR_PREFIX}not-base64-json`)).toBeUndefined();
  });

  it("rejects a version it does not know", () => {
    const forged = `${MERGED_CURSOR_PREFIX}${btoa(JSON.stringify({ v: 99, pos: {} }))}`;
    expect(parseMergedCursor(forged)).toBeUndefined();
  });

  it("rejects a position that is not a pair of non-negative integers", () => {
    for (const pos of [
      { active: [0, 0] },
      { active: [1, -1] },
      { active: [1.5, 0] },
      { active: [1] },
      { active: "1,0" },
    ]) {
      const forged = `${MERGED_CURSOR_PREFIX}${btoa(JSON.stringify({ v: 1, pos }))}`;
      expect(parseMergedCursor(forged), JSON.stringify(pos)).toBeUndefined();
    }
  });

  it("rejects a cursor carrying no positions at all", () => {
    const forged = `${MERGED_CURSOR_PREFIX}${btoa(JSON.stringify({ v: 1, pos: {} }))}`;
    expect(parseMergedCursor(forged)).toBeUndefined();
  });

  it("returns undefined for anything without the prefix", () => {
    expect(parseMergedCursor("2")).toBeUndefined();
  });
});
