import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../src/commands/backup.js";
import { runRestore } from "../src/commands/restore.js";
import "../src/dialects/index.js";
import { hasDialect, registerDialect } from "../src/dialects/registry.js";
import type { Dialect } from "../src/dialects/types.js";
import { createLogger } from "../src/logger.js";
import { parseManifest, databaseUrlFromManifest } from "../src/manifest.js";
import { TelegramMock } from "./helpers/telegram-mock.js";

const DB1_DUMP = `-- fakedb dump db1\n${randomBytes(2_500_000).toString("base64")}\nEND-DB1\n`;
const DB2_DUMP = "-- fakedb dump db2\nsmall payload\nEND-DB2\n";

class FakeDialect implements Dialect {
  readonly name = "fakedb";
  readonly urlSchemes = ["fake://"] as const;
  static dumps = new Map<string, string>([
    ["fake://source/db1", DB1_DUMP],
    ["fake://source/db2", DB2_DUMP],
  ]);
  static restored = new Map<string, string>();

  async dump(url: string, output: string): Promise<void> {
    const data = FakeDialect.dumps.get(url);
    if (data === undefined) throw new Error(`no fake dump for ${url}`);
    await writeFile(output, data);
  }

  async restore(url: string, input: string): Promise<void> {
    FakeDialect.restored.set(url, await readFile(input, "utf8"));
  }
}

const mock = new TelegramMock();
const KEY = randomBytes(32);
let dir: string;
let configPath: string;
let manifestPath: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_API_BASE",
  "TGDB_SKIP_STATE",
  "TMP_DIR",
  "CHUNK_SIZE_MB",
  "CONFIG_PATH",
  "LOG_LEVEL",
] as const;

beforeAll(async () => {
  if (!hasDialect("fakedb")) registerDialect(new FakeDialect());
  const baseUrl = await mock.start();
  dir = await mkdtemp(join(tmpdir(), "tgdb-e2e-"));

  configPath = join(dir, "config.yaml");
  manifestPath = join(dir, "manifest.json");
  await writeFile(
    configPath,
    `databases:
  - name: db1
    dialect: fakedb
    url: "fake://source/db1"
  - name: db2
    dialect: fakedb
    url: "fake://source/db2"
`,
  );

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SECRET_KEY = KEY.toString("base64");
  process.env.TELEGRAM_BOT_TOKEN = mock.token;
  process.env.TELEGRAM_CHAT_ID = "99";
  process.env.TELEGRAM_API_BASE = baseUrl;
  process.env.TGDB_SKIP_STATE = "1";
  process.env.TMP_DIR = join(dir, "tmp");
  process.env.CHUNK_SIZE_MB = "1";
  process.env.CONFIG_PATH = configPath;
  process.env.LOG_LEVEL = "silent";
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await mock.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("end-to-end backup and restore", () => {
  const silent = () => createLogger({ level: "silent" });

  it("backs up both databases and uploads chunks plus a manifest", async () => {
    const result = await runBackup({ format: "json", outManifest: manifestPath, logger: silent() });
    expect(result.failed).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.succeeded.sort()).toEqual(["db1", "db2"]);
    expect(result.manifestFileId).toBeTruthy();

    const manifest = parseManifest(await readFile(manifestPath, "utf8"));
    expect(manifest.databases).toHaveLength(2);

    const db1 = manifest.databases.find((d) => d.name === "db1")!;
    // 2.5MB payload with a 1MB chunk size must split into multiple parts.
    expect(db1.chunks.length).toBeGreaterThan(1);
    expect(databaseUrlFromManifest(db1, KEY)).toBe("fake://source/db1");
    for (const chunk of db1.chunks) {
      expect(mock.files.has(chunk.file_id)).toBe(true);
    }
  });

  it("restores into an override target with verified data", async () => {
    FakeDialect.restored.clear();
    const result = await runRestore({
      manifestPath,
      onlyDb: "db1",
      targetUrl: "fake://target/db1",
      yes: true,
      logger: silent(),
    });
    expect(result.exitCode).toBe(0);
    expect(FakeDialect.restored.get("fake://target/db1")).toBe(DB1_DUMP);
  });

  it("restores using the URL decrypted from the manifest by default", async () => {
    FakeDialect.restored.clear();
    const result = await runRestore({ manifestPath, onlyDb: "db2", yes: true, logger: silent() });
    expect(result.exitCode).toBe(0);
    expect(FakeDialect.restored.get("fake://source/db2")).toBe(DB2_DUMP);
  });

  it("refuses to restore into a production-looking host without --force", async () => {
    FakeDialect.restored.clear();
    const result = await runRestore({
      manifestPath,
      onlyDb: "db2",
      targetUrl: "fake://prod-db.internal/db2",
      yes: true,
      logger: silent(),
    });
    expect(result.exitCode).toBe(1);
    expect(FakeDialect.restored.size).toBe(0);
  });

  it("detects a tampered chunk via checksum", async () => {
    const manifest = parseManifest(await readFile(manifestPath, "utf8"));
    const chunk = manifest.databases.find((d) => d.name === "db2")!.chunks[0]!;
    const stored = mock.files.get(chunk.file_id)!;
    stored.data = Buffer.concat([stored.data, Buffer.from("corruption")]);

    const result = await runRestore({
      manifestPath,
      onlyDb: "db2",
      targetUrl: "fake://target/tampered",
      yes: true,
      logger: silent(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.results[0]?.error).toMatch(/checksum/i);
  });
});
