import { describe, expect, it, vi } from "vitest";

import {
  UPLOAD_TOKEN_TTL_SECONDS,
  consumeUploadToken,
  mintUploadToken,
  sniffImageMimeType,
} from "../docs-assets";
import type { Env } from "../types";

/** Minimal in-memory KV double. Ignores TTL expiry; TTL is asserted on the put call. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function fakeEnv(kv = fakeKv()): { env: Env; kv: ReturnType<typeof fakeKv> } {
  return { env: { OAUTH_KV: kv } as unknown as Env, kv };
}

describe("mintUploadToken", () => {
  it("returns a 64-char hex token and stores the record under upload:<token>", async () => {
    const { env, kv } = fakeEnv();

    const { token } = await mintUploadToken(env, "tester@example.com", "42", "shot.png");

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.put).toHaveBeenCalledWith(`upload:${token}`, expect.any(String), {
      expirationTtl: UPLOAD_TOKEN_TTL_SECONDS,
    });
    expect(JSON.parse(kv.store.get(`upload:${token}`) as string)).toEqual({
      email: "tester@example.com",
      articleId: "42",
      fileName: "shot.png",
    });
  });

  it("omits fileName from the record when not supplied", async () => {
    const { env, kv } = fakeEnv();

    const { token } = await mintUploadToken(env, "tester@example.com", "42");

    expect(JSON.parse(kv.store.get(`upload:${token}`) as string)).toEqual({
      email: "tester@example.com",
      articleId: "42",
    });
  });

  it("returns an ISO expiresAt roughly TTL seconds in the future", async () => {
    const { env } = fakeEnv();
    const before = Date.now();

    const { expiresAt } = await mintUploadToken(env, "tester@example.com", "42");

    const delta = new Date(expiresAt).getTime() - before;
    expect(delta).toBeGreaterThan((UPLOAD_TOKEN_TTL_SECONDS - 5) * 1000);
    expect(delta).toBeLessThanOrEqual((UPLOAD_TOKEN_TTL_SECONDS + 5) * 1000);
  });

  it("mints distinct tokens on successive calls", async () => {
    const { env } = fakeEnv();
    const a = await mintUploadToken(env, "tester@example.com", "42");
    const b = await mintUploadToken(env, "tester@example.com", "42");
    expect(a.token).not.toBe(b.token);
  });
});

describe("consumeUploadToken", () => {
  it("returns the record and deletes the key so the token is single-use", async () => {
    const { env, kv } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42", "shot.png");

    const first = await consumeUploadToken(env, token);
    expect(first).toEqual({
      email: "tester@example.com",
      articleId: "42",
      fileName: "shot.png",
    });
    expect(kv.delete).toHaveBeenCalledWith(`upload:${token}`);

    const second = await consumeUploadToken(env, token);
    expect(second).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const { env } = fakeEnv();
    expect(await consumeUploadToken(env, "deadbeef")).toBeNull();
  });

  it("returns null for an empty token without hitting KV", async () => {
    const { env, kv } = fakeEnv();
    expect(await consumeUploadToken(env, "")).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns null when the stored value is not valid JSON", async () => {
    const { env, kv } = fakeEnv();
    kv.store.set("upload:corrupt", "{not json");
    expect(await consumeUploadToken(env, "corrupt")).toBeNull();
  });
});

describe("sniffImageMimeType", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("identifies the four allowed formats", () => {
    expect(sniffImageMimeType(png)).toBe("image/png");
    expect(sniffImageMimeType(jpeg)).toBe("image/jpeg");
    expect(sniffImageMimeType(gif)).toBe("image/gif");
    expect(sniffImageMimeType(webp)).toBe("image/webp");
  });

  it("rejects SVG, which would be stored XSS on the Help Scout asset domain", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageMimeType(svg)).toBeNull();
  });

  it("rejects HTML, plain text, and empty input", () => {
    expect(sniffImageMimeType(new TextEncoder().encode("<!doctype html><p>hi"))).toBeNull();
    expect(sniffImageMimeType(new TextEncoder().encode("just text"))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array())).toBeNull();
  });

  it("rejects a RIFF container that is not WebP", () => {
    const riffAvi = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
    expect(sniffImageMimeType(riffAvi)).toBeNull();
  });
});
