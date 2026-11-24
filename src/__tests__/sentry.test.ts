import type { ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";

import { configureRedaction } from "../redaction";
import { scrubBreadcrumb, scrubEvent, sentryOptions } from "../sentry";

describe("scrubEvent", () => {
  it("drops credentials, request content and the user, and redacts emails in messages", async () => {
    configureRedaction({});
    const event = {
      type: undefined,
      user: { email: "agent@example.com" },
      request: {
        url: "https://hs.example.com/mcp?code=abc",
        headers: {
          "user-agent": "claude",
          authorization: "Bearer secret",
          "cf-access-jwt-assertion": "jwt",
        },
        cookies: { CF_Authorization: "jwt" },
        data: '{"q":"x"}',
        query_string: "code=abc",
      },
      exception: { values: [{ type: "Error", value: "no customer jane.doe@example.com" }] },
    } as ErrorEvent;
    const out = await scrubEvent(event);
    expect(out?.user).toBeUndefined();
    expect(out?.request).toEqual({
      url: "https://hs.example.com/mcp",
      headers: { "user-agent": "claude" },
    });
    const value = out?.exception?.values?.[0]?.value ?? "";
    expect(value).not.toContain("jane.doe@example.com");
    expect(value).toContain("no customer");
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console breadcrumbs and fetch query strings", () => {
    expect(scrubBreadcrumb({ category: "console", message: "jane@example.com" })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "fetch", data: { url: "https://api.helpscout.net/v2?x=1" } })
        ?.data,
    ).toEqual({ url: "https://api.helpscout.net/v2" });
  });
});

describe("sentryOptions", () => {
  it("collects no user, cookies, bodies, query strings or MCP payloads", () => {
    expect(sentryOptions().dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      mcp: { inputs: false, outputs: false },
    });
  });
});
