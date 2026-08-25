import { describe, expect, it } from "vitest";

import {
  buildConversationQuery,
  combineQueries,
  escapeQueryTerm,
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

  it("ANDs distinct filter groups together", () => {
    expect(
      buildConversationQuery({ contentTerms: ["bug"], subjectTerms: ["crash"] }),
    ).toBe('(body:"bug") AND (subject:"crash")');
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
    expect(buildConversationQuery({ tags: ["urgent", "vip"] })).toBe(
      '(tag:"urgent" OR tag:"vip")',
    );
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
    expect(combineQueries('tag:"vip"', '(body:"x")')).toBe('tag:"vip" AND (body:"x")');
  });
});
