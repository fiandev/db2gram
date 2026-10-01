import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CryptoError } from "./errors.js";

/**
 * Envelope format (PRD §4.1):
 *   db2gram1.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>
 *
 * AES-256-GCM, 12-byte IV, 16-byte auth tag, key = 32 bytes from base64 SECRET_KEY.
 * The same envelope is used for config.yaml, backup archives and database URLs.
 */

export const ENVELOPE_PREFIX = "db2gram1";
export const ALGORITHM = "aes-256-gcm";
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/** IV encoded as unpadded base64url is always this long. */
const IV_B64URL_LEN = Buffer.alloc(IV_BYTES).toString("base64url").length; // 16
/** Auth tag encoded as unpadded base64url is always this long. */
const TAG_B64URL_LEN = Buffer.alloc(TAG_BYTES).toString("base64url").length; // 22
/** `db2gram1.<iv>.` prefix length. */
const HEADER_LEN = ENVELOPE_PREFIX.length + 1 + IV_B64URL_LEN + 1; // 24
/** `.<tag>` suffix length. */
const SUFFIX_LEN = 1 + TAG_B64URL_LEN; // 23

/**
 * Decode and validate a SECRET_KEY. Accepts raw base64 (standard or url-safe).
 * Throws when missing or not exactly 32 bytes.
 */
export function parseSecretKey(secret: string | undefined): Buffer {
  if (!secret || secret.trim() === "") {
    throw new CryptoError("SECRET_KEY is not set");
  }
  const key = Buffer.from(secret.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `SECRET_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Load the key from the process environment. */
export function loadSecretKey(): Buffer {
  return parseSecretKey(process.env.SECRET_KEY);
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}.`);
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new CryptoError(`encryption key must be ${KEY_BYTES} bytes`);
  }
}

/** Encrypt an arbitrary buffer, returning the utf8 envelope bytes. */
export function encryptBuffer(plain: Uint8Array, key: Buffer): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    `${ENVELOPE_PREFIX}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`,
    "utf8",
  );
}

/** Decrypt utf8 envelope bytes back to the original buffer. */
export function decryptBuffer(envelope: Uint8Array, key: Buffer): Buffer {
  assertKey(key);
  const parts = parseEnvelope(Buffer.from(envelope).toString("utf8"));
  const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
  decipher.setAuthTag(parts.tag);
  try {
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  } catch (err) {
    throw new CryptoError("failed to decrypt (wrong SECRET_KEY or corrupted data)", { cause: err });
  }
}

export function encryptString(plaintext: string, key: Buffer): string {
  return encryptBuffer(Buffer.from(plaintext, "utf8"), key).toString("utf8");
}

export function decryptString(envelope: string, key: Buffer): string {
  return decryptBuffer(Buffer.from(envelope, "utf8"), key).toString("utf8");
}

interface EnvelopeParts {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function parseEnvelope(envelope: string): EnvelopeParts {
  const first = envelope.indexOf(".");
  const second = envelope.indexOf(".", first + 1);
  const last = envelope.lastIndexOf(".");
  if (first === -1 || second === -1 || last <= second) {
    throw new CryptoError("malformed envelope: expected db2gram1.<iv>.<ct>.<tag>");
  }
  if (envelope.slice(0, first) !== ENVELOPE_PREFIX) {
    throw new CryptoError(`unsupported envelope version (expected ${ENVELOPE_PREFIX})`);
  }
  const iv = Buffer.from(envelope.slice(first + 1, second), "base64url");
  const ciphertext = Buffer.from(envelope.slice(second + 1, last), "base64url");
  const tag = Buffer.from(envelope.slice(last + 1), "base64url");
  if (iv.length !== IV_BYTES) throw new CryptoError("malformed envelope: bad IV length");
  if (tag.length !== TAG_BYTES) throw new CryptoError("malformed envelope: bad auth tag length");
  return { iv, ciphertext, tag };
}

/**
 * Transform: bytes -> unpadded base64url string.
 * Buffers the trailing 0-2 bytes so encoded chunks concatenate without padding
 * artifacts (critical for streaming large files).
 */
class Base64UrlEncoder extends Transform {
  #remainder: Buffer = Buffer.alloc(0);

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buf = this.#remainder.length ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const usable = buf.length - (buf.length % 3);
    if (usable > 0) this.push(buf.subarray(0, usable).toString("base64url"));
    this.#remainder = Buffer.from(buf.subarray(usable));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.#remainder.length > 0) this.push(this.#remainder.toString("base64url"));
    callback();
  }
}

/**
 * Transform: base64url text -> bytes.
 * Buffers the trailing 0-3 chars so decode boundaries stay aligned.
 */
