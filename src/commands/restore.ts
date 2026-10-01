import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadSecretKey } from "../crypto.js";
import { assertUrlScheme, getDialect } from "../dialects/index.js";
import { requireEnv, tmpDir } from "../env.js";
import { ConfigError } from "../errors.js";
import { createLogger, type Logger } from "../logger.js";
import {
  databaseUrlFromManifest,
  parseManifest,
  type Manifest,
  type ManifestDatabase,
} from "../manifest.js";
import { decryptArchive, joinFiles, unzipFile, verifySha256 } from "../packaging.js";
import { TelegramClient } from "../telegram.js";
import { ensureDir, fileStamp, hostOf, redactUrl, removeQuiet } from "../util.js";

export interface RestoreOptions {
  manifestPath: string;
  onlyDb?: string;
  targetUrl?: string;
  yes?: boolean;
  force?: boolean;
  logger?: Logger;
}

export interface RestoreDatabaseResult {
  name: string;
  ok: boolean;
  error?: string;
  targetUrl?: string;
}

export interface RestoreResult {
  exitCode: number;
  results: RestoreDatabaseResult[];
}

const PRODUCTION_HOST = /(^|[.\-])(prod|production|live)([.\-]|$)/i;

export function looksLikeProduction(host: string): boolean {
  return PRODUCTION_HOST.test(host);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new ConfigError("refusing to restore without --yes (stdin is not a TTY)");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function readManifestFile(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read manifest at ${path}`, { cause: err });
  }
  return parseManifest(text);
}

/**
 * Restore pipeline (PRD §6):
 * download chunks -> verify -> join -> decrypt -> unzip -> verify -> restore.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const logger = options.logger ?? createLogger();
  const key = loadSecretKey();
  const manifest = await readManifestFile(options.manifestPath);
  logger.info("loaded manifest", {
    path: options.manifestPath,
    created_at: manifest.created_at,
    databases: manifest.databases.length,
  });

  const selected = selectDatabases(manifest, options.onlyDb);
  const telegram = new TelegramClient({
    token: requireEnv("TELEGRAM_BOT_TOKEN"),
    logger,
  });

  const results: RestoreDatabaseResult[] = [];
  const stamp = fileStamp();

  for (const db of selected) {
    const dbLogger = logger.child({ db: db.name, dialect: db.dialect });
    const targetUrl = options.targetUrl ?? databaseUrlFromManifest(db, key);
    const dialect = getDialect(db.dialect);
    assertUrlScheme(dialect, targetUrl);

    const workDir = join(tmpDir(), `restore-${stamp}-${db.name}`);
    try {
      const host = hostOf(targetUrl);
      if (looksLikeProduction(host) && !options.force) {
        throw new ConfigError(
          `target host "${host}" looks like production; pass --force to override`,
        );
      }
      if (!options.yes) {
        const proceed = await confirm(
          `Restore "${db.name}" (${db.dialect}) into ${redactUrl(targetUrl)}? [y/N] `,
        );
        if (!proceed) {
          dbLogger.warn("restore skipped by user");
          results.push({ name: db.name, ok: false, error: "skipped by user", targetUrl: redactUrl(targetUrl) });
          continue;
        }
      }

      await ensureDir(workDir);
      dbLogger.info("downloading chunks", { count: db.chunks.length });
      const partPaths: string[] = [];
      for (const chunk of [...db.chunks].sort((a, b) => a.part - b.part)) {
        const partPath = join(workDir, `${db.name}.zip.enc.part${chunk.part}`);
        await telegram.downloadFile(chunk.file_id, partPath);
        await verifySha256(partPath, chunk.sha256);
        partPaths.push(partPath);
        dbLogger.debug("chunk verified", { part: chunk.part, size_bytes: chunk.size_bytes });
      }

      const encPath = join(workDir, `${db.name}.zip.enc`);
      const zipPath = join(workDir, `${db.name}.zip`);
      await joinFiles(partPaths, encPath);
      await decryptArchive(encPath, zipPath, key);
      await verifySha256(zipPath, db.archive_sha256);

      const sqlPath = await unzipFile(zipPath, workDir);
      await verifySha256(sqlPath, db.dump_sha256);

      dbLogger.info("restoring", { target: redactUrl(targetUrl) });
      await dialect.restore(targetUrl, sqlPath);
      dbLogger.info("restore complete");
      results.push({ name: db.name, ok: true, targetUrl: redactUrl(targetUrl) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dbLogger.error("restore failed", { error: err });
      results.push({ name: db.name, ok: false, error: message, targetUrl: redactUrl(targetUrl) });
    } finally {
      await removeQuiet(workDir);
    }
  }

  return { exitCode: results.every((r) => r.ok) ? 0 : 1, results };
}

function selectDatabases(manifest: Manifest, onlyDb?: string): ManifestDatabase[] {
  if (!onlyDb) return manifest.databases;
  const match = manifest.databases.find((db) => db.name === onlyDb);
  if (!match) {
    const names = manifest.databases.map((db) => db.name).join(", ");
    throw new ConfigError(`database "${onlyDb}" not present in manifest (available: ${names})`);
  }
  return [match];
}
