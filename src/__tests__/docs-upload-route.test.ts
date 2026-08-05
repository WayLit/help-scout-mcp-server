import { describe, expect, it, vi } from "vitest";

import { AuthHandler } from "../auth-handler";
import { MAX_UPLOAD_BYTES, mintUploadToken } from "../docs-assets";
import type { Env } from "../types";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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

function fakeEnv() {
  const doFetch = vi.fn(async () => Response.json({ apiKey: "hs-key" }));
  const env = {
    OAUTH_KV: fakeKv(),
    MCP_OBJECT: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: doFetch })),
    },
  } as unknown as Env;
  return { env, doFetch };
}

function uploadRequest(token: string, body: BodyInit | FormData): Request {
  return new Request("https://hs-mcp.example.com/docs/assets/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body as BodyInit,
  });
}

function pngForm(bytes: Uint8Array = PNG_BYTES, name = "shot.png", type = "image/png"): FormData {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }), name);
  return form;
}

/**
 * A parseable multipart upload carrying an explicit `Content-Length`.
 *
 * Serializes the form once so the boundary and the declared length can
 * disagree the way a real oversized-looking-but-legal upload does.
 */
async function uploadRequestDeclaring(
  token: string,
  declaredLength: number,
  form: FormData = pngForm(),
): Promise<Request> {
  const serialized = new Request("https://hs-mcp.example.com/docs/assets/upload", {
    method: "POST",
    body: form,
  });
  const body = await serialized.arrayBuffer();
  return new Request("https://hs-mcp.example.com/docs/assets/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": serialized.headers.get("Content-Type") as string,
      "Content-Length": String(declaredLength),
    },
    body,
  });
}

/**
 * A chunked upload: a streamed body carrying no `Content-Length`, so the
 * declared-length screen has nothing to check and only the metered parse
 * stands between the caller and the isolate's memory.
 *
 * `pulls` counts how many chunks the source was actually asked for, which is
 * how a test tells "rejected after metering" from "drained, then rejected".
 * The init cast carries `duplex`, which Node requires for a streaming request
 * body and workerd ignores.
 */
function chunkedUploadRequest(
  token: string,
  contentType: string,
  chunks: Uint8Array[],
  pulls = { count: 0 },
): { request: Request; pulls: { count: number } } {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close();
        return;
      }
      pulls.count += 1;
      controller.enqueue(chunks[next++]);
    },
  });
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body,
    duplex: "half",
  } as unknown as RequestInit;
  return {
    request: new Request("https://hs-mcp.example.com/docs/assets/upload", init),
    pulls,
  };
}

