/**
 * PII redaction via OpenRedaction.
 *
 * Replaces the stdio server's "swap whole body for a constant" pattern with
 * field-level, content-aware redaction that preserves message structure so
 * the LLM can still reason about what the conversation is about.
 *
 * One singleton OpenRedaction instance per DO (configured at module-import
 * time). Same instance across tool calls keeps regex compilation amortized.
 */
import { gdprPreset, OpenRedaction } from "openredaction";

import { logger } from "./logger";

let singleton: OpenRedaction | null = null;
let enabled = true;

function getRedactor(): OpenRedaction {
  if (!singleton) {
    singleton = new OpenRedaction({
      preset: "gdpr",
      // Stable placeholders — same email always maps to the same token, so
      // the LLM can spot "this is the same person across results".
      deterministic: true,
      redactionMode: "placeholder",
      // Use the OpenRedaction default (0.5). Higher thresholds were filtering
      // out clearly-PII matches like emails in support prose.
      confidenceThreshold: 0.5,
      enableContextAnalysis: true,
      // Names are left in place — redacting them made ticket data much less
      // useful for triage/reporting (who filed it, who's assigned) without a
      // corresponding privacy win, since names alone aren't very identifying
      // without the email/phone/address they're paired with.
      includeNames: false,
      // `includeNames: false` alone doesn't disable the NAME pattern: the
      // "gdpr" preset sets its own explicit `patterns` allowlist (which
      // includes "NAME"), and OpenRedaction's pattern builder honors an
      // explicit `patterns` list *before* checking includeNames/etc. That let
      // the NAME regex (which matches any run of Title-Case/ALL-CAPS words,
      // e.g. "ACTION REQUIRED") through despite includeNames: false, mangling
      // non-PII subject lines. Re-deriving the preset's pattern list minus
      // "NAME" restores the intended behavior.
      patterns: (gdprPreset.patterns ?? []).filter((type) => type !== "NAME"),
      // Customer-supplied terms that should never be redacted. Add internal
      // product names / domains here if any leak through.
      whitelist: [],
    });
  }
  return singleton;
}

/**
 * Configure the redaction singleton from env. Call once during init.
 *
 * REDACT_PII unset or "true"  → redaction enabled (default for internal tool).
 * REDACT_PII = "false"        → pass-through.
 */
export function configureRedaction(env: { REDACT_PII?: string }): void {
  enabled = env.REDACT_PII !== "false";
  logger.info("redaction configured", { enabled });
}

/** Returns true if redaction is currently active. Cheap. */
export function isRedactionEnabled(): boolean {
  return enabled;
}

/**
 * Redact a single string. No-op if redaction is disabled or input is empty.
 * Fails closed: if the underlying detector throws, this throws too rather
 * than returning unredacted text — callers (tool handlers) already catch
 * and turn errors into an error response, which is preferable to leaking
 * raw customer PII to the client.
 */
