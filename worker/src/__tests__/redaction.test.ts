import { beforeEach, describe, expect, it } from "vitest";

import {
  configureRedaction,
  isRedactionEnabled,
  redactAddressFields,
  redactCustomerFields,
  redactText,
  redactThreadBodies,
} from "../redaction";

describe("redaction toggle", () => {
  beforeEach(() => {
    // Default: enabled
    configureRedaction({});
  });

  it("defaults to enabled", () => {
    expect(isRedactionEnabled()).toBe(true);
  });

  it('disables when REDACT_PII="false"', () => {
    configureRedaction({ REDACT_PII: "false" });
    expect(isRedactionEnabled()).toBe(false);
  });

  it('treats anything other than "false" as enabled', () => {
    configureRedaction({ REDACT_PII: "no" });
    expect(isRedactionEnabled()).toBe(true);
  });
});

describe("redactText", () => {
  beforeEach(() => configureRedaction({}));

  it("returns empty for null/undefined/empty input", async () => {
    expect(await redactText(null)).toBe("");
    expect(await redactText(undefined)).toBe("");
    expect(await redactText("")).toBe("");
  });

  it("redacts email addresses", async () => {
    const out = await redactText("Reach me at jane@acme.com tomorrow");
    expect(out).not.toContain("jane@acme.com");
  });

  it("returns original when redaction is disabled", async () => {
    configureRedaction({ REDACT_PII: "false" });
    const original = "Reach me at jane@acme.com tomorrow";
    expect(await redactText(original)).toBe(original);
  });
});

describe("redactCustomerFields", () => {
  beforeEach(() => configureRedaction({}));

  it("replaces name and email with redaction tokens", () => {
    const out = redactCustomerFields({
      id: 1,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@acme.com",
      phone: "+1 555-0100",
      organizationId: 42,
    });
    expect(out.firstName).toBe("[NAME_REDACTED]");
    expect(out.lastName).toBe("[NAME_REDACTED]");
    expect(out.email).toBe("[EMAIL_REDACTED]");
    expect(out.phone).toBe("[PHONE_REDACTED]");
    // Non-PII fields preserved
    expect(out.id).toBe(1);
    expect(out.organizationId).toBe(42);
  });

  it("ignores nullish PII fields", () => {
    const out = redactCustomerFields({ id: 1, firstName: null, email: undefined });
    expect(out.firstName).toBeNull();
    expect(out.email).toBeUndefined();
  });

  it("passes through when redaction disabled", () => {
    configureRedaction({ REDACT_PII: "false" });
    const out = redactCustomerFields({ firstName: "Jane", email: "jane@acme.com" });
    expect(out.firstName).toBe("Jane");
    expect(out.email).toBe("jane@acme.com");
  });
});

describe("redactAddressFields", () => {
  beforeEach(() => configureRedaction({}));

  it("redacts city/state/postal/lines", () => {
    const out = redactAddressFields({
      city: "Springfield",
      state: "IL",
      postalCode: "12345",
      country: "US",
      lines: ["742 Evergreen Terrace"],
    });
    expect(out.city).toBe("[CITY_REDACTED]");
    expect(out.state).toBe("[STATE_REDACTED]");
    expect(out.postalCode).toBe("[POSTAL_REDACTED]");
    expect(out.lines).toEqual(["[ADDRESS_REDACTED]"]);
    // country left alone — it's not PII on its own
    expect(out.country).toBe("US");
  });
});

describe("redactThreadBodies", () => {
  beforeEach(() => configureRedaction({}));

  it("redacts body field on each thread", async () => {
    const threads = [
      { id: 1, body: "Customer email: jane@acme.com" },
      { id: 2, body: "" },
    ];
    const out = await redactThreadBodies(threads);
    expect(out[0]?.body).not.toContain("jane@acme.com");
    expect(out[1]?.body).toBe("");
  });

  it("no-op when disabled", async () => {
    configureRedaction({ REDACT_PII: "false" });
    const threads = [{ id: 1, body: "jane@acme.com" }];
    const out = await redactThreadBodies(threads);
    expect(out[0]?.body).toBe("jane@acme.com");
  });
});
