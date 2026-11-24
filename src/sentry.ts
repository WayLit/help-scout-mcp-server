/**
 * Optional error reporting to Sentry.
 *
 * Off unless the `SENTRY_DSN` secret is set: the SDK reads it from `env` and
 * sends nothing without it. The release is the Worker version id, from the
 * `CF_VERSION_METADATA` binding.
 *
 * Nothing that identifies a user or customer is sent: no request headers but a
 * few safe ones (Access JWTs and bearer tokens travel in headers), no cookies,
 * bodies, query strings or MCP payloads, and error messages go through the same
 * PII redaction as tool output (`REDACT_PII`).
 */
import type { Breadcrumb, CloudflareOptions, ErrorEvent } from "@sentry/cloudflare";

import { redactText } from "./redaction";

const KEPT_HEADERS = new Set(["content-type", "user-agent", "cf-ray", "accept"]);

function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

/** Drops credentials and request content, and redacts PII from error messages. */
export async function scrubEvent(event: ErrorEvent): Promise<ErrorEvent | null> {
  const req = event.request;
  if (req) {
    if (req.headers) {
      req.headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => KEPT_HEADERS.has(k.toLowerCase())),
      );
    }
    delete req.cookies;
    delete req.data;
    delete req.query_string;
    if (req.url) req.url = stripQuery(req.url);
  }
  delete event.user;
  try {
    if (event.message) event.message = await redactText(event.message);
    for (const ex of event.exception?.values ?? []) {
      if (ex.value) ex.value = await redactText(ex.value);
    }
  } catch {
    // Redaction failed: drop the event rather than send unredacted text.
    return null;
  }
  return event;
}

/** Drops query strings from fetch breadcrumbs and console messages, which may quote customer data. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "console") return null;
  if (crumb.data && typeof crumb.data.url === "string") crumb.data.url = stripQuery(crumb.data.url);
  return crumb;
}

export function sentryOptions(): CloudflareOptions {
  return {
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: [...KEPT_HEADERS] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
