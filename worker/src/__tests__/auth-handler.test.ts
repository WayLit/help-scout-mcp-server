import { describe, expect, it } from "vitest";

import { isAllowedRedirectUri } from "../auth-handler";

describe("isAllowedRedirectUri", () => {
  it("rejects undefined / empty / non-URL inputs", () => {
    expect(isAllowedRedirectUri(undefined, "claude.ai")).toBe(false);
    expect(isAllowedRedirectUri("", "claude.ai")).toBe(false);
    expect(isAllowedRedirectUri("not a url", "claude.ai")).toBe(false);
  });

  it("rejects non-http(s) schemes outright", () => {
    expect(isAllowedRedirectUri("javascript:alert(1)", "claude.ai")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd", "claude.ai")).toBe(false);
  });

  it("always allows loopback regardless of allowlist", () => {
    expect(isAllowedRedirectUri("http://localhost:5173/cb", undefined)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:9999/cb", undefined)).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:9999/cb", undefined)).toBe(true);
  });

  it("rejects non-loopback hosts when no allowlist is configured", () => {
    expect(isAllowedRedirectUri("https://attacker.example.com/cb", undefined)).toBe(false);
    expect(isAllowedRedirectUri("https://attacker.example.com/cb", "")).toBe(false);
  });

  it("allows exact host matches in the allowlist", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/cb", "claude.ai")).toBe(true);
  });

  it("allows wildcard subdomain matches", () => {
    expect(isAllowedRedirectUri("https://app.claude.ai/cb", "*.claude.ai")).toBe(true);
    expect(isAllowedRedirectUri("https://x.y.claude.ai/cb", "*.claude.ai")).toBe(true);
  });

  it("does not match the bare wildcard pattern against a different parent domain", () => {
    expect(isAllowedRedirectUri("https://attacker.com/cb", "*.claude.ai")).toBe(false);
    // Wildcard is for subdomains; the bare apex is not implied by `*.claude.ai`.
    expect(isAllowedRedirectUri("https://claude.ai/cb", "*.claude.ai")).toBe(false);
  });

  it("supports multiple comma-separated patterns", () => {
    const list = "claude.ai, *.cursor.sh ,  desktop.anthropic.com";
    expect(isAllowedRedirectUri("https://claude.ai/cb", list)).toBe(true);
    expect(isAllowedRedirectUri("https://app.cursor.sh/cb", list)).toBe(true);
    expect(isAllowedRedirectUri("https://desktop.anthropic.com/cb", list)).toBe(true);
    expect(isAllowedRedirectUri("https://attacker.example/cb", list)).toBe(false);
  });

  it("matches case-insensitively for hostnames", () => {
    expect(isAllowedRedirectUri("https://CLAUDE.AI/cb", "claude.ai")).toBe(true);
    expect(isAllowedRedirectUri("https://app.CLAUDE.AI/cb", "*.claude.ai")).toBe(true);
  });
});
