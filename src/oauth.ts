/**
 * OAuth wiring for the worker. `/mcp` and `/docs/mcp` are separate OAuth
 * resources under one authorization server: the requested resource is how
 * `/authorize` picks the Help Scout flow or the Docs API-key form, and each
 * token is only accepted by the endpoint it was issued for.
 *
 * Kept apart from `index.ts` so tests can run the full flow without the
 * `agents/mcp` / `cloudflare:` module graph.
 */
import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import type { Env, Props } from "./types";

interface FetchHandler<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface OAuthRouterHandlers {
  /** Serves `/mcp`; receives `ctx.props` from the validated token. */
  mailbox: FetchHandler<Env>;
  /** Serves `/docs/mcp`; receives `ctx.props` from the validated token. */
  docs: FetchHandler<Env>;
  /** Everything the authorization server doesn't own: `/authorize`, callbacks, forms. */
  app: FetchHandler<Env & { OAUTH_PROVIDER: OAuthHelpers }>;
}

const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

/** The resource path itself, anything under it, or its RFC 9728 metadata URL. */
function isResourcePath(pathname: string, resourcePath: string): boolean {
  return (
    pathname === resourcePath ||
    pathname.startsWith(`${resourcePath}/`) ||
    pathname === `${PROTECTED_RESOURCE_METADATA}${resourcePath}`
  );
}

export function createOAuthRouter(
  issuerOrigin: string,
  handlers: OAuthRouterHandlers,
): { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> } {
  const issuer = issuerOrigin.replace(/\/+$/, "");
  const mailboxResource = `${issuer}/mcp`;
  const docsResource = `${issuer}/docs/mcp`;

  const authorizationServer = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [mailboxResource, docsResource],
    // Clients that omit `resource`, and grants issued before 1.x, are mailbox.
    defaultResource: mailboxResource,
    legacyGrantResource: mailboxResource,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
  });

  const resourceServer = (resource: string, handler: FetchHandler<Env>) =>
    new OAuthResourceServer<Env, Props>({
      resourceMetadata: { resource, authorization_servers: [issuer] },
      validateToken: (env) => (resource, token) =>
        authorizationServer.validateToken<Props>(resource, token, env),
      handler,
    });
  const mailbox = resourceServer(mailboxResource, handlers.mailbox);
  const docs = resourceServer(docsResource, handlers.docs);

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const { pathname } = new URL(request.url);
      if (isResourcePath(pathname, "/docs/mcp")) return docs.fetch(request, env, ctx);
      if (isResourcePath(pathname, "/mcp")) return mailbox.fetch(request, env, ctx);

      // Discovery, /token and /register belong to the authorization server; it
      // answers 404 for anything else, which is the app's.
      const response = await authorizationServer.fetch(request, env, ctx);
      if (response.status !== 404) return response;
      return handlers.app.fetch(
        request,
        { ...env, OAUTH_PROVIDER: authorizationServer.getOAuthApi(env) },
        ctx,
      );
    },
  };
}
