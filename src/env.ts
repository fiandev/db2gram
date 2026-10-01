import { EnvError } from "./errors.js";

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new EnvError(`required environment variable ${name} is not set`);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new EnvError(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

export const DEFAULT_CHUNK_SIZE_MB = 48;
export const DEFAULT_TMP_DIR = "/tmp/db2gram";

export function chunkSizeBytes(): number {
  return intEnv("CHUNK_SIZE_MB", DEFAULT_CHUNK_SIZE_MB) * 1024 * 1024;
}

export function tmpDir(): string {
  return optionalEnv("TMP_DIR") ?? DEFAULT_TMP_DIR;
}
