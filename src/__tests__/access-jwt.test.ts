import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK, type KeyLike } from "jose";

import {
  AccessAuthError,
  __setJwksFactoryForTesting,
  verifyAccessJwt,
} from "../access-jwt";
import type { Env } from "../types";

const TEAM = "waylit";
const AUD = "test-aud-tag-1234567890abcdef";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;

let privateKey: KeyLike;
let publicJwk: JWK;

const env: Env = {
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  HELPSCOUT_APP_ID: "x",
  HELPSCOUT_APP_SECRET: "x",
} as unknown as Env;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), alg: "RS256", kid: "test-kid", use: "sig" };
});

beforeEach(() => {
  __setJwksFactoryForTesting(() => async () => {
    // jose's createRemoteJWKSet returns a function that accepts (header, token)
    // and resolves to a key. The local equivalent: return the public key itself
    // (jose imports JWK and validates the alg).
    const { importJWK } = await import("jose");
    return importJWK(publicJwk, "RS256");
  });
});

afterEach(() => {
  __setJwksFactoryForTesting(null);
});

async function makeRequest(token: string | null): Promise<Request> {
  const headers: Record<string, string> = {};
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return new Request("https://helpscout-mcp.waylit.ai/mcp", { headers });
}

async function signToken(claims: Record<string, unknown>, opts?: { expSeconds?: number; issuer?: string; audience?: string | string[] }): Promise<string> {
  const exp = opts?.expSeconds ?? 60;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? AUD)
    .setExpirationTime(`${exp}s`);
  return jwt.sign(privateKey);
}

describe("verifyAccessJwt", () => {
  it("returns identity for a valid browser-login JWT", async () => {
    const token = await signToken({
      sub: "user-sub-123",
      email: "alice@waylit.ai",
      name: "Alice",
    });
    const req = await makeRequest(token);
    const identity = await verifyAccessJwt(req, env);
    expect(identity).toEqual({
      email: "alice@waylit.ai",
      name: "Alice",
      sub: "user-sub-123",
      isServiceToken: false,
    });
  });

  it("lowercases the email", async () => {
    const token = await signToken({
      sub: "user-sub-123",
      email: "Alice@Waylit.AI",
    });
    const identity = await verifyAccessJwt(await makeRequest(token), env);
    expect(identity.email).toBe("alice@waylit.ai");
  });

  it("recognizes service-token JWTs", async () => {
    const token = await signToken({
      sub: "service-token-id.waylit",
      common_name: "claude-code-svc",
    });
    const identity = await verifyAccessJwt(await makeRequest(token), env);
    expect(identity.isServiceToken).toBe(true);
    expect(identity.email).toBe("service-token-id.waylit");
    expect(identity.name).toBe("claude-code-svc");
  });

  it("rejects missing header", async () => {
    await expect(verifyAccessJwt(await makeRequest(null), env)).rejects.toBeInstanceOf(
      AccessAuthError,
    );
  });

  it("rejects expired tokens", async () => {
    const token = await signToken({ sub: "x", email: "alice@waylit.ai" }, { expSeconds: -10 });
    await expect(verifyAccessJwt(await makeRequest(token), env)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects wrong audience", async () => {
    const token = await signToken(
      { sub: "x", email: "alice@waylit.ai" },
      { audience: "wrong-aud" },
    );
    await expect(verifyAccessJwt(await makeRequest(token), env)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects wrong issuer", async () => {
    const token = await signToken(
      { sub: "x", email: "alice@waylit.ai" },
      { issuer: "https://attacker.example.com" },
    );
    await expect(verifyAccessJwt(await makeRequest(token), env)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects browser tokens missing email or sub", async () => {
    const token = await signToken({ sub: "x" }); // no email, no common_name
    await expect(verifyAccessJwt(await makeRequest(token), env)).rejects.toMatchObject({
      status: 403,
    });
  });

  describe("BYPASS_ACCESS escape hatch", () => {
    it("returns dev identity when BYPASS_ACCESS=true and WRANGLER_DEV=true", async () => {
      const devEnv = { ...env, BYPASS_ACCESS: "true", WRANGLER_DEV: "true" } as Env;
      const identity = await verifyAccessJwt(await makeRequest(null), devEnv);
      expect(identity.email).toBe("dev@localhost");
    });

    it("refuses BYPASS_ACCESS without WRANGLER_DEV", async () => {
      const halfEnv = { ...env, BYPASS_ACCESS: "true" } as Env;
      await expect(verifyAccessJwt(await makeRequest(null), halfEnv)).rejects.toBeInstanceOf(
        AccessAuthError,
      );
    });
  });
});
