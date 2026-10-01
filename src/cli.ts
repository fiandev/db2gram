#!/usr/bin/env node
import "dotenv/config";
import { Command, Option } from "commander";
import { runBackup, summarizeBackup } from "./commands/backup.js";
import { runRestore } from "./commands/restore.js";
import { decryptConfigFile, encryptConfigFile, resolveConfigPath } from "./config.js";
import { loadSecretKey } from "./crypto.js";
import { Db2gramError } from "./errors.js";
import { createLogger } from "./logger.js";

const VERSION = "1.0.0";

function main(): void {
  const program = new Command();
  program
    .name("db2gram")
    .description("Automated multi-database backup to Telegram (dump → zip → encrypt → chunk → upload).")
    .version(VERSION);

  program
    .command("encrypt-config")
    .description("Encrypt a plaintext config.yaml into a db2gram1 envelope.")
    .option("--in <path>", "input config path", "./config.yaml")
    .option("--out <path>", "output encrypted path", "./config.yaml.enc")
    .action(async (opts: { in: string; out: string }) => {
      const logger = createLogger();
      const key = loadSecretKey();
      await encryptConfigFile(opts.in, opts.out, key);
      logger.info("config encrypted", { in: opts.in, out: opts.out });
    });

  program
    .command("decrypt-config")
    .description("Decrypt a db2gram1 config envelope back to plaintext YAML.")
    .option("--in <path>", "input encrypted path", "./config.yaml.enc")
    .option("--out <path>", "output plaintext path", "./config.yaml")
    .action(async (opts: { in: string; out: string }) => {
      const logger = createLogger();
      const key = loadSecretKey();
      await decryptConfigFile(opts.in, opts.out, key);
      logger.info("config decrypted", { in: opts.in, out: opts.out });
    });

  program
    .command("backup")
    .description("Dump every configured database and upload encrypted chunks to Telegram.")
    .addOption(
      new Option("--format <format>", "manifest format").choices(["json", "yaml"]).default("json"),
    )
    .option("--dry-run", "run through dump/zip/encrypt/split without uploading")
    .option("--config <path>", "override CONFIG_PATH")
    .option("--out-manifest <path>", "write the manifest to this path")
    .action(async (opts: { format: "json" | "yaml"; dryRun?: boolean; config?: string; outManifest?: string }) => {
      const result = await runBackup({
        format: opts.format,
        dryRun: opts.dryRun,
        configPath: opts.config,
        outManifest: opts.outManifest,
      });
      summarizeBackup(result);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  program
    .command("restore")
    .description("Restore databases from a manifest by downloading chunks from Telegram.")
    .requiredOption("-m, --manifest <path>", "path to the manifest (JSON or YAML)")
    .option("--only-db <name>", "restore a single database from the manifest")
    .option("--target-url <url>", "override the target connection URL")
    .option("--yes", "skip the interactive confirmation")
    .option("--force", "allow restoring into a host that looks like production")
    .action(
      async (opts: {
        manifest: string;
        onlyDb?: string;
        targetUrl?: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        const logger = createLogger();
        const result = await runRestore({
          manifestPath: opts.manifest,
          onlyDb: opts.onlyDb,
          targetUrl: opts.targetUrl,
          yes: opts.yes,
          force: opts.force,
        });
        for (const r of result.results) {
          if (r.ok) logger.info("restored", { db: r.name, target: r.targetUrl });
          else logger.error("not restored", { db: r.name, reason: r.error });
        }
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      },
    );

  // Config path is resolved from env; surface it for the help text.
  program.addHelpText("after", `\nConfig path: ${resolveConfigPath()} (override with CONFIG_PATH or --config)`);

  program.parseAsync(process.argv).catch(handleFatal);
}

function handleFatal(err: unknown): void {
  const logger = createLogger();
  if (err instanceof Db2gramError) {
    logger.error(err.message, { code: err.code, error: err.cause instanceof Error ? err.cause : undefined });
  } else if (err instanceof Error) {
    logger.error(err.message, { error: err });
  } else {
    logger.error(String(err));
  }
  process.exitCode = 1;
}

main();