describe("POST /docs/assets/upload", () => {
  it("uploads the file and returns Help Scout's asset payload", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { filelink: "https://cdn.example/shot.png", filename: "shot.png", width: 12, height: 34 },
          { status: 201 },
        ),
      );

    try {
      const res = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        filelink: "https://cdn.example/shot.png",
        filename: "shot.png",
        width: 12,
        height: 34,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a replayed token with 401", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      const first = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(first.status).toBe(201);

      const second = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(second.status).toBe(401);
      expect(await second.json()).toMatchObject({ error: "INVALID_UPLOAD_TOKEN" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects an unknown token with 401 and never calls Help Scout", async () => {
    const { env } = fakeEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(
        uploadRequest("a".repeat(64), pngForm()),
        undefined,
        env,
      );
      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a missing Authorization header with 401", async () => {
    const { env } = fakeEnv();
    const res = await AuthHandler.request(
      new Request("https://hs-mcp.example.com/docs/assets/upload", {
        method: "POST",
        body: pngForm(),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an oversized Content-Length with 413 before parsing the body", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(
        new Request("https://hs-mcp.example.com/docs/assets/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": String(11 * 1024 * 1024),
          },
          body: "ignored",
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "FILE_TOO_LARGE" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts a file at the limit whose Content-Length is inflated by multipart overhead", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      // Boundary lines and part headers push a legal 10 MiB file's body over
      // MAX_UPLOAD_BYTES; only `file.size` decides.
      const res = await AuthHandler.request(
        await uploadRequestDeclaring(token, MAX_UPLOAD_BYTES + 240),
        undefined,
        env,
      );
      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts a chunked upload that declares no Content-Length", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const serialized = new Request("https://hs-mcp.example.com/docs/assets/upload", {
      method: "POST",
      body: pngForm(),
    });
    const body = new Uint8Array(await serialized.arrayBuffer());
    const half = Math.floor(body.length / 2);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      const { request } = chunkedUploadRequest(
        token,
        serialized.headers.get("Content-Type") as string,
        [body.subarray(0, half), body.subarray(half)],
      );
      const res = await AuthHandler.request(request, undefined, env);
      expect(res.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("abandons a chunked body once it passes the cap instead of buffering it all", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    // One buffer enqueued repeatedly: the stream offers 16 MiB but the test
    // only ever holds 1 MiB, and the cap (10 MiB + overhead) should stop the
    // pulls around the 11th.
    const oneMiB = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 16 }, () => oneMiB);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const { request, pulls } = chunkedUploadRequest(
        token,
        "multipart/form-data; boundary=x",
        chunks,
      );
      const res = await AuthHandler.request(request, undefined, env);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "FILE_TOO_LARGE" });
      expect(fetchSpy).not.toHaveBeenCalled();
      // 11 pulls trip the cap, plus a chunk of stream read-ahead. The point is
      // that the remaining ~4 MiB were never asked for.
      expect(pulls.count).toBeLessThanOrEqual(13);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a request with no file field with 400", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const form = new FormData();
    form.set("notafile", "hello");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(uploadRequest(token, form), undefined, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "MISSING_FILE" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects an unparseable (non-multipart) body with 400 INVALID_INPUT", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(
        new Request("https://hs-mcp.example.com/docs/assets/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ not: "multipart" }),
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "INVALID_INPUT" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects bytes whose magic number is not an allowed image with 415", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    // Declares image/png but the bytes are HTML.
    const form = pngForm(new TextEncoder().encode("<!doctype html><script>x</script>"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(uploadRequest(token, form), undefined, env);
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: "UNSUPPORTED_IMAGE_TYPE" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects SVG with 415", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const form = pngForm(svg, "x.svg", "image/svg+xml");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await AuthHandler.request(uploadRequest(token, form), undefined, env);
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: "UNSUPPORTED_IMAGE_TYPE" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("forwards the sniffed content type to Help Scout, not the caller-declared one", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    // Genuine PNG bytes, but declares image/gif.
    const form = pngForm(PNG_BYTES, "shot.gif", "image/gif");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      const res = await AuthHandler.request(uploadRequest(token, form), undefined, env);
      expect(res.status).toBe(201);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentForm = init.body as FormData;
      const sentFile = sentForm.get("file") as File;
      expect(sentFile.type).toBe("image/png");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("surfaces a Help Scout failure with its mapped status, without echoing the upstream body", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("no such article", { status: 404 }));

    try {
      const res = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toMatchObject({ error: "NOT_FOUND" });
      expect(body.message).not.toContain("no such article");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns a fixed message for a non-HelpScoutApiError failure, not the raw internal error", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNRESET: internal stack detail"));

    try {
      const res = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toMatchObject({ error: "UNEXPECTED_ERROR", message: "Upload failed." });
      expect(body.message).not.toContain("ECONNRESET");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves the Docs API key for the email bound in the token, not the caller", async () => {
    const { env } = fakeEnv();
    const { token } = await mintUploadToken(env, "owner@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      const idFromName = (env.MCP_OBJECT as unknown as { idFromName: ReturnType<typeof vi.fn> })
        .idFromName;
      expect(idFromName).toHaveBeenCalledWith("owner@example.com");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("writes an audit row when AUDIT_DB is bound", async () => {
    const { env } = fakeEnv();
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) });
    (env as unknown as { AUDIT_DB: unknown }).AUDIT_DB = {
      prepare: vi.fn().mockReturnValue({ bind }),
    };
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ filelink: "u", filename: "f" }, { status: 201 }));

    try {
      await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(bind).toHaveBeenCalled();
      expect(bind.mock.calls[0]).toContain("uploadArticleImage");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('writes an audit row with status "error" when the Help Scout upload fails', async () => {
    const { env } = fakeEnv();
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) });
    (env as unknown as { AUDIT_DB: unknown }).AUDIT_DB = {
      prepare: vi.fn().mockReturnValue({ bind }),
    };
    const { token } = await mintUploadToken(env, "tester@example.com", "42");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("no such article", { status: 404 }));

    try {
      const res = await AuthHandler.request(uploadRequest(token, pngForm()), undefined, env);
      expect(res.status).toBe(404);
      expect(bind).toHaveBeenCalled();
      expect(bind.mock.calls[0]).toContain("error");
      expect(bind.mock.calls[0]).toContain("NOT_FOUND");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
