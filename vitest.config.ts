import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./src/__tests__/stubs/cloudflare-workers.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
    // Inlined so the alias above reaches the provider's `cloudflare:workers` import.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
