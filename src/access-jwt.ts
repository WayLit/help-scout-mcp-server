/**
 * Cloudflare Access JWT verification.
 *
 * Every request to the worker is fronted by Cloudflare Access. Access injects
 * a signed JWT in the `Cf-Access-Jwt-Assertion` header (and as a cookie, but
 * we use the header form). We validate it against the team's JWKS endpoint.
 *
 * For service-token (headless) clients the JWT carries an email-shaped `sub`
 * but no `email` claim — we treat the principal as `<sub>` and tag the
 * identity as a service token so per-user data isolation still works.
 *
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";

import type { AccessIdentity, Env } from "./types";

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/** Cache one JWKS resolver per team domain — keyed across requests within a DO. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Test seam: tests can inject a fake JWKS resolver keyed by team domain.
 * Production uses `createRemoteJWKSet` against Cloudflare's certs endpoint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jwksFactory: ((teamDomain: string) => any) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setJwksFactoryForTesting(factory: ((teamDomain: string) => any) | null): void {
  jwksFactory = factory;
  jwksCache.clear();
}

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    if (jwksFactory) {
      jwks = jwksFactory(teamDomain);
    } else {
      const url = new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
      jwks = createRemoteJWKSet(url, {
        // Refresh JWKS at most every 10 min to bound key-rotation lag without
        // hammering Cloudflare on every request.
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
      });
    }
    jwksCache.set(teamDomain, jwks!);
  }
  return jwks!;
}

interface AccessClaims extends JWTPayload {
  email?: string;
  name?: string;
  /** Access marks service-token tokens with `common_name` and an empty `email`. */
  common_name?: string;
  /** Access groups, if you ever want to gate per-group. */
  groups?: string[];
}

export class AccessAuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AccessAuthError";
  }
}

/**
 * Verify the Cloudflare Access JWT on a request and return the identity.
 * Throws AccessAuthError if the token is missing, expired, or invalid.
 */
export async function verifyAccessJwt(request: Request, env: Env): Promise<AccessIdentity> {
  // Local-dev escape hatch — only honored under wrangler dev.
  if (env.BYPASS_ACCESS === "true") {
    if (env.WRANGLER_DEV !== "true") {
      throw new AccessAuthError(
        "BYPASS_ACCESS is set but the runtime is not wrangler dev — refusing.",
        500 as 401,
      );
    }
    return {
      email: "dev@localhost",
      name: "Local Dev",
      sub: "dev@localhost",
      isServiceToken: false,
    };
  }

  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new AccessAuthError(
      "Worker misconfigured: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set.",
      500 as 401,
    );
  }

  const token = request.headers.get(ACCESS_HEADER);
  if (!token) {
    throw new AccessAuthError("Missing Cf-Access-Jwt-Assertion header.");
  }

  const verifyOpts: JWTVerifyOptions = {
    issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`,
    audience: env.CF_ACCESS_AUD,
  };

  let payload: AccessClaims;
  try {
    const result = await jwtVerify<AccessClaims>(token, getJwks(env.CF_ACCESS_TEAM_DOMAIN), verifyOpts);
    payload = result.payload;
  } catch (err) {
    throw new AccessAuthError(
      `Access JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
      403,
    );
  }

  // Service tokens leave `email` empty and put the token's common_name in `common_name`.
  // Browser logins set `email` (and usually `name`).
  const isServiceToken = !payload.email && Boolean(payload.common_name);

  if (isServiceToken) {
    const sub = String(payload.sub ?? payload.common_name);
    return {
      email: sub,
      name: payload.common_name ?? sub,
      sub,
      isServiceToken: true,
    };
  }

  if (!payload.email || !payload.sub) {
    throw new AccessAuthError("Access JWT missing email/sub claims.", 403);
  }

  return {
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email,
    sub: String(payload.sub),
    isServiceToken: false,
  };
}
