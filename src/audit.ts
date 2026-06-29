/**
 * Append-only audit log of every tool invocation.
 *
 * Internal-tool insurance: when something goes wrong (data leak, malformed
 * automation, suspicious pattern), you want a record of who called what and
 * when. The log goes to a D1 database bound as AUDIT_DB; if the binding is
 * absent, audit logging is a silent no-op.
 *
 * Schema (run once via `wrangler d1 execute`):
 *
 *   CREATE TABLE IF NOT EXISTS tool_audit (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     ts INTEGER NOT NULL,           -- ms since epoch
 *     email TEXT NOT NULL,
 *     tool TEXT NOT NULL,
 *     args_hash TEXT,                -- SHA-256 of stringified args (avoids PII)
 *     duration_ms INTEGER,
 *     status TEXT NOT NULL,          -- "ok" | "error"
 *     error_code TEXT
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_tool_audit_email_ts ON tool_audit (email, ts DESC);
 */

import { logger } from "./logger";

export interface AuditEntry {
  email: string;
  tool: string;
  args: unknown;
  durationMs: number;
  status: "ok" | "error";
  errorCode?: string;
}

interface AuditEnv {
  AUDIT_DB?: D1Database;
}

async function hashArgs(args: unknown): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(args ?? null));
  const buf = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Record a tool call. Best-effort — never throws. */
export async function recordToolCall(env: AuditEnv, entry: AuditEntry): Promise<void> {
  if (!env.AUDIT_DB) return;
  try {
    const argsHash = await hashArgs(entry.args);
    await env.AUDIT_DB.prepare(
      `INSERT INTO tool_audit (ts, email, tool, args_hash, duration_ms, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        Date.now(),
        entry.email,
        entry.tool,
        argsHash,
        entry.durationMs,
        entry.status,
        entry.errorCode ?? null,
      )
      .run();
  } catch (err) {
    // Audit failures must NOT break tool calls. Log and move on.
    logger.warn("audit log write failed", {
      error: err instanceof Error ? err.message : String(err),
      tool: entry.tool,
    });
  }
}

/**
 * Monkey-patch `server.tool` so every registered handler is timed and audit-logged.
 * Call once before `registerTools(server, api)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function instrumentServerForAudit(server: any, env: AuditEnv, email: string): void {
  if (!env.AUDIT_DB) return;
  const original = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool = function patched(...args: any[]) {
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    const toolName = args[0];
    if (typeof handler !== "function") return original(...args);
    args[handlerIndex] = async (input: unknown) => {
      const start = Date.now();
      try {
        const result = await handler(input);
        // CallToolResult signals errors via isError flag, not by throwing.
        const isErr = Boolean(result?.isError);
        await recordToolCall(env, {
          email,
          tool: toolName,
          args: input,
          durationMs: Date.now() - start,
          status: isErr ? "error" : "ok",
        });
        return result;
      } catch (err) {
        await recordToolCall(env, {
          email,
          tool: toolName,
          args: input,
          durationMs: Date.now() - start,
          status: "error",
          errorCode: err instanceof Error ? err.name : "UnknownError",
        });
        throw err;
      }
    };
    return original(...args);
  };
}
