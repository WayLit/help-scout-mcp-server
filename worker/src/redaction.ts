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
import { OpenRedaction } from "openredaction";

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
 * Best-effort: if the underlying detector throws, returns the original text
 * and logs — never block a tool response on redaction failure.
 */
export async function redactText(input: string | undefined | null): Promise<string> {
  if (!enabled) return input ?? "";
  if (!input) return "";
  try {
    const result = await getRedactor().detect(input);
    return result.redacted;
  } catch (err) {
    logger.error("redaction failed, returning original", {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    return input;
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

/** Convenience: deep-redact .body on an array of thread-shaped objects. */
export async function redactThreadBodies<T extends { body?: string }>(threads: T[]): Promise<T[]> {
  if (!enabled) return threads;
  for (const t of threads) {
    if (typeof t.body === "string") {
      t.body = await redactText(t.body);
    }
  }
  return threads;
}

/**
 * Redact a Help Scout customer-shaped object's PII fields.
 * Uses literal token replacement for structured PII (name/email/phone) rather
 * than running each tiny field through OpenRedaction's pattern engine — those
 * fields ARE the PII, no detection step needed.
 */
export function redactCustomerFields<T extends object>(customer: T): T {
  if (!enabled) return customer;
  const out = { ...customer } as Record<string, unknown>;
  if (typeof out.firstName === "string" && out.firstName) out.firstName = "[NAME_REDACTED]";
  if (typeof out.lastName === "string" && out.lastName) out.lastName = "[NAME_REDACTED]";
  if (typeof out.email === "string" && out.email) out.email = "[EMAIL_REDACTED]";
  if (typeof out.phone === "string" && out.phone) out.phone = "[PHONE_REDACTED]";
  return out as T;
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
