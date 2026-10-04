import { readFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { DEFAULT_CONFIG_PATH } from "./config.js";
import { parseSecretKey } from "./crypto.js";
import { optionalEnv } from "./env.js";
import { ConfigError } from "./errors.js";
import { parseManifest } from "./manifest.js";

export interface BackupWizardOptions {
  dryRun?: boolean;
  configPath?: string;
  wizard?: boolean;
}

export interface RestoreWizardOptions {
  manifestPath?: string;
  onlyDb?: string;
  targetUrl?: string;
  yes?: boolean;
  wizard?: boolean;
}

export interface RestoreWizardResult {
  manifestPath: string;
  onlyDb?: string;
  targetUrl?: string;
  yes?: boolean;
}

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return { ...process.env };
}

function lookup(name: string, env?: EnvSnapshot): string | undefined {
  const source = env ?? snapshotEnv();
  const value = source[name];
  return value && value.trim() !== "" ? value : undefined;
}

/** Env vars required for `backup` (excluding optionals with defaults). */
export function getMissingBackupVars(dryRun = false, env?: EnvSnapshot): string[] {
  const missing: string[] = [];
  if (!lookup("SECRET_KEY", env)) missing.push("SECRET_KEY");
  if (!dryRun) {
    if (!lookup("TELEGRAM_BOT_TOKEN", env)) missing.push("TELEGRAM_BOT_TOKEN");
    if (!lookup("TELEGRAM_CHAT_ID", env)) missing.push("TELEGRAM_CHAT_ID");
    // Control DB is optional when audit logging is explicitly disabled.
    if (!lookup("ROOT_DATABASE_URL", env) && lookup("DB2GRAM_SKIP_STATE", env) !== "1") {
      missing.push("ROOT_DATABASE_URL");
    }
  }
  return missing;
}

/** Env vars required for `restore` (chat id is not needed to download). */
export function getMissingRestoreVars(env?: EnvSnapshot): string[] {
  const missing: string[] = [];
  if (!lookup("SECRET_KEY", env)) missing.push("SECRET_KEY");
  if (!lookup("TELEGRAM_BOT_TOKEN", env)) missing.push("TELEGRAM_BOT_TOKEN");
  return missing;
}

export function applyEnvValues(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value.trim() === "") delete process.env[key];
    else process.env[key] = value;
  }
}

export function validateSecretKeyInput(value: string | undefined): string | undefined {
  if (!value || value.trim() === "") return "SECRET_KEY is required";
  try {
    parseSecretKey(value.trim());
  } catch (err) {
    return err instanceof Error ? err.message : "invalid SECRET_KEY";
  }
  return undefined;
}

export function validateRequiredInput(label: string, value: string | undefined): string | undefined {
  if (!value || value.trim() === "") return `${label} is required`;
  return undefined;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

function abortIfCancel(value: unknown, message = "Operation cancelled"): never | void {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(0);
  }
}

async function askPassword(message: string, validate: (v: string | undefined) => string | undefined): Promise<string> {
  const answer = await p.password({ message, mask: "•", validate });
  abortIfCancel(answer);
  return (answer as string).trim();
}

async function askText(
  message: string,
  placeholder: string,
  initialValue: string | undefined,
  validate: (v: string | undefined) => string | undefined,
): Promise<string> {
  const answer = await p.text({
    message,
    placeholder,
    initialValue: initialValue ?? "",
    validate,
  });
  abortIfCancel(answer);
  return (answer as string).trim();
}

/**
 * Fill `process.env` for `backup` via an interactive wizard.
 *
 * - `--wizard`: ignore every existing env var and ask for all of them.
 * - default: keep existing env vars and only ask for the missing ones.
 */
export async function ensureBackupWizard(options: BackupWizardOptions = {}): Promise<{ configPath: string }> {
  const forceAll = options.wizard === true;
  const explicitConfig = options.configPath?.trim() ? options.configPath.trim() : undefined;

  if (!isInteractive()) {
    if (forceAll) {
      throw new ConfigError("--wizard requires an interactive terminal (stdin is not a TTY)");
    }
    return { configPath: explicitConfig ?? optionalEnv("CONFIG_PATH") ?? DEFAULT_CONFIG_PATH };
  }

  const needSecret = forceAll || !optionalEnv("SECRET_KEY");
  const needToken = !options.dryRun && (forceAll || !optionalEnv("TELEGRAM_BOT_TOKEN"));
  const needChat = !options.dryRun && (forceAll || !optionalEnv("TELEGRAM_CHAT_ID"));
  const needRoot =
    !options.dryRun && (forceAll || (!optionalEnv("ROOT_DATABASE_URL") && process.env.DB2GRAM_SKIP_STATE !== "1"));
  const needConfig = !explicitConfig && (forceAll || !optionalEnv("CONFIG_PATH"));

  if (!needSecret && !needToken && !needChat && !needRoot && !needConfig) {
    return { configPath: explicitConfig ?? optionalEnv("CONFIG_PATH") ?? DEFAULT_CONFIG_PATH };
  }

  p.intro("db2gram backup setup");

  if (needSecret) {
    const secret = await askPassword(
      "SECRET_KEY (32-byte base64, e.g. from `openssl rand -base64 32`)",
      validateSecretKeyInput,
    );
    process.env.SECRET_KEY = secret;
  }

  let configPath = explicitConfig ?? optionalEnv("CONFIG_PATH") ?? DEFAULT_CONFIG_PATH;
  if (needConfig) {
    configPath = await askText(
      "Encrypted config path",
      DEFAULT_CONFIG_PATH,
      forceAll ? DEFAULT_CONFIG_PATH : configPath,
      (v) => validateRequiredInput("CONFIG_PATH", v),
    );
    process.env.CONFIG_PATH = configPath;
  }

  if (!options.dryRun) {
    if (needToken) {
      process.env.TELEGRAM_BOT_TOKEN = await askPassword(
        "TELEGRAM_BOT_TOKEN (from @BotFather)",
        (v) => validateRequiredInput("TELEGRAM_BOT_TOKEN", v),
      );
    }
    if (needChat) {
      process.env.TELEGRAM_CHAT_ID = await askText(
        "TELEGRAM_CHAT_ID (private chat, group, or channel id)",
        "-1001234567890",
        forceAll ? undefined : optionalEnv("TELEGRAM_CHAT_ID"),
        (v) => validateRequiredInput("TELEGRAM_CHAT_ID", v),
      );
    }
    if (needRoot) {
      const useState = await p.confirm({
        message: "Record run history to a control database (ROOT_DATABASE_URL)?",
        initialValue: forceAll ? true : optionalEnv("ROOT_DATABASE_URL") !== undefined,
      });
      abortIfCancel(useState);
      if (useState) {
        process.env.ROOT_DATABASE_URL = await askText(
          "ROOT_DATABASE_URL (postgresql://… or mysql://…)",
          "postgresql://user:pass@localhost:5432/db2gram_state",
          forceAll ? undefined : optionalEnv("ROOT_DATABASE_URL"),
          (v) => validateRequiredInput("ROOT_DATABASE_URL", v),
        );
        delete process.env.DB2GRAM_SKIP_STATE;
      } else {
        process.env.DB2GRAM_SKIP_STATE = "1";
        if (forceAll) delete process.env.ROOT_DATABASE_URL;
      }
    }
  }

  p.outro("Backup setup complete");
  return { configPath };
}

