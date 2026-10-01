import { DialectError } from "../errors.js";
import type { Dialect } from "./types.js";

/** Registry of all known dialects, keyed by `Dialect.name`. */
export const DIALECTS = new Map<string, Dialect>();

export function registerDialect(dialect: Dialect): void {
  if (DIALECTS.has(dialect.name)) {
    throw new DialectError(`dialect "${dialect.name}" is already registered`);
  }
  DIALECTS.set(dialect.name, dialect);
}

/** Look up a dialect by name, throwing a helpful error when unknown. */
export function getDialect(name: string): Dialect {
  const dialect = DIALECTS.get(name);
  if (!dialect) {
    const known = [...DIALECTS.keys()].sort().join(", ") || "<none>";
    throw new DialectError(`unknown dialect "${name}" (registered: ${known})`);
  }
  return dialect;
}

export function hasDialect(name: string): boolean {
  return DIALECTS.has(name);
}

export function listDialects(): Dialect[] {
  return [...DIALECTS.values()];
}

/** Verify a connection URL uses a scheme the dialect advertises. */
export function assertUrlScheme(dialect: Dialect, url: string): void {
  if (!dialect.urlSchemes.some((scheme) => url.startsWith(scheme))) {
    throw new DialectError(
      `dialect "${dialect.name}" does not support URL "${url.split(":")[0]}://" (expected one of: ${dialect.urlSchemes.join(", ")})`,
    );
  }
}
