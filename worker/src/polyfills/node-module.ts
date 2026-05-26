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

export function createRequire(_filename: string | URL): NodeRequire {
  const req = function require(_id: string): never {
    throw new Error("Cannot use require() in Cloudflare Workers.");
  } as unknown as NodeRequire;
  req.resolve = (() => {
    throw new Error("Not supported");
  }) as NodeRequire["resolve"];
  req.resolve.paths = () => null;
  req.cache = {};
  req.extensions = {} as NodeRequire["extensions"];
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
