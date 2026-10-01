import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** SHA-256 (lowercase hex) of a buffer. */
export function sha256Buffer(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 (lowercase hex) of a file, computed by streaming. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function ensureParentDir(path: string): Promise<void> {
  await ensureDir(dirname(path));
}

/** Remove a file/dir, ignoring ENOENT. */
export async function removeQuiet(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Redact the password portion of a connection URL for safe logging. */
export function redactUrl(input: string): string {
  try {
    const u = new URL(input);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return input.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");
  }
}

/** Timestamp usable in filenames: 20261001-020000. */
export function fileStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort extraction of a hostname from a connection URL (for safety checks). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
