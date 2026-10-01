import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PackagingError } from "../src/errors.js";
import {
  decryptArchive,
  encryptArchive,
  joinFiles,
  splitFile,
  unzipFile,
  verifySha256,
  zipFile,
} from "../src/packaging.js";
import { sha256File } from "../src/util.js";

const KEY = randomBytes(32);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tgdb-packaging-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeBigFile(path: string, totalBytes: number): Promise<void> {
  const block = randomBytes(1024 * 1024);
  const out = createWriteStream(path);
  let written = 0;
  while (written < totalBytes) {
    const slice = block.subarray(0, Math.min(block.length, totalBytes - written));
    if (!out.write(slice)) await once(out, "drain");
    written += slice.length;
  }
  out.end();
  await once(out, "finish");
}

describe("packaging", () => {
  it("splits 120MB into 3 chunks and rejoins to the same checksum", async () => {
    const big = join(dir, "dump.sql");
    await writeBigFile(big, 120 * 1024 * 1024);
    const originalSha = await sha256File(big);

    const parts = await splitFile(big, 48 * 1024 * 1024, dir, "dump.sql");
    expect(parts.map((p) => p.part)).toEqual([1, 2, 3]);
    expect(parts.map((p) => p.sizeBytes)).toEqual([
      48 * 1024 * 1024,
      48 * 1024 * 1024,
      24 * 1024 * 1024,
    ]);
    for (const part of parts) await verifySha256(part.path, part.sha256);

    const joined = join(dir, "joined.sql");
    const joinedSha = await joinFiles(
      parts.map((p) => p.path),
      joined,
    );
    expect(joinedSha).toBe(originalSha);
    expect(await sha256File(joined)).toBe(originalSha);
  });

  it("zips, encrypts, decrypts and unzips while preserving content", async () => {
    const sql = join(dir, "small.sql");
    const content = "-- dump\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n";
    await writeFile(sql, content);

    const zip = join(dir, "small.zip");
    const result = await zipFile(sql, zip);
    expect(result.dumpSha256).toHaveLength(64);
    expect(result.archiveSha256).toHaveLength(64);

    const enc = join(dir, "small.zip.enc");
    await encryptArchive(zip, enc, KEY);
    const zipBack = join(dir, "small.back.zip");
    await decryptArchive(enc, zipBack, KEY);
    await verifySha256(zipBack, result.archiveSha256);

    const outDir = join(dir, "unzipped");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const sqlBack = await unzipFile(zipBack, outDir);
    expect(await readFile(sqlBack, "utf8")).toBe(content);
  });

  it("verifySha256 rejects a mismatch", async () => {
    const file = join(dir, "check.txt");
    await writeFile(file, "abc");
    await expect(verifySha256(file, "0".repeat(64))).rejects.toBeInstanceOf(PackagingError);
  });

  it("still produces one part for empty input", async () => {
    const empty = join(dir, "empty.sql");
    await writeFile(empty, Buffer.alloc(0));
    const parts = await splitFile(empty, 1024, dir, "empty.sql");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.sizeBytes).toBe(0);
  });
});
