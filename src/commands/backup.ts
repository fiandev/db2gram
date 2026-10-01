import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigFile, resolveConfigPath } from "../config.js";
import { loadSecretKey } from "../crypto.js";
import { assertUrlScheme, getDialect } from "../dialects/index.js";
import { chunkSizeBytes, requireEnv, tmpDir } from "../env.js";
import { createLogger, type Logger } from "../logger.js";
import {
  buildManifest,
  manifestFileName,
  serializeManifest,
  type DatabaseManifestInput,
  type ManifestFormat,
} from "../manifest.js";
import { encryptArchive, splitFile, zipFile, type ChunkInfo } from "../packaging.js";
import { openStateStore, type StateStore } from "../state.js";
import { TelegramClient } from "../telegram.js";
import {
  ensureDir,
  ensureParentDir,
  fileStamp,
  humanSize,
  redactUrl,
  removeQuiet,
} from "../util.js";

export interface BackupOptions {
  format?: ManifestFormat;
  dryRun?: boolean;
  configPath?: string;
  outManifest?: string;
  logger?: Logger;
}

export interface BackupResult {
  exitCode: number;
  succeeded: string[];
  failed: Array<{ name: string; error: string }>;
  manifestPath?: string;
  manifestFileId?: string;
}

/**
 * Full backup pipeline (PRD §5):
 * dump -> zip -> encrypt -> split -> upload -> manifest.
 * One database failing never aborts the others.
 */
export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const logger = options.logger ?? createLogger();
  const format = options.format ?? "json";
  const dryRun = options.dryRun ?? false;

  const key = loadSecretKey();
  const configPath = resolveConfigPath(options.configPath);
  const config = await loadConfigFile(configPath, key);
  logger.info("loaded config", { path: configPath, databases: config.databases.length, dry_run: dryRun });

  // Fail fast on unknown dialects / mismatched URL schemes.
  for (const db of config.databases) {
    assertUrlScheme(getDialect(db.dialect), db.url);
  }

  const telegram = dryRun
    ? undefined
    : new TelegramClient({
        token: requireEnv("TELEGRAM_BOT_TOKEN"),
        chatId: requireEnv("TELEGRAM_CHAT_ID"),
        logger,
      });
  // ROOT_DATABASE_URL is required by default. DB2GRAM_SKIP_STATE=1 disables audit
  // logging (useful for tests and one-off runs); the manifest is unaffected.
  const stateDisabled = process.env.DB2GRAM_SKIP_STATE === "1";
  const rootUrl = dryRun || stateDisabled ? undefined : requireEnv("ROOT_DATABASE_URL");
  if (stateDisabled && !dryRun) {
    logger.warn("state DB disabled via DB2GRAM_SKIP_STATE=1; run history will not be recorded");
  }

  const stamp = fileStamp();
  const runDir = join(tmpDir(), `run-${stamp}`);
  await ensureDir(runDir);

  const succeeded: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const manifestInputs: DatabaseManifestInput[] = [];
  const chunkSize = chunkSizeBytes();

  let state: StateStore | undefined;
  let runId: number | undefined;

  try {
    if (!dryRun && rootUrl) {
      state = await openStateStore(rootUrl, logger);
      runId = await state.startRun(new Date());
      logger.info("started backup run", { run_id: runId });
    }

    for (const db of config.databases) {
      const dbLogger = logger.child({ db: db.name, dialect: db.dialect });
      const dialect = getDialect(db.dialect);
      const baseName = `${db.name}-${stamp}`;
      const sqlPath = join(runDir, `${baseName}.sql`);
      const zipPath = join(runDir, `${baseName}.zip`);
      const encPath = join(runDir, `${baseName}.zip.enc`);
      let parts: ChunkInfo[] = [];

      const started = Date.now();
      try {
        dbLogger.info("dump started", { url: redactUrl(db.url) });
        await dialect.dump(db.url, sqlPath);

        const { dumpSha256, archiveSha256 } = await zipFile(sqlPath, zipPath);
        await encryptArchive(zipPath, encPath, key);
        parts = await splitFile(encPath, chunkSize, runDir, `${baseName}.zip.enc`);

        const totalBytes = parts.reduce((sum, p) => sum + p.sizeBytes, 0);
        dbLogger.info("packaged", {
          dump_sha256: dumpSha256,
          archive_sha256: archiveSha256,
          chunks: parts.length,
          size: humanSize(totalBytes),
          duration_ms: Date.now() - started,
        });

        if (dryRun) {
          succeeded.push(db.name);
          continue;
        }

        const chunks: DatabaseManifestInput["chunks"] = [];
        for (const part of parts) {
          const sent = await telegram!.sendDocument(
            part.path,
            `${db.name} part ${part.part}/${parts.length}`,
          );
          chunks.push({
            part: part.part,
            fileId: sent.fileId,
            sizeBytes: part.sizeBytes,
            sha256: part.sha256,
          });
          if (state && runId !== undefined) {
            await state.recordChunk({
              runId,
              dbName: db.name,
              partNo: part.part,
              fileId: sent.fileId,
              sizeBytes: part.sizeBytes,
              sha256: part.sha256,
            });
          }
          dbLogger.info("chunk uploaded", {
            part: part.part,
            size: humanSize(part.sizeBytes),
            file_id: sent.fileId,
          });
        }

        manifestInputs.push({
          name: db.name,
          dialect: db.dialect,
          databaseUrl: db.url,
          dumpSha256,
          archiveSha256,
          chunks,
        });
        succeeded.push(db.name);
        dbLogger.info("database backup complete", { duration_ms: Date.now() - started });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ name: db.name, error: message });
        dbLogger.error("database backup failed", { error: err });
      } finally {
        await removeQuiet(sqlPath);
        await removeQuiet(zipPath);
        await removeQuiet(encPath);
        for (const part of parts) await removeQuiet(part.path);
      }
    }

    let manifestPath: string | undefined;
    let manifestFileId: string | undefined;

    if (!dryRun && manifestInputs.length > 0) {
      const manifest = buildManifest(manifestInputs, key);
      const fileName = manifestFileName(format);
      manifestPath = options.outManifest ?? join(process.cwd(), fileName);
      await ensureParentDir(manifestPath);
      await writeFile(manifestPath, serializeManifest(manifest, format), { mode: 0o600 });
      logger.info("manifest written", { path: manifestPath });

      const sent = await telegram!.sendDocument(manifestPath, "db2gram manifest");
      manifestFileId = sent.fileId;
      logger.info("manifest uploaded", { file_id: manifestFileId });
    } else if (dryRun) {
      logger.info("dry-run complete: skipped upload and manifest", { databases: succeeded.length });
    }

    const status = failed.length > 0 ? "failed" : "success";
    if (state && runId !== undefined) {
      await state.finishRun(runId, status, manifestFileId ?? null);
    }

    return {
      exitCode: failed.length > 0 ? 1 : 0,
      succeeded,
      failed,
      manifestPath,
      manifestFileId,
    };
  } finally {
    await removeQuiet(runDir);
    await state?.close().catch((err: unknown) => {
      logger.warn("failed to close state store", { error: err });
    });
  }
}

export function summarizeBackup(result: BackupResult, logger: Logger = createLogger()): void {
  logger.info("backup summary", {
    succeeded: result.succeeded.length,
    failed: result.failed.length,
  });
  for (const f of result.failed) {
    logger.error("failed database", { db: f.name, reason: f.error });
  }
  if (result.manifestPath) logger.info("manifest", { path: result.manifestPath });
}
