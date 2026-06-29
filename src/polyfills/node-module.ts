/**
 * Polyfill for `node:module` in Cloudflare Workers.
 *
 * Some npm packages (e.g. openredaction) call `createRequire(import.meta.url)`
 * as a CJS compatibility shim. In the Workers runtime `import.meta.url` is
 * undefined, causing a validation error (code 10021) at deploy time.
 *
 * Wrangler's `alias` config rewrites `node:module` imports to this file before
 * bundling, so the shim is dead code at runtime — openredaction never actually
 * calls `require()`, it only constructs the helper at module init.
 */

/**
 * Minimal shape of Node's `require` function. The worker tsconfig only loads
 * `@cloudflare/workers-types`, so Node's `NodeRequire` global is not in scope —
 * we declare just enough here for the shim to type-check.
 */
interface RequireShim {
  (id: string): never;
  resolve: { (id: string): never; paths(request: string): string[] | null };
  cache: Record<string, unknown>;
  extensions: Record<string, unknown>;
  main: undefined;
}

export function createRequire(_filename: string | URL): RequireShim {
  const req = function require(_id: string): never {
    throw new Error("Cannot use require() in Cloudflare Workers.");
  } as unknown as RequireShim;
  req.resolve = (() => {
    throw new Error("Not supported");
  }) as unknown as RequireShim["resolve"];
  req.resolve.paths = () => null;
  req.cache = {};
  req.extensions = {};
  req.main = undefined;
  return req;
}

export function isBuiltin(_moduleName: string): boolean {
  return false;
}

export function findSourceMap(): undefined {
  return undefined;
}

export function syncBuiltinESMExports(): void {}

export default { createRequire, isBuiltin, findSourceMap, syncBuiltinESMExports };
