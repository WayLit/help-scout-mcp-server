/**
 * Help Scout MCP Server — Cloudflare Workers entry point.
 *
 * Wraps the McpAgent Durable Object with an OAuthProvider that chains
 * Google SSO (identity) and Help Scout Authorization Code (API access).
 * Each authenticated user gets their own session with their own Help Scout
 * tokens — no shared env-var credentials.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthHandler } from "./auth-handler";
import { HelpScoutAPI } from "./helpscout-api";
import { registerTools } from "./tools";
import type { Env, Props } from "./types";

export class HelpScoutMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "helpscout-mcp",
    version: "2.0.0",
  });

  async init(): Promise<void> {
    const email = this.props?.email;
    if (!email) {
      throw new Error("HelpScoutMCP initialized without user props");
    }
    const api = new HelpScoutAPI(this.env, email);
    registerTools(this.server, api);
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  // McpAgent.serve() returns a fetch handler suitable for apiHandler.
  // Cast is needed because the OAuthProvider generic signature expects
  // an ExportedHandler-like type but accepts Worker entrypoints.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: HelpScoutMCP.serve("/mcp") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
