import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { decryptString, encryptString, isEnvelope } from "./crypto.js";
import { ConfigError } from "./errors.js";
import { ensureParentDir } from "./util.js";

export const DatabaseConfigSchema = z.object({
  name: z.string().min(1, "database name is required"),
  dialect: z.string().min(1, "dialect is required"),
  url: z.string().min(1, "url is required"),
});

export const ConfigSchema = z.object({
  databases: z.array(DatabaseConfigSchema).min(1, "at least one database is required"),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = "./config.yaml.enc";

export function resolveConfigPath(explicit?: string): string {
  return explicit ?? process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

/** Parse and validate plaintext YAML into a Config. */
export function parseConfig(yamlText: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError("config is not valid YAML", { cause: err });
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`invalid config: ${issues}`);
  }
  const seen = new Set<string>();
  for (const db of result.data.databases) {
    if (seen.has(db.name)) {
      throw new ConfigError(`duplicate database name: ${db.name}`);
    }
    seen.add(db.name);
  }
  return result.data;
}

export function serializeConfig(config: Config): string {
  return stringifyYaml(config, { lineWidth: 0 });
}

/** Load config from disk, transparently decrypting a tgdb1 envelope if present. */
export async function loadConfigFile(path: string, key: Buffer): Promise<Config> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config at ${path}`, { cause: err });
  }
  const trimmed = content.trim();
  if (isEnvelope(trimmed)) {
    return parseConfig(decryptString(trimmed, key));
  }
  // Plaintext fallback keeps local development ergonomic; production uses .enc.
  return parseConfig(content);
}

export async function encryptConfigFile(inPath: string, outPath: string, key: Buffer): Promise<void> {
  let plaintext: string;
  try {
    plaintext = await readFile(inPath, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config at ${inPath}`, { cause: err });
  }
  // Validate before encrypting so we never ship a broken config.
  parseConfig(plaintext);
  const envelope = encryptString(plaintext, key);
  await ensureParentDir(outPath);
  await writeFile(outPath, envelope, { mode: 0o600 });
}

export async function decryptConfigFile(inPath: string, outPath: string, key: Buffer): Promise<void> {
  const content = await readFile(inPath, "utf8");
  const trimmed = content.trim();
  const plaintext = isEnvelope(trimmed) ? decryptString(trimmed, key) : content;
  parseConfig(plaintext);
  await ensureParentDir(outPath);
  await writeFile(outPath, plaintext, { mode: 0o600 });
}
