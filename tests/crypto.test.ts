import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptBuffer,
  decryptFile,
  decryptString,
  encryptBuffer,
  encryptFile,
  encryptString,
  isEnvelope,
  parseSecretKey,
} from "../src/crypto.js";
import { CryptoError } from "../src/errors.js";
import { sha256Buffer, sha256File } from "../src/util.js";

const KEY = randomBytes(32);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "db2gram-crypto-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("crypto: AES-256-GCM envelope", () => {
  it("round-trips strings", () => {
    const plaintext = "postgresql://user:p@ss@host:5432/db\n";
    const envelope = encryptString(plaintext, KEY);
    expect(isEnvelope(envelope)).toBe(true);
    expect(decryptString(envelope, KEY)).toBe(plaintext);
  });

  it("emits db2gram1.<iv>.<ct>.<tag> with fixed iv/tag lengths", () => {
    const envelope = encryptString("hello", KEY);
    const parts = envelope.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("db2gram1");
    expect(Buffer.from(parts[1]!, "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[3]!, "base64url")).toHaveLength(16);
  });

  it("round-trips binary buffers", () => {
    const data = randomBytes(4096);
    const envelope = encryptBuffer(data, KEY);
    expect(decryptBuffer(envelope, KEY).equals(data)).toBe(true);
  });

  it("fails to decrypt with the wrong key", () => {
    const envelope = encryptString("secret", KEY);
    expect(() => decryptString(envelope, randomBytes(32))).toThrow(CryptoError);
  });

  it("fails on tampered ciphertext", () => {
    const envelope = encryptString("secret", KEY);
    const parts = envelope.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA.${parts[3]}`;
    expect(() => decryptString(tampered, KEY)).toThrow(CryptoError);
  });

  it("validates SECRET_KEY length", () => {
    expect(() => parseSecretKey(undefined)).toThrow(CryptoError);
    expect(() => parseSecretKey(Buffer.from("short").toString("base64"))).toThrow(CryptoError);
    const good = randomBytes(32).toString("base64");
    expect(parseSecretKey(good)).toHaveLength(32);
  });

  it("streams a large file through encrypt/decrypt unchanged", async () => {
    const input = join(dir, "big.bin");
    const enc = join(dir, "big.bin.enc");
    const out = join(dir, "big.out");
    // Crosses many 64KiB stream boundaries and the 3-byte base64 grouping.
    const data = randomBytes(5 * 1024 * 1024 + 7);
    await writeFile(input, data);

    await encryptFile(input, enc, KEY);
    const head = (await readFile(enc, "utf8")).slice(0, 9);
    expect(head).toBe("db2gram1.");

    await decryptFile(enc, out, KEY);
    expect(await sha256File(out)).toBe(sha256Buffer(data));
  });

  it("streams an empty file through the envelope", async () => {
    const input = join(dir, "empty.bin");
    const enc = join(dir, "empty.bin.enc");
    const out = join(dir, "empty.out");
    await writeFile(input, Buffer.alloc(0));
    await encryptFile(input, enc, KEY);
    await decryptFile(enc, out, KEY);
    expect((await readFile(out)).length).toBe(0);
  });
});
