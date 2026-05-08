/**
 * Shared types and KV key helpers for the Help Scout MCP Worker.
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;

  // Google OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Optional: restrict login to a specific Google Workspace domain (e.g. "example.com"). */
  GOOGLE_HOSTED_DOMAIN?: string;

  // Help Scout OAuth
  HELPSCOUT_APP_ID: string;
  HELPSCOUT_APP_SECRET: string;

  // Cookie signing
  COOKIE_ENCRYPTION_KEY: string;
}

/**
 * Props carried by the OAuthProvider into each McpAgent session.
 * Populated by auth-handler's completeAuthorization call.
 */
export interface Props {
  email: string;
  name: string;
  [key: string]: unknown;
}

/** Per-user Help Scout OAuth record stored in KV. */
export interface HelpScoutTokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis when the access token expires. */
  expiresAt: number;
}

export const helpScoutTokensKey = (email: string): string =>
  `hs:tokens:${email.toLowerCase()}`;
