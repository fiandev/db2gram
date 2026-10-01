# db2gram

Automated multi-dialect database backup to Telegram. Each database is dumped to SQL,
zipped, **encrypted (AES-256-GCM)**, split into ≤48 MB chunks, then uploaded via the
Telegram Bot API. At the end of a run, the tool sends a **manifest** listing the
databases (connection URL encrypted) and the chunks (`file_id`). Restoring takes a
single command from the manifest.

> Telegram cloud storage is **not** end-to-end encrypted, so archives are encrypted
> before leaving the server. Without `SECRET_KEY`, backup contents cannot be read.

---

## 1. Features

- Scheduled daily backup (systemd timer / cron) for many databases at once.
- **Pluggable** dialects: v1 supports **PostgreSQL** and **MariaDB/MySQL**.
- Configuration & credentials encrypted at rest (`config.yaml.enc`).
- Archive encryption with AES-256-GCM, envelope format `tgdb1.<iv>.<ct>.<tag>`.
- Automatic chunking + SHA-256 verification at every transition.
- Single-command restore with interactive confirmation and production-host protection.
- Run & chunk history stored in a *control database* (`backup_runs`, `backup_chunks`).
- Structured logging, credential redaction, `--dry-run`.

## 2. Requirements

- Node.js **20+** (developed on Node 22). Also runs under Bun.
- Database clients on `PATH`: `pg_dump`, `psql` for PostgreSQL; `mysqldump`, `mysql`
  for MariaDB/MySQL.
- A Telegram bot + destination `chat_id`.
- A control database (PostgreSQL or MariaDB) for the audit tables.

## 3. Installation

```bash
npm install
npm run build          # output to dist/
npm test               # unit tests
# or run directly without building:
npm run dev -- backup --dry-run
```

Install as a global command (optional):

```bash
npm link               # provides `db2gram` on PATH
```

## 4. Telegram bot setup

1. Chat `@BotFather` → `/newbot` → save the **token**.
2. Create the destination channel/group, add the bot as admin (or send a message to
   the bot), then get the `chat_id` (e.g. via `@userinfobot` or
   `https://api.telegram.org/bot<token>/getUpdates`).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

## 5. Environment variables

| Var | Required | Description |
|---|---|---|
| `SECRET_KEY` | Yes | 32-byte base64 key (`openssl rand -base64 32`). Used for config, archives, and manifest URLs. |
| `ROOT_DATABASE_URL` | Yes* | Control DB for `backup_runs`/`backup_chunks`. *Not needed for `restore` and `--dry-run`; audit logging can be disabled with `TGDB_SKIP_STATE=1`. |
| `TELEGRAM_BOT_TOKEN` | Yes* | Bot token. *Not needed for `--dry-run`. |
| `TELEGRAM_CHAT_ID` | Yes* | Destination chat/channel. *Not needed for `--dry-run`. |
| `CONFIG_PATH` | No | Path to the encrypted config (default `./config.yaml.enc`). |
| `CHUNK_SIZE_MB` | No | Chunk size (default `48`, Bot API max is 50). |
| `TMP_DIR` | No | Temporary working directory (default `/tmp/tgdb`). |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` \| `silent` (default `info`). |
| `LOG_FORMAT` | No | `json` for structured logs. |
| `TGDB_SKIP_STATE` | No | `1` to skip audit logging. |
| `TELEGRAM_API_BASE` | No | Bot API endpoint override (for tests). |

## 6. Configuration

Copy `config.example.yaml`, fill in your databases, then encrypt:

```bash
cp config.example.yaml config.yaml
# edit config.yaml
export SECRET_KEY="$(openssl rand -base64 32)"   # store it somewhere safe!
npx db2gram encrypt-config --in config.yaml --out config.yaml.enc
rm config.yaml                                     # NEVER commit plaintext
```

`config.yaml` format:

```yaml
databases:
  - name: "main-app"          # unique, used for file naming
    dialect: "postgres"       # postgres | mariadb
    url: "postgresql://user:pass@host:5432/dbname"
  - name: "billing"
    dialect: "mariadb"
    url: "mariadb://user:pass@host:3306/billing"
