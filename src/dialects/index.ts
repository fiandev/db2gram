/**
 * Dialect registration entry point.
 *
 * Importing this module wires up every built-in adapter. Adding an engine:
 *   1. implement Dialect in dialects/<engine>.ts
 *   2. import it here and call registerDialect()
 * Core backup/restore code stays untouched.
 */
import { MariadbDialect } from "./mariadb.js";
import { PostgresDialect } from "./postgres.js";
import { registerDialect } from "./registry.js";

let registered = false;

export function registerBuiltinDialects(): void {
  if (registered) return;
  registerDialect(new MariadbDialect());
  registerDialect(new PostgresDialect());
  registered = true;
}

registerBuiltinDialects();

export { DIALECTS, getDialect, hasDialect, listDialects, assertUrlScheme } from "./registry.js";
export type { Dialect } from "./types.js";