/**
 * Fill `process.env` (plus restore-specific choices) via an interactive wizard.
 *
 * - `--wizard`: ignore existing env vars and walk through manifest / target picks.
 * - default: keep existing env vars and only ask for the missing ones.
 */
export async function ensureRestoreWizard(options: RestoreWizardOptions = {}): Promise<RestoreWizardResult> {
  const forceAll = options.wizard === true;
  let manifestPath = options.manifestPath?.trim() ? options.manifestPath.trim() : undefined;
  let onlyDb = options.onlyDb;
  let targetUrl = options.targetUrl;
  let yes = options.yes;

  if (!isInteractive()) {
    if (forceAll) {
      throw new ConfigError("--wizard requires an interactive terminal (stdin is not a TTY)");
    }
    if (!manifestPath) throw new ConfigError('missing manifest path (pass -m/--manifest or run with --wizard in a terminal)');
    return { manifestPath, onlyDb, targetUrl, yes };
  }

  const needSecret = forceAll || !optionalEnv("SECRET_KEY");
  const needToken = forceAll || !optionalEnv("TELEGRAM_BOT_TOKEN");
  const needManifest = forceAll || !manifestPath;

  if (!needSecret && !needToken && !needManifest && !forceAll) {
    return { manifestPath: manifestPath as string, onlyDb, targetUrl, yes };
  }

  p.intro("db2gram restore setup");

  if (needSecret) {
    process.env.SECRET_KEY = await askPassword(
      "SECRET_KEY used for this backup",
      validateSecretKeyInput,
    );
  }
  if (needToken) {
    process.env.TELEGRAM_BOT_TOKEN = await askPassword(
      "TELEGRAM_BOT_TOKEN (same bot that uploaded the backup)",
      (v) => validateRequiredInput("TELEGRAM_BOT_TOKEN", v),
    );
  }
  if (needManifest) {
    manifestPath = await askText(
      "Manifest file path (JSON or YAML, from Telegram or --out-manifest)",
      "./manifest.json",
      forceAll ? "./manifest.json" : manifestPath,
      (v) => validateRequiredInput("manifest", v),
    );
  }

  // Guided picks only in full wizard mode; otherwise keep CLI semantics
  // (--only-db / --target-url / --yes) untouched.
  if (forceAll && manifestPath) {
    const picked = await promptRestoreTargets(manifestPath, { onlyDb, targetUrl, yes });
    onlyDb = picked.onlyDb;
    targetUrl = picked.targetUrl;
    yes = picked.yes;
  }

  p.outro("Restore setup complete");
  return { manifestPath: manifestPath as string, onlyDb, targetUrl, yes };
}

async function promptRestoreTargets(
  manifestPath: string,
  current: { onlyDb?: string; targetUrl?: string; yes?: boolean },
): Promise<{ onlyDb?: string; targetUrl?: string; yes?: boolean }> {
  let names: string[] = [];
  try {
    const text = await readFile(manifestPath, "utf8");
    names = parseManifest(text).databases.map((db) => db.name);
  } catch {
    names = [];
  }

  let onlyDb = current.onlyDb;
  if (names.length > 0 && !onlyDb) {
    const choice = await p.select({
      message: "Which database should be restored?",
      options: [
        { value: "", label: "All databases in the manifest" },
        ...names.map((name) => ({ value: name, label: name })),
      ],
    });
    abortIfCancel(choice);
    onlyDb = (choice as string) === "" ? undefined : (choice as string);
  }

  let targetUrl = current.targetUrl;
  if (!targetUrl) {
    const custom = await askText(
      "Custom target URL (empty = reuse the URL stored in the manifest)",
      "postgresql://user:pass@localhost:5432/restore_test",
      "",
      () => undefined,
    );
    targetUrl = custom === "" ? undefined : custom;
  }

  let yes = current.yes;
  if (!yes) {
    const skip = await p.confirm({ message: "Skip the restore confirmation prompt (--yes)?", initialValue: false });
    abortIfCancel(skip);
    yes = skip ? true : undefined;
  }

  return { onlyDb, targetUrl, yes };
}