```

To edit later: `npx db2gram decrypt-config --in config.yaml.enc --out config.yaml`.

## 7. Backup

```bash
npx db2gram backup                       # JSON manifest
npx db2gram backup --format yaml         # YAML manifest
npx db2gram backup --dry-run             # dump→zip→encrypt→split, no upload
npx db2gram backup --out-manifest ./m.json
```

Per-database flow: `dump → zip → encrypt → split(≤48MB) → upload chunks → manifest`.
One failing database does not stop the others; exit code is non-zero if any fail.
Failed chunk uploads are retried, honoring `retry_after` (429).

## 8. Restore

```bash
npx db2gram restore -m manifest.json
npx db2gram restore -m manifest.json --only-db main-app
npx db2gram restore -m manifest.json --only-db main-app --target-url "postgresql://user:pass@localhost:5432/restore_test" --yes
```

Restore order: `download chunks → SHA-256 verify per part → join → decrypt →
unzip → SHA-256 verify → restore`. Without `--yes`, the tool asks for confirmation
showing the DB name + target host. Hosts that look like production (`prod`,
`production`, `live`) are rejected unless `--force` is passed.

## 9. Emergency restore (≤10 steps)

1. Prepare a fresh machine with Node.js 20+ and the `psql`/`mysql` clients.
2. `git clone` this repo, then `npm install && npm run build`.
3. Set `SECRET_KEY` and `TELEGRAM_BOT_TOKEN` (`ROOT_DATABASE_URL` is not needed).
4. Download the latest `manifest-*.json` file from the Telegram chat to that machine.
5. Prepare an empty target database.
6. Run:
   `npx db2gram restore -m manifest-XXXX.json --only-db <name> --target-url "<target-url>" --yes`
7. Confirm the log shows `restore complete` and all checksums match.
8. Verify the data in the target database.

## 10. Scheduler

- systemd: install `systemd/tgdb-backup.service` and `systemd/tgdb-backup.timer`
  (see the comments inside the files). `systemctl enable --now tgdb-backup.timer`.
- cron: see `crontab.example`.

## 11. Adding a new dialect

Just implement `Dialect` and register it — the core stays untouched:

```ts
// src/dialects/sqlite.ts
import type { Dialect } from "./types.js";

export class SqliteDialect implements Dialect {
  readonly name = "sqlite";
  readonly urlSchemes = ["sqlite://"];
  async dump(url: string, output: string) { /* ... */ }
  async restore(url: string, input: string) { /* ... */ }
}
```

```ts
// src/dialects/index.ts
import { SqliteDialect } from "./sqlite.js";
registerDialect(new SqliteDialect());
```

## 12. Project structure

```
src/
  cli.ts            # commander: backup, restore, encrypt-config, decrypt-config
  crypto.ts         # AES-256-GCM (string/buffer/stream) + tgdb1 envelope
  config.ts         # zod schema, load/encrypt/decrypt config
  env.ts            # environment reading & validation
  manifest.ts       # build/parse/serialize manifest
  packaging.ts      # zip, encrypt, split, join, checksum verification
  telegram.ts       # sendDocument / getFile / download + 429 retry
  state.ts          # backup_runs / backup_chunks (pg & mysql2)
  logger.ts         # structured logging + redaction
  commands/         # backup & restore orchestration
  dialects/         # types, registry, mariadb, postgres, process runner
tests/              # unit + integration (Docker)
systemd/            # unit & timer
```

## 13. Manifest schema

```json
{
  "version": 1,
  "tool": "tgdb-backup",
  "created_at": "2026-10-01T02:00:00.000Z",
  "databases": [
    {
      "name": "main-app",
      "dialect": "postgres",
      "database_url_enc": "tgdb1.<iv>.<ct>.<tag>",
      "dump_sha256": "…",
      "archive_sha256": "…",
      "chunks": [
        { "part": 1, "file_id": "BQACAgUAAxkBAA…", "size_bytes": 50331648, "sha256": "…" }
      ]
    }
  ]
}
```

`file_id` is stored (not a public URL) because `getFile` URLs expire after ~1 hour.

## 14. Control database schema

```sql
backup_runs(id, started_at, finished_at, status, manifest_file_id)
backup_chunks(id, run_id, db_name, part_no, file_id, size_bytes, sha256)
```

Tables are created automatically on the first `backup` run.

## 15. Security

- `SECRET_KEY` comes from the environment only; it is never written to logs/manifests.
- Archives are encrypted **before** upload.
- Database passwords are passed to clients via environment (`PGPASSWORD`, `MYSQL_PWD`),
  not CLI arguments, so they never leak into the process list.
- Credentials in logs are redacted (`postgres://user:***@host/db`).
- Temp files use `600` permissions and are always removed (try/finally).
- A `file_id` can only be downloaded by a bot with the same token — keep the token secret.

## 16. Telegram limits

- Bot upload max is **50 MB** → default chunk is 48 MB.
- Rate limits: `retry_after` is honored, exponential backoff for transient errors.
- `getFile` expires after ~1 hour → the manifest stores `file_id`.

## 17. Testing

```bash
npm run test:unit          # unit tests (no DB needed)
npm run test:integration   # requires Docker: PostgreSQL 18 + MariaDB 11
```

`scripts/test-integration.sh` starts throwaway containers, runs real dump/restore
round-trip tests, then cleans up.

## 18. Non-goals (v1)

- Point-in-time recovery / incremental backup (full dumps only).
- Telegram end-to-end encryption.
- UI/dashboard (logs + manifest are enough).
