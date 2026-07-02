import { OpenRedaction } from "openredaction";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureRedaction,
  isRedactionEnabled,
  redactAddressFields,
  redactConversationList,
  redactCustomerFields,
  redactOrganizationFields,
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

  it("fails closed — throws rather than returning unredacted text when the detector errors", async () => {
    const spy = vi
      .spyOn(OpenRedaction.prototype, "detect")
      .mockRejectedValueOnce(new Error("detector exploded"));
    await expect(redactText("jane@acme.com")).rejects.toThrow("PII redaction failed");
    spy.mockRestore();
  });
});

describe("redactCustomerFields", () => {
  beforeEach(() => configureRedaction({}));

  it("replaces name and email with redaction tokens", async () => {
    const out = await redactCustomerFields({
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

  it("ignores nullish PII fields", async () => {
    const out = await redactCustomerFields({ id: 1, firstName: null, email: undefined });
    expect(out.firstName).toBeNull();
    expect(out.email).toBeUndefined();
  });

  it("passes through when redaction disabled", async () => {
    configureRedaction({ REDACT_PII: "false" });
    const out = await redactCustomerFields({ firstName: "Jane", email: "jane@acme.com" });
    expect(out.firstName).toBe("Jane");
    expect(out.email).toBe("jane@acme.com");
  });

  it("redacts free-text location/background but leaves jobTitle untouched", async () => {
    const out = await redactCustomerFields({
      jobTitle: "Support Manager at jane@acme.com's team",
      location: "Reach me near jane@acme.com",
      background: "Met at a conference, email jane@acme.com",
    });
    expect(out.jobTitle).toBe("Support Manager at jane@acme.com's team");
    expect(out.location).not.toContain("jane@acme.com");
    expect(out.background).not.toContain("jane@acme.com");
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

describe("redactConversationList", () => {
  beforeEach(() => configureRedaction({}));

  it("redacts both subject text and embedded customer", async () => {
    const conversations = [
      {
        id: 1,
        subject: "Refund for jane@acme.com order",
        customer: { id: 1, firstName: "Jane", email: "jane@acme.com" },
      },
    ];
    const out = await redactConversationList(conversations);
    expect(out[0]?.subject).not.toContain("jane@acme.com");
    expect(out[0]?.customer.firstName).toBe("[NAME_REDACTED]");
  });

  it("no-op when disabled", async () => {
    configureRedaction({ REDACT_PII: "false" });
    const conversations = [{ id: 1, subject: "jane@acme.com", customer: { firstName: "Jane" } }];
    const out = await redactConversationList(conversations);
    expect(out[0]?.subject).toBe("jane@acme.com");
    expect(out[0]?.customer.firstName).toBe("Jane");
  });
});

describe("redactOrganizationFields", () => {
  beforeEach(() => configureRedaction({}));

  it("tokenizes phones and redacts free-text note", async () => {
    const out = await redactOrganizationFields({
      id: 1,
      name: "Acme Inc",
      phones: ["+1 555-0100"],
      note: "Call jane@acme.com about the contract",
    });
    expect(out.phones).toEqual(["[PHONE_REDACTED]"]);
    expect(out.note).not.toContain("jane@acme.com");
    // Non-PII fields preserved
    expect(out.name).toBe("Acme Inc");
  });

  it("no-op when disabled", async () => {
    configureRedaction({ REDACT_PII: "false" });
    const out = await redactOrganizationFields({ phones: ["+1 555-0100"], note: "jane@acme.com" });
    expect(out.phones).toEqual(["+1 555-0100"]);
    expect(out.note).toBe("jane@acme.com");
  });
});
