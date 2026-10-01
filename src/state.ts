import { StateError } from "./errors.js";
import type { Logger } from "./logger.js";
import { redactUrl } from "./util.js";

export interface ChunkRecord {
  runId: number;
  dbName: string;
  partNo: number;
  fileId: string;
  sizeBytes: number;
  sha256: string;
}

export type RunStatus = "running" | "success" | "failed";

export interface StateStore {
  startRun(startedAt: Date): Promise<number>;
  finishRun(runId: number, status: RunStatus, manifestFileId: string | null): Promise<void>;
  recordChunk(record: ChunkRecord): Promise<void>;
  close(): Promise<void>;
}

const PG_DDL = [
  `CREATE TABLE IF NOT EXISTS backup_runs (
     id BIGSERIAL PRIMARY KEY,
     started_at TIMESTAMPTZ NOT NULL,
     finished_at TIMESTAMPTZ,
     status TEXT NOT NULL,
     manifest_file_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS backup_chunks (
     id BIGSERIAL PRIMARY KEY,
     run_id BIGINT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
     db_name TEXT NOT NULL,
     part_no INTEGER NOT NULL,
     file_id TEXT NOT NULL,
     size_bytes BIGINT NOT NULL,
     sha256 TEXT NOT NULL
   )`,
];

const MYSQL_DDL = [
  `CREATE TABLE IF NOT EXISTS backup_runs (
     id BIGINT PRIMARY KEY AUTO_INCREMENT,
     started_at DATETIME(3) NOT NULL,
     finished_at DATETIME(3) NULL,
     status VARCHAR(32) NOT NULL,
     manifest_file_id VARCHAR(255) NULL
   )`,
  `CREATE TABLE IF NOT EXISTS backup_chunks (
     id BIGINT PRIMARY KEY AUTO_INCREMENT,
     run_id BIGINT NOT NULL,
     db_name VARCHAR(255) NOT NULL,
     part_no INT NOT NULL,
     file_id VARCHAR(255) NOT NULL,
     size_bytes BIGINT NOT NULL,
     sha256 CHAR(64) NOT NULL,
     CONSTRAINT fk_backup_chunks_run FOREIGN KEY (run_id)
       REFERENCES backup_runs(id) ON DELETE CASCADE
   )`,
];

/** Open (and migrate) the control database described by ROOT_DATABASE_URL. */
export async function openStateStore(url: string, logger?: Logger): Promise<StateStore> {
  const scheme = url.split(":")[0]?.toLowerCase();
  logger?.debug("opening state store", { url: redactUrl(url) });
  switch (scheme) {
    case "postgres":
    case "postgresql":
      return openPostgres(url);
    case "mysql":
    case "mariadb":
      return openMysql(url);
    default:
      throw new StateError(
        `unsupported ROOT_DATABASE_URL scheme "${scheme}://" (use postgres:// or mysql://)`,
      );
  }
}

async function openPostgres(url: string): Promise<StateStore> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    for (const ddl of PG_DDL) await client.query(ddl);
  } catch (err) {
    throw new StateError("failed to initialise PostgreSQL state store", { cause: err });
  }
  return {
    async startRun(startedAt) {
      const res = await client.query<{ id: string }>(
        `INSERT INTO backup_runs (started_at, status) VALUES ($1, 'running') RETURNING id`,
        [startedAt],
      );
      const id = res.rows[0]?.id;
      if (id === undefined) throw new StateError("failed to insert backup_runs row");
      return Number(id);
    },
    async finishRun(runId, status, manifestFileId) {
      await client.query(
        `UPDATE backup_runs SET finished_at = $1, status = $2, manifest_file_id = $3 WHERE id = $4`,
        [new Date(), status, manifestFileId, runId],
      );
    },
    async recordChunk(record) {
      await client.query(
        `INSERT INTO backup_chunks (run_id, db_name, part_no, file_id, size_bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [record.runId, record.dbName, record.partNo, record.fileId, record.sizeBytes, record.sha256],
      );
    },
    async close() {
      await client.end();
    },
  };
}

async function openMysql(url: string): Promise<StateStore> {
  const mysql = await import("mysql2/promise");
  let connection: Awaited<ReturnType<typeof mysql.createConnection>>;
  try {
    connection = await mysql.createConnection(url);
    for (const ddl of MYSQL_DDL) await connection.query(ddl);
  } catch (err) {
    throw new StateError("failed to initialise MySQL/MariaDB state store", { cause: err });
  }
  return {
    async startRun(startedAt) {
      const [result] = await connection.execute<import("mysql2").ResultSetHeader>(
        `INSERT INTO backup_runs (started_at, status) VALUES (?, 'running')`,
        [startedAt],
      );
      return result.insertId;
    },
    async finishRun(runId, status, manifestFileId) {
      await connection.execute(
        `UPDATE backup_runs SET finished_at = ?, status = ?, manifest_file_id = ? WHERE id = ?`,
        [new Date(), status, manifestFileId, runId],
      );
    },
    async recordChunk(record) {
      await connection.execute(
        `INSERT INTO backup_chunks (run_id, db_name, part_no, file_id, size_bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [record.runId, record.dbName, record.partNo, record.fileId, record.sizeBytes, record.sha256],
      );
    },
    async close() {
      await connection.end();
    },
  };
}