export async function redactText(input: string | undefined | null): Promise<string> {
  if (!enabled) return input ?? "";
  if (!input) return "";
  try {
    const result = await getRedactor().detect(input);
    return result.redacted;
  } catch (err) {
    logger.error("redaction failed, refusing to return unredacted text", {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    throw new Error("PII redaction failed");
  }
}

/**
 * Redact specific string fields on an object in-place. Mutates `obj` and
 * returns it for fluent use. Non-string fields are left untouched.
 */
export async function redactFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly (keyof T)[],
): Promise<T> {
  if (!enabled) return obj;
  for (const field of fields) {
    const v = obj[field];
    if (typeof v === "string" && v.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (obj as any)[field] = await redactText(v);
    }
  }
  return obj;
}

/**
 * Redact an array of thread-shaped objects: the free-text `body` gets a
 * detector pass, the recipient envelope (`to`/`cc`/`bcc`) is tokenized, and
 * the person-shaped fields (`customer`, `createdBy`, `assignedTo`) go through
 * `redactCustomerFields`.
 *
 * The envelope matters as much as the body. Help Scout returns recipient
 * addresses and a `createdBy.email` on every thread, and the typed `Thread`
 * shape modelled neither `to`/`cc`/`bcc` nor a redaction pass over them, so
 * raw addresses reached callers untouched while bodies came back clean.
 */
export async function redactThreads<
  T extends {
    body?: string;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    customer?: unknown;
    createdBy?: unknown;
    assignedTo?: unknown;
  },
>(threads: T[]): Promise<T[]> {
  if (!enabled) return threads;
  return Promise.all(
    threads.map(async (t) => {
      const out = { ...t } as Record<string, unknown>;
      if (typeof out.body === "string") out.body = await redactText(out.body);
      for (const field of ["to", "cc", "bcc"] as const) {
        if (Array.isArray(out[field])) {
          out[field] = (out[field] as unknown[]).map(() => "[EMAIL_REDACTED]");
        }
      }
      for (const field of ["customer", "createdBy", "assignedTo"] as const) {
        const person = out[field];
        if (person && typeof person === "object") {
          out[field] = await redactCustomerFields(person as object);
        }
      }
      return out as T;
    }),
  );
}

/**
 * Redact a Help Scout customer-shaped object's PII fields.
 * email/phone are literal token replacement — those fields ARE the PII,
 * no detection step needed. `location`/`background` are free text (bio-like
 * fields that can embed addresses/etc.) so they get a detector pass.
 * `firstName`/`lastName`/`jobTitle` are deliberately left untouched — names
 * are useful context for triage/reporting and aren't redacted anywhere in
 * this module (see `includeNames: false` on the detector).
 */
export async function redactCustomerFields<T extends object>(customer: T): Promise<T> {
  if (!enabled) return customer;
  const out = { ...customer } as Record<string, unknown>;
  if (typeof out.email === "string" && out.email) out.email = "[EMAIL_REDACTED]";
  // `primaryEmail` is a synthetic field listCustomers lifts out of _embedded.emails.
  if (typeof out.primaryEmail === "string" && out.primaryEmail) out.primaryEmail = "[EMAIL_REDACTED]";
  if (typeof out.phone === "string" && out.phone) out.phone = "[PHONE_REDACTED]";
  if (typeof out.location === "string" && out.location) out.location = await redactText(out.location);
  if (typeof out.background === "string" && out.background)
    out.background = await redactText(out.background);
  return out as T;
}

/**
 * Redact the embedded `customer` field on each conversation-shaped record so
 * list/search results don't leak names/emails into LLM context or logs. Returns
 * a new array; records without a customer object pass through untouched.
 */
export async function redactConversationCustomers<T extends { customer?: unknown }>(
  items: T[],
): Promise<T[]> {
  if (!enabled) return items;
  return Promise.all(
    items.map(async (item) =>
      item && typeof item.customer === "object" && item.customer
        ? { ...item, customer: await redactCustomerFields(item.customer as object) }
        : item,
    ),
  );
}

/** Redact a list of customer-shaped records (customer search/list tools). */
export async function redactCustomerList<T extends object>(customers: T[]): Promise<T[]> {
  if (!enabled) return customers;
  return Promise.all(customers.map((c) => redactCustomerFields(c)));
}

/**
 * Redact the free-text `subject`, `preview`, and embedded `customer` of each
 * conversation-shaped record. Subject lines and the list-view `preview`
 * snippet (Help Scout's last-message excerpt) routinely carry PII (names,
 * order/account details) same as thread bodies, so both need a detector
 * pass — the customer-field token swap alone isn't enough. `preview` isn't
 * in our typed Conversation shape but the raw Help Scout API response
 * includes it, and callers can pull it through via `fields` selection, so it
 * must be redacted here rather than relying on it being dropped.
 */
export async function redactConversationList<
  T extends { subject?: string; preview?: string; customer?: unknown },
>(items: T[]): Promise<T[]> {
  if (!enabled) return items;
  const withCustomer = await redactConversationCustomers(items);
  for (const item of withCustomer) {
    if (typeof item.subject === "string" && item.subject) {
      item.subject = await redactText(item.subject);
    }
    if (typeof item.preview === "string" && item.preview) {
      item.preview = await redactText(item.preview);
    }
  }
  return withCustomer;
}

/**
 * Redact a Help Scout organization-shaped object: `phones` are structured
 * PII (token swap, like contact values); `note` is free text (detector pass,
 * like a subject/body).
 */
export async function redactOrganizationFields<
  T extends { phones?: unknown; note?: unknown },
>(org: T): Promise<T> {
  if (!enabled) return org;
  const out = { ...org } as Record<string, unknown>;
  if (Array.isArray(out.phones)) {
    out.phones = (out.phones as unknown[]).map(() => "[PHONE_REDACTED]");
  }
  if (typeof out.note === "string" && out.note) {
    out.note = await redactText(out.note);
  }
  return out as T;
}

/**
 * Tokenize the `value` of each Help Scout contact record (email/phone/chat/
 * social/website). The value IS the PII, so swap it for a constant token
 * rather than running the pattern detector over a one-field string.
 */
export function redactContactValues<T extends { value?: unknown }>(items: T[], token: string): T[] {
  if (!enabled) return items;
  return items.map((item) =>
    typeof item.value === "string" && item.value ? { ...item, value: token } : item,
  );
}

/** Redact a Help Scout address-shaped object's location fields. */
export function redactAddressFields<T extends object>(address: T): T {
  if (!enabled) return address;
  const out = { ...address } as Record<string, unknown>;
  if (typeof out.city === "string" && out.city) out.city = "[CITY_REDACTED]";
  if (typeof out.state === "string" && out.state) out.state = "[STATE_REDACTED]";
  if (typeof out.postalCode === "string" && out.postalCode) out.postalCode = "[POSTAL_REDACTED]";
  if (Array.isArray(out.lines)) out.lines = (out.lines as unknown[]).map(() => "[ADDRESS_REDACTED]");
  return out as T;
}
