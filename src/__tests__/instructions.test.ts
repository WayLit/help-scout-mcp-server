import { describe, expect, it } from "vitest";

import { buildDocsInstructions, buildInstructions } from "../instructions";

describe("buildInstructions", () => {
  it("renders the empty-state hint when no inboxes are passed", () => {
    const out = buildInstructions([]);
    expect(out).toContain("## Available Inboxes (0 total)");
    expect(out).toContain(
      "(No inboxes discovered yet — call listAllInboxes once tokens are available)",
    );
  });

  it('lists each inbox as a `"name" (ID: id)` bullet', () => {
    const out = buildInstructions([
      { id: 1, name: "Support" },
      { id: 42, name: "Billing" },
    ]);
    expect(out).toContain("## Available Inboxes (2 total)");
    expect(out).toContain('  - "Support" (ID: 1)');
    expect(out).toContain('  - "Billing" (ID: 42)');
    expect(out).not.toContain("No inboxes discovered yet");
  });

  it("includes the tool-selection guide so clients pick the right tool", () => {
    const out = buildInstructions([]);
    expect(out).toContain("## Tool Selection Guide");
    expect(out).toContain("searchConversations");
    expect(out).not.toContain("comprehensiveConversationSearch");
    expect(out).not.toContain("advancedConversationSearch");
    expect(out).not.toContain("structuredConversationFilter");
    expect(out).not.toContain("searchInboxes");
    expect(out).toContain("getThreads");
  });

  it("documents the workflow patterns and PII redaction default", () => {
    const out = buildInstructions([]);
    expect(out).toContain("## Workflow Patterns");
    expect(out).toContain("PII redaction is enabled by default");
    expect(out).toContain("REDACT_PII=false");
  });

  it("documents the reply-drafting and new-conversation-draft tools as write operations that never send", () => {
    const out = buildInstructions([]);
    expect(out).toContain("gatherReplyContext");
    expect(out).toContain("draftReply");
    expect(out).toContain("createDraftConversation");
    expect(out).toMatch(/draftReply and createDraftConversation are write operations/i);
  });
});

describe("buildDocsInstructions", () => {
  it("when connected, mentions createArticleImageUpload and the one-updateArticle-per-batch rule", () => {
    const out = buildDocsInstructions(true);
    expect(out).toContain("createArticleImageUpload");
    expect(out).toContain("a single updateArticle call");
    expect(out).toContain("searchArticles");
    expect(out).toContain("updateArticle");
  });

  it("when not connected, prompts for a Docs API key and mentions no tools", () => {
    const out = buildDocsInstructions(false);
    expect(out).toContain("/docs-api-key/enter");
    expect(out).not.toContain("createArticleImageUpload");
  });
});
