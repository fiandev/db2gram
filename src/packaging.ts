import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import archiver from "archiver";
import unzipper from "unzipper";
import { decryptFile, encryptFile } from "./crypto.js";
import { PackagingError } from "./errors.js";
import { sha256File } from "./util.js";

export interface ChunkInfo {
  part: number;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ZipResult {
  zipPath: string;
  /** SHA-256 of the original SQL dump. */
  dumpSha256: string;
  /** SHA-256 of the produced zip archive. */
  archiveSha256: string;
}

/** Zip a single SQL file into a streaming archive. */
export async function zipFile(sqlPath: string, zipPath: string): Promise<ZipResult> {
  const dumpSha256 = await sha256File(sqlPath);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath, { mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(sqlPath, { name: basename(sqlPath) });
    void archive.finalize();
  });

  const archiveSha256 = await sha256File(zipPath);
  return { zipPath, dumpSha256, archiveSha256 };
}

/** Extract a zip and return the path of the single SQL file it contains. */
export async function unzipFile(zipPath: string, outDir: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: outDir }))
      .on("close", resolve)
      .on("error", reject);
  });
  const entries = await readdir(outDir);
  const sql = entries.find((entry) => entry.endsWith(".sql"));
  if (!sql) {
    throw new PackagingError(`archive ${zipPath} did not contain a .sql file`);
  }
  return join(outDir, sql);
}

/** Encrypt a zip archive into a db2gram1 envelope file. */
export async function encryptArchive(zipPath: string, encPath: string, key: Buffer): Promise<void> {
  await encryptFile(zipPath, encPath, key);
}

/** Decrypt a db2gram1 envelope file back into a zip archive. */
export async function decryptArchive(encPath: string, zipPath: string, key: Buffer): Promise<void> {
  await decryptFile(encPath, zipPath, key);
}

function partPath(baseName: string, dir: string, part: number): string {
  return join(dir, `${baseName}.part${part}`);
}

/**
 * Split a file into parts of at most `chunkSizeBytes`, computing a SHA-256 for
 * each part. Returns parts in order. Streams; never buffers the whole file.
 */
export async function splitFile(
  inputPath: string,
  chunkSizeBytes: number,
  outDir: string,
  baseName: string,
): Promise<ChunkInfo[]> {
  if (chunkSizeBytes <= 0) throw new PackagingError("chunk size must be positive");
  const parts: ChunkInfo[] = [];

  let part = 0;
  let written = 0;
  let hash = createHash("sha256");
  let out: ReturnType<typeof createWriteStream> | undefined;

  const closePart = async (): Promise<void> => {
    if (!out) return;
    out.end();
    await once(out, "finish");
    parts.push({
      part,
      path: partPath(baseName, outDir, part),
      sizeBytes: written,
      sha256: hash.digest("hex"),
    });
    out = undefined;
  };

  const source = createReadStream(inputPath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of source) {
    const buf = chunk as Buffer;
    let offset = 0;
    while (offset < buf.length) {
      if (!out) {
        part += 1;
        written = 0;
        hash = createHash("sha256");
        out = createWriteStream(partPath(baseName, outDir, part), { mode: 0o600 });
      }
      const space = chunkSizeBytes - written;
      const slice = buf.subarray(offset, offset + space);
      if (!out.write(slice)) await once(out, "drain");
      hash.update(slice);
      offset += slice.length;
      written += slice.length;
      if (written === chunkSizeBytes) await closePart();
    }
  }
  await closePart();

  if (parts.length === 0) {
    // Empty input still yields one (empty) part so the manifest stays valid.
    const emptyHash = createHash("sha256").digest("hex");
    const path = partPath(baseName, outDir, 1);
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(path, { mode: 0o600 });
      ws.on("finish", resolve);
      ws.on("error", reject);
      ws.end();
    });
    parts.push({ part: 1, path, sizeBytes: 0, sha256: emptyHash });
  }
  return parts;
}

/** Concatenate parts in order, returning the SHA-256 of the joined result. */
export async function joinFiles(parts: string[], outputPath: string): Promise<string> {
  const hash = createHash("sha256");
  const out = createWriteStream(outputPath, { mode: 0o600 });
  const finished = once(out, "finish");
  for (const part of parts) {
    for await (const chunk of createReadStream(part)) {
      const buf = chunk as Buffer;
      hash.update(buf);
      if (!out.write(buf)) await once(out, "drain");
    }
  }
  out.end();
  await finished;
  return hash.digest("hex");
}

/** Throw when a file's SHA-256 does not match the expected digest. */
export async function verifySha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new PackagingError(
      `checksum mismatch for ${basename(path)}: expected ${expected}, got ${actual}`,
    );
  }
}