class Base64UrlDecoder extends Transform {
  #remainder = "";

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.#remainder + chunk.toString("ascii");
    const usable = text.length - (text.length % 4);
    if (usable > 0) this.push(Buffer.from(text.slice(0, usable), "base64url"));
    this.#remainder = text.slice(usable);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.#remainder.length > 0) this.push(Buffer.from(this.#remainder, "base64url"));
    callback();
  }
}

/**
 * Transform that emits the envelope header, streams base64url ciphertext and
 * appends the auth tag on flush. The tag is only available once the cipher has
 * finished, which is exactly when this transform flushes.
 */
class EnvelopeWriter extends Transform {
  #remainder: Buffer = Buffer.alloc(0);
  #wroteHeader = false;

  constructor(
    private readonly header: string,
    private readonly getTag: () => Buffer,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.#wroteHeader) {
      this.push(this.header);
      this.#wroteHeader = true;
    }
    const buf = this.#remainder.length ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const usable = buf.length - (buf.length % 3);
    if (usable > 0) this.push(buf.subarray(0, usable).toString("base64url"));
    this.#remainder = Buffer.from(buf.subarray(usable));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.#wroteHeader) {
      this.push(this.header);
      this.#wroteHeader = true;
    }
    if (this.#remainder.length > 0) this.push(this.#remainder.toString("base64url"));
    this.push(`.${this.getTag().toString("base64url")}`);
    callback();
  }
}

/** Streaming encrypt: file -> envelope file. Never buffers the whole input. */
export async function encryptFile(input: string, output: string, key: Buffer): Promise<void> {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const writer = new EnvelopeWriter(
    `${ENVELOPE_PREFIX}.${iv.toString("base64url")}.`,
    () => cipher.getAuthTag(),
  );
  try {
    await pipeline(
      createReadStream(input),
      cipher,
      writer,
      createWriteStream(output, { mode: 0o600 }),
    );
  } catch (err) {
    throw new CryptoError(`failed to encrypt ${input}`, { cause: err });
  }
}

/** Streaming decrypt: envelope file -> plaintext file. Never buffers the whole input. */
export async function decryptFile(input: string, output: string, key: Buffer): Promise<void> {
  assertKey(key);
  const info = await stat(input);
  const size = info.size;
  if (size < HEADER_LEN + SUFFIX_LEN) {
    throw new CryptoError(`malformed envelope file (too short): ${input}`);
  }

  const handle = await open(input, "r");
  try {
    const headerBuf = Buffer.alloc(HEADER_LEN);
    await handle.read(headerBuf, 0, HEADER_LEN, 0);
    const header = headerBuf.toString("ascii");
    if (!header.startsWith(`${ENVELOPE_PREFIX}.`) || !header.endsWith(".")) {
      throw new CryptoError(`malformed envelope header in ${input}`);
    }
    const iv = Buffer.from(header.slice(ENVELOPE_PREFIX.length + 1, HEADER_LEN - 1), "base64url");
    if (iv.length !== IV_BYTES) throw new CryptoError(`malformed envelope IV in ${input}`);

    const suffixBuf = Buffer.alloc(SUFFIX_LEN);
    await handle.read(suffixBuf, 0, SUFFIX_LEN, size - SUFFIX_LEN);
    const suffix = suffixBuf.toString("ascii");
    if (!suffix.startsWith(".")) throw new CryptoError(`malformed envelope trailer in ${input}`);
    const tag = Buffer.from(suffix.slice(1), "base64url");
    if (tag.length !== TAG_BYTES) throw new CryptoError(`malformed envelope tag in ${input}`);

    const ciphertextStart = HEADER_LEN;
    const ciphertextEnd = size - SUFFIX_LEN; // exclusive
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    if (ciphertextEnd <= ciphertextStart) {
      // Empty plaintext: still authenticate the envelope, then emit an empty file.
      try {
        decipher.final();
      } catch (err) {
        throw new CryptoError("failed to decrypt (wrong SECRET_KEY or corrupted data)", { cause: err });
      }
      await writeFile(output, Buffer.alloc(0), { mode: 0o600 });
      return;
    }

    try {
      await pipeline(
        createReadStream(input, { start: ciphertextStart, end: ciphertextEnd - 1 }),
        new Base64UrlDecoder(),
        decipher,
        createWriteStream(output, { mode: 0o600 }),
      );
    } catch (err) {
      throw new CryptoError("failed to decrypt (wrong SECRET_KEY or corrupted data)", { cause: err });
    }
  } finally {
    await handle.close();
  }
}

export { Base64UrlEncoder, Base64UrlDecoder };
