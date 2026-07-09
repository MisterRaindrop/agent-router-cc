// Injected by esbuild `define` at bundle time; undefined when running the
// TypeScript sources directly via `node src/index.ts` (dev / tests).
declare const __ROUTER_VERSION__: string | undefined;

export const VERSION: string =
  typeof __ROUTER_VERSION__ !== 'undefined' ? __ROUTER_VERSION__ : '0.0.0-dev';

/** Contract-freeze schema version. Validator rejects unknown major versions. */
export const SCHEMA_VERSION = 1 as const;

/** Runtime directory created inside a target project by `router init`. */
export const ROUTER_DIR = '.router';
