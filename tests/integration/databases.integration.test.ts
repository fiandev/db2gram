import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../src/dialects/index.js";
import { getDialect } from "../../src/dialects/registry.js";
import { openStateStore } from "../../src/state.js";

/**
 * These tests require real database servers. Start them with
 *   bash scripts/test-integration.sh
 * and they run automatically; otherwise they are skipped.
 */

const PG_URL = process.env.TGDB_TEST_POSTGRES_URL;
const MARIA_URL = process.env.TGDB_TEST_MARIADB_URL;
const ROOT_URL = process.env.TGDB_TEST_ROOT_DATABASE_URL;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tgdb-integration-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!PG_URL)("postgres dialect round-trip", () => {
  it("dumps and restores identical data", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS tgdb_test");
      await client.query("CREATE TABLE tgdb_test (id serial PRIMARY KEY, payload text NOT NULL)");
      await client.query(
        "INSERT INTO tgdb_test (payload) SELECT md5(g::text) FROM generate_series(1, 500) g",
      );
      const before = await checksumPg(client);

      const sqlPath = join(dir, "pg.sql");
      await getDialect("postgres").dump(PG_URL!, sqlPath);

      await client.query("DROP TABLE tgdb_test");
      await getDialect("postgres").restore(PG_URL!, sqlPath);

      expect(await checksumPg(client)).toBe(before);
    } finally {
      await client.end();
    }
  });
});

async function checksumPg(client: { query: (sql: string) => Promise<{ rows: Array<{ c: string }> }> }): Promise<string> {
  const res = await client.query(
    "SELECT COALESCE(md5(string_agg(id::text || ':' || payload, '|' ORDER BY id)), '') AS c FROM tgdb_test",
  );
  return res.rows[0]?.c ?? "";
}

describe.skipIf(!MARIA_URL)("mariadb dialect round-trip", () => {
  it("dumps and restores identical data", async () => {
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection(MARIA_URL!);
    try {
      await connection.query("DROP TABLE IF EXISTS tgdb_test");
      await connection.query(
        "CREATE TABLE tgdb_test (id INT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(64) NOT NULL)",
      );
      await connection.query(
        "INSERT INTO tgdb_test (payload) SELECT MD5(seq) FROM (SELECT 1 seq UNION ALL SELECT 2 UNION ALL SELECT 3) t",
      );
      // Add 500 deterministic rows.
      const values = Array.from({ length: 500 }, (_, i) => [String(i).padStart(4, "0")]);
      await connection.query("INSERT INTO tgdb_test (payload) VALUES ?", [values]);
      const before = await checksumMaria(connection);

      const sqlPath = join(dir, "maria.sql");
      await getDialect("mariadb").dump(MARIA_URL!, sqlPath);

      await connection.query("DROP TABLE tgdb_test");
      await getDialect("mariadb").restore(MARIA_URL!, sqlPath);

      expect(await checksumMaria(connection)).toBe(before);
    } finally {
      await connection.end();
    }
  });
});

async function checksumMaria(connection: {
  query: (sql: string) => Promise<[Array<{ c: string | null }>, unknown]>;
}): Promise<string> {
  const [rows] = await connection.query(
    "SELECT COALESCE(MD5(GROUP_CONCAT(CONCAT(id, ':', payload) ORDER BY id SEPARATOR '|')), '') AS c FROM tgdb_test",
  );
  return rows[0]?.c ?? "";
}

describe.skipIf(!ROOT_URL)("state store audit tables", () => {
  it("records runs and chunks", async () => {
    const store = await openStateStore(ROOT_URL!);
    try {
      const runId = await store.startRun(new Date());
      expect(runId).toBeGreaterThan(0);
      await store.recordChunk({
        runId,
        dbName: "unit-test",
        partNo: 1,
        fileId: "file-xyz",
        sizeBytes: 1234,
        sha256: "a".repeat(64),
      });
      await store.finishRun(runId, "success", "manifest-file-id");
      expect(runId).toBeGreaterThan(0);
    } finally {
      await store.close();
    }

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: ROOT_URL });
    await client.connect();
    try {
      const run = await client.query("SELECT status, manifest_file_id FROM backup_runs ORDER BY id DESC LIMIT 1");
      expect(run.rows[0]?.status).toBe("success");
      expect(run.rows[0]?.manifest_file_id).toBe("manifest-file-id");
      const chunk = await client.query("SELECT db_name, sha256 FROM backup_chunks ORDER BY id DESC LIMIT 1");
      expect(chunk.rows[0]?.db_name).toBe("unit-test");
    } finally {
      await client.end();
    }
  });
});
