import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptString } from "../src/crypto.js";
import { ManifestError } from "../src/errors.js";
import {
  buildManifest,
  databaseUrlFromManifest,
  manifestFileName,
  parseManifest,
  serializeManifest,
  type DatabaseManifestInput,
} from "../src/manifest.js";

const KEY = randomBytes(32);

const INPUT: DatabaseManifestInput = {
  name: "main-app",
  dialect: "postgres",
  databaseUrl: "postgresql://user:pass@host:5432/dbname",
  dumpSha256: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  chunks: [
    { part: 1, fileId: "BQACAgUAAxkBAA", sizeBytes: 50_331_648, sha256: "c".repeat(64) },
    { part: 2, fileId: "BQACAgUAAxkBAB", sizeBytes: 12_345_678, sha256: "d".repeat(64) },
  ],
};

describe("manifest", () => {
  it("builds a manifest with an encrypted database URL", () => {
    const manifest = buildManifest([INPUT], KEY);
    expect(manifest.version).toBe(1);
    expect(manifest.tool).toBe("tgdb-backup");
    const db = manifest.databases[0]!;
    expect(db.database_url_enc.startsWith("tgdb1.")).toBe(true);
    expect(db.database_url_enc).not.toContain("pass");
    expect(decryptString(db.database_url_enc, KEY)).toBe(INPUT.databaseUrl);
    expect(databaseUrlFromManifest(db, KEY)).toBe(INPUT.databaseUrl);
  });

  it("round-trips JSON and YAML", () => {
    const manifest = buildManifest([INPUT], KEY);
    for (const format of ["json", "yaml"] as const) {
      const text = serializeManifest(manifest, format);
      const parsed = parseManifest(text);
      expect(parsed).toEqual(manifest);
    }
  });

  it("rejects malformed manifests", () => {
    expect(() => parseManifest('{"version":2}')).toThrow(ManifestError);
    expect(() => parseManifest("not: [valid")).toThrow(ManifestError);
  });

  it("names manifest files with the chosen format", () => {
    expect(manifestFileName("json")).toMatch(/^manifest-.*\.json$/);
    expect(manifestFileName("yaml")).toMatch(/^manifest-.*\.yaml$/);
  });
});
