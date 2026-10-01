import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { decryptString, encryptString } from "./crypto.js";
import { ManifestError } from "./errors.js";

export const MANIFEST_VERSION = 1;
export const MANIFEST_TOOL = "tgdb-backup";

export const ManifestChunkSchema = z.object({
  part: z.number().int().positive(),
  file_id: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

export const ManifestDatabaseSchema = z.object({
  name: z.string().min(1),
  dialect: z.string().min(1),
  database_url_enc: z.string().min(1),
  dump_sha256: z.string().length(64),
  archive_sha256: z.string().length(64),
  chunks: z.array(ManifestChunkSchema).min(1),
});

export const ManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  tool: z.literal(MANIFEST_TOOL),
  created_at: z.string().min(1),
  databases: z.array(ManifestDatabaseSchema).min(1),
});

export type ManifestChunk = z.infer<typeof ManifestChunkSchema>;
export type ManifestDatabase = z.infer<typeof ManifestDatabaseSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export type ManifestFormat = "json" | "yaml";

export interface DatabaseManifestInput {
  name: string;
  dialect: string;
  databaseUrl: string;
  dumpSha256: string;
  archiveSha256: string;
  chunks: Array<{ part: number; fileId: string; sizeBytes: number; sha256: string }>;
}

export function buildManifest(databases: DatabaseManifestInput[], key: Buffer, now = new Date()): Manifest {
  return {
    version: MANIFEST_VERSION,
    tool: MANIFEST_TOOL,
    created_at: now.toISOString(),
    databases: databases.map((db) => ({
      name: db.name,
      dialect: db.dialect,
      database_url_enc: encryptString(db.databaseUrl, key),
      dump_sha256: db.dumpSha256,
      archive_sha256: db.archiveSha256,
      chunks: db.chunks.map((chunk) => ({
        part: chunk.part,
        file_id: chunk.fileId,
        size_bytes: chunk.sizeBytes,
        sha256: chunk.sha256,
      })),
    })),
  };
}

export function serializeManifest(manifest: Manifest, format: ManifestFormat): string {
  if (format === "yaml") return stringifyYaml(manifest, { lineWidth: 0 });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string, format?: ManifestFormat): Manifest {
  let raw: unknown;
  const looksJson = text.trimStart().startsWith("{");
  const useYaml = format ? format === "yaml" : !looksJson;
  try {
    if (useYaml) {
      raw = parseYaml(text);
    } else {
      raw = JSON.parse(text);
    }
  } catch (err) {
    throw new ManifestError("manifest is not valid JSON/YAML", { cause: err });
  }
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new ManifestError(`invalid manifest: ${issues}`);
  }
  return result.data;
}

/** Decrypt the connection URL stored in a manifest database entry. */
export function databaseUrlFromManifest(db: ManifestDatabase, key: Buffer): string {
  return decryptString(db.database_url_enc, key);
}

export function manifestFileName(format: ManifestFormat, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return `manifest-${stamp}.${format}`;
}
