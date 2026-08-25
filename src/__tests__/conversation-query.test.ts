import { describe, expect, it } from "vitest";

import {
  buildConversationQuery,
  combineQueries,
  escapeQueryTerm,
  resolveStatusPlan,
} from "../conversation-query";

describe("escapeQueryTerm", () => {
  it("escapes backslashes before quotes", () => {
    expect(escapeQueryTerm(String.raw`a\b"c`)).toBe(String.raw`a\\b\"c`);
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
