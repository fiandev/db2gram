# db2gram

Automated multi-dialect database backup to Telegram. Each database is dumped to SQL,
zipped, **encrypted (AES-256-GCM)**, split into ≤48 MB chunks, then uploaded via the
Telegram Bot API. At the end of a run, the tool sends a **manifest** listing the
databases (connection URL encrypted) and the chunks (`file_id`). Restoring takes a
single command from the manifest.

<img src="./.github/assets/preview.png" alt="preview image">

---

> Telegram cloud storage is **not** end-to-end encrypted, so archives are encrypted
> before leaving the server. Without `SECRET_KEY`, backup contents cannot be read.

> Flow per database: `dump → zip → encrypt → split → upload chunks → manifest`

---

## Contents

1. [Features](#features)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Quick start](#quick-start)
5. [Wizard (interactive setup)](#wizard-interactive-setup)
6. [Step-by-step setup](#step-by-step-setup)
7. [Environment variables](#environment-variables)
8. [Configuration](#configuration-configyamlenc)
9. [Backup](#backup)
10. [Restore](#restore)
11. [Emergency restore](#emergency-restore)
12. [Scheduler (daily backup)](#scheduler-daily-backup)
13. [Adding a new dialect](#adding-a-new-dialect)
14. [Project structure](#project-structure)
15. [Manifest schema](#manifest-schema)
16. [Control database schema](#control-database-schema)
17. [Security](#security)
18. [Testing](#testing)
19. [Todo](#todo)

---

## Features

- Scheduled daily backup (systemd timer / cron) for many databases at once.
- **Pluggable** dialects: v1 supports **PostgreSQL** and **MariaDB/MySQL**.
- Configuration & credentials encrypted at rest (`config.yaml.enc`).
- **Interactive wizard** (`--wizard`) for backup and restore: guides you through
  every required value so you don't have to memorize env var names.
- Archive encryption with AES-256-GCM, envelope format `db2gram1.<iv>.<ct>.<tag>`.
- Automatic chunking + SHA-256 verification at every transition.
- Single-command restore with interactive confirmation and production-host protection.
- Run & chunk history stored in a _control database_ (`backup_runs`, `backup_chunks`).
- Structured logging, credential redaction, `--dry-run`.

## Prerequisites

| Requirement                                               | Check                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Node.js **20+** (22 recommended)                          | `node --version`                                                                                               |
| DB clients on `PATH`                                      | `pg_dump --version`, `psql --version` for Postgres; `mysqldump --version`, `mysql --version` for MariaDB/MySQL |
| A Telegram bot + `chat_id`                                | See [Step 1–2](#step-1--create-a-telegram-bot)                                                                 |
| A control database (Postgres or MariaDB) for audit tables | Any empty DB, e.g. `db2gram_state`. Skip with `DB2GRAM_SKIP_STATE=1` for dry runs                              |

Install clients on Debian/Ubuntu if missing:

```bash
# PostgreSQL clients
sudo apt install postgresql-client

# MariaDB/MySQL clients
sudo apt install mariadb-client
```

## Installation

Pick **one** option. Options A and B are recommended for most users.

### Option A — Global install (recommended for servers)

```bash
npm install -g db2gram
db2gram --help
db2gram backup --dry-run
```

Update later with:

```bash
npm update -g db2gram
```

### Option B — No install, via `npx`

Good for one-off restores or trying without installing:

```bash
npx -y db2gram@latest --help
npx -y db2gram@latest backup --dry-run
npx -y db2gram@latest restore -m manifest.json --only-db main-app
```

> Use `npx -y db2gram@latest` (not bare `npx db2gram`) to always get the latest
> published version without a stale cache prompt.

### Option C — From source

```bash
git clone https://github.com/fiandev/db2gram.git
cd db2gram
npm install
npm run build        # output to dist/
node dist/cli.js --help

# optional: expose `db2gram` on PATH from this checkout
npm link
```

### Option D — Single binary (no Node.js needed)

Download `db2gram-linux-x64`, `db2gram-darwin-arm64`, … from the GitHub Releases page:

```bash
chmod +x db2gram-linux-x64
./db2gram-linux-x64 --help
```

Or build it yourself with Bun:

```bash
npm run build:bin    # output to dist/bin/db2gram
```

All examples below use `db2gram`. If you installed via `npx`, replace `db2gram`
with `npx -y db2gram@latest`.

## Quick start

```bash
# 1. Install
npm install -g db2gram

# 2. Generate a secret key and save it (do this once, back it up offline)
openssl rand -base64 32
export SECRET_KEY="<output-from-above>"

# 3. Set Telegram + control DB env vars
export TELEGRAM_BOT_TOKEN="<token-from-BotFather>"
export TELEGRAM_CHAT_ID="<chat-id>"
export ROOT_DATABASE_URL="postgresql://user:pass@localhost:5432/db2gram_state"

# 4. Describe your databases, then encrypt the file
cp config.example.yaml config.yaml   # edit it with your DB URLs
db2gram encrypt-config --in config.yaml --out config.yaml.enc
rm config.yaml   # NEVER commit or deploy the plaintext

# 5. Verify locally without uploading
db2gram backup --dry-run

# 6. Real backup (uploads encrypted chunks + manifest to Telegram)
db2gram backup --out-manifest ./manifest.json
```

Next: [full step-by-step with Telegram setup](#step-by-step-setup).

## Wizard (interactive setup)

The easiest way to run `db2gram` is the built-in wizard (powered by
`@clack/prompts`). It runs right before `backup` or `restore` starts.

```bash
# Full guided setup: asks for SECRET_KEY, Telegram credentials,
# control DB, config path, manifest, and restore targets.
db2gram backup --wizard
db2gram restore --wizard

# Guided config encryption / decryption (asks for SECRET_KEY + in/out paths).
db2gram encrypt-config --wizard
db2gram decrypt-config --wizard

# Dry run with guidance (only asks for SECRET_KEY + config path).
db2gram backup --dry-run --wizard
```

How `--wizard` behaves:

| Mode | Behavior |
| ---- | -------- |
| `backup --wizard` / `restore --wizard` | **Ignores all existing env vars** and asks for everything via the wizard. |
| `backup` / `restore` (no flag) | **Reuses every env var you already set** and only prompts for the missing ones. If everything is set, no wizard appears. |

What each wizard asks:

- **Backup:** `SECRET_KEY`, config path (`CONFIG_PATH`), `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, `ROOT_DATABASE_URL` (or opt out with `DB2GRAM_SKIP_STATE=1`).
  Telegram + control DB questions are skipped for `--dry-run`.
- **Restore:** `SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, manifest path, which database to
  restore (picked from the manifest), optional custom `--target-url`, and whether
  to skip confirmation (`--yes`).
- **Encrypt/decrypt config:** `SECRET_KEY` plus input/output paths
  (`--in` / `--out`). Without `--wizard` only a missing `SECRET_KEY` is prompted,
  since the paths already have CLI defaults.

Notes:

- The wizard needs an interactive terminal. In CI / non-TTY it exits with a clear
  error — set env vars explicitly instead (see below).
- Press `Ctrl+C` at any prompt to cancel safely.
- Answers are written to `process.env` for that run only; nothing is saved to disk.

## Step-by-step setup

### Step 0 — Decide where to run it

You need one machine (VPS, NAS, CI runner) with Node.js 20+, DB clients, network
access to your databases, and outbound HTTPS to `api.telegram.org`.

### Step 1 — Create a Telegram bot

1. Open Telegram and chat with `@BotFather`.
2. Send `/newbot`, follow the prompts (pick a name + username ending in `bot`).
3. Copy the **HTTP API token** it returns, e.g. `123456:ABC-DEF...`.
4. This is your `TELEGRAM_BOT_TOKEN`. Treat it like a password.

### Step 2 — Get the destination `chat_id`

The bot uploads backups to one chat: your private DM, a group, or a channel.
Pick one path:

**Path A — Private chat (simplest for testing):**

1. Search for your new bot by username, press Start (or send `/start`).
2. Send any message to the bot.
3. In a browser or terminal, open (replace `<token>`):

   ```bash
   curl "https://api.telegram.org/bot<token>/getUpdates"
   ```

4. Find `"chat":{"id": 123456789, ...}`. That number is your `TELEGRAM_CHAT_ID`.

**Path B — Group:**

1. Create a group, add the bot as a member.
2. Send a test message in the group (e.g. `hello db2gram`).
3. Call `getUpdates` as above. The group `chat.id` is usually negative
   (e.g. `-1001234567890`).

**Path C — Channel:**

1. Create a channel, add the bot as **admin** with post permission.
2. Post a test message in the channel.
3. Call `getUpdates` as above and copy the channel `chat.id`.

Alternative: forward any message to `@userinfobot` / `@getmyid_bot` to see IDs.
If `getUpdates` returns `[]`, the bot received no new messages yet — send another
message and retry.

### Step 3 — Generate `SECRET_KEY`

This single key encrypts `config.yaml.enc`, every backup archive, and every
database URL inside the manifest. **Losing it means backups cannot be restored.**

```bash
openssl rand -base64 32
```

Copy the output and store it in a password manager + offline backup. It must
decode to exactly 32 bytes (the default `openssl` output does).

### Step 4 — Set environment variables

Create a `.env` file (never commit it) or export the vars in your shell:

```bash
cp .env.example .env
# then edit .env
```

Minimal `.env`:

```dotenv
SECRET_KEY=<output-from-step-3>
ROOT_DATABASE_URL=postgresql://user:pass@localhost:5432/db2gram_state
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-1001234567890
```

Notes:

- `db2gram` auto-loads `.env` from the working directory.
- On servers, prefer a root-owned env file (e.g. `/etc/db2gram.env`, `chmod 600`).
- `ROOT_DATABASE_URL` can be `postgresql://…` or `mysql://…` / `mariadb://…`.
- For `--dry-run` and `restore`, `ROOT_DATABASE_URL` is not required.
  To skip audit logging entirely: `DB2GRAM_SKIP_STATE=1`.

Verify they are loaded:

```bash
db2gram backup --dry-run   # fails fast with a clear error if a var is missing
```

> Tip: you don't have to set everything upfront. Running `db2gram backup` or
> `db2gram restore` without `--wizard` reuses whatever env vars exist and only
> prompts for the missing ones. Pass `--wizard` to start from scratch and be
> guided through every value.

### Step 5 — Write `config.yaml` and encrypt it

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
databases:
  - name: "main-app" # unique, used for file naming
    dialect: "postgres" # postgres | mariadb
    url: "postgresql://user:pass@host:5432/dbname"
  - name: "billing"
    dialect: "mariadb"
    url: "mariadb://user:pass@host:3306/billing"
```

Then encrypt and delete the plaintext:

```bash
export SECRET_KEY="<your-key>"   # required for this step
db2gram encrypt-config --in config.yaml --out config.yaml.enc
rm config.yaml                   # NEVER commit plaintext
```

To edit later:

```bash
db2gram decrypt-config --in config.yaml.enc --out config.yaml
# edit config.yaml, then re-encrypt and delete it again
db2gram encrypt-config --in config.yaml --out config.yaml.enc
rm config.yaml
```

### Step 6 — Dry run (no upload)

```bash
db2gram backup --dry-run
```

This runs the full local pipeline (`dump → zip → encrypt → split`) and validates
config, `SECRET_KEY`, and DB connectivity — but skips Telegram upload and audit
logging. Fix any errors before continuing.

### Step 7 — First real backup

```bash
db2gram backup --out-manifest ./manifest.json
```

What happens:

1. Each database is dumped, zipped, encrypted, and split into ≤48 MB chunks.
2. Chunks + a `manifest-*.json` are uploaded to your `TELEGRAM_CHAT_ID`.
3. A local copy is saved to `./manifest.json` (because of `--out-manifest`).
4. One failing database does not stop the others; exit code is non-zero if any fail.

Check the Telegram chat: you should see chunk files + the manifest. Save the
manifest — you need it (plus `SECRET_KEY` + `TELEGRAM_BOT_TOKEN`) to restore.

### Step 8 — Schedule daily backups

See [Section 11](#11-scheduler-daily-backup) for systemd timer and cron examples.

### Step 9 — Test a restore now

Do not wait for an emergency. Restore to an empty test database:

```bash
db2gram restore -m manifest.json --only-db main-app \
  --target-url "postgresql://user:pass@localhost:5432/restore_test" --yes
```

If this succeeds, your setup is complete.

## Environment variables

| Var                  | Required | Description                                                                                                                                          |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_KEY`         | Yes      | 32-byte base64 key (`openssl rand -base64 32`). Used for config, archives, and manifest URLs.                                                        |
| `ROOT_DATABASE_URL`  | Yes\*    | Control DB for `backup_runs`/`backup_chunks`. \*Not needed for `restore` and `--dry-run`; audit logging can be disabled with `DB2GRAM_SKIP_STATE=1`. |
| `TELEGRAM_BOT_TOKEN` | Yes\*    | Bot token from `@BotFather`. \*Not needed for `--dry-run`.                                                                                           |
| `TELEGRAM_CHAT_ID`   | Yes\*    | Destination chat/channel ID. \*Not needed for `--dry-run`.                                                                                           |
| `CONFIG_PATH`        | No       | Path to the encrypted config (default `./config.yaml.enc`). Override per-command with `--config`.                                                    |
| `CHUNK_SIZE_MB`      | No       | Chunk size (default `48`, Bot API max is 50).                                                                                                        |
| `TMP_DIR`            | No       | Temporary working directory (default `/tmp/db2gram`).                                                                                                |
| `LOG_LEVEL`          | No       | `debug` \| `info` \| `warn` \| `error` \| `silent` (default `info`).                                                                                 |
| `LOG_FORMAT`         | No       | `json` for structured logs.                                                                                                                          |
| `DB2GRAM_SKIP_STATE` | No       | `1` to skip audit logging.                                                                                                                           |
| `TELEGRAM_API_BASE`  | No       | Bot API endpoint override (for tests).                                                                                                               |

## Configuration (`config.yaml.enc`)

- Source file is plain YAML (`config.yaml`); deployed file is always the encrypted
  `config.yaml.enc` (a `db2gram1` envelope, decryptable only with `SECRET_KEY`).
- Each entry needs a unique `name`, a `dialect` (`postgres` | `mariadb`), and a `url`.
- URL schemes: `postgresql://…`, `postgres://…` for Postgres;
  `mariadb://…`, `mysql://…` for MariaDB/MySQL.
- Default lookup path is `./config.yaml.enc`; override with `CONFIG_PATH` env var
  or `--config <path>` on the `backup` command.

## Backup

```bash
db2gram backup                       # JSON manifest to Telegram + stdout
db2gram backup --wizard              # guided setup, ignores existing env vars
db2gram backup --format yaml         # YAML manifest instead
db2gram backup --dry-run             # dump→zip→encrypt→split, no upload
db2gram backup --out-manifest ./m.json
db2gram backup --config ./other.enc  # use a non-default config path
```

Without `--wizard`, missing env vars are prompted one by one; with `--wizard`,
all values come from the wizard. `--dry-run` only needs `SECRET_KEY` + config.

Per-database flow: `dump → zip → encrypt → split(≤48MB) → upload chunks → manifest`.
One failing database does not stop the others; exit code is non-zero if any fail.
Failed chunk uploads are retried, honoring `retry_after` (429).

With `npx`:

```bash
npx -y db2gram@latest backup --dry-run
npx -y db2gram@latest backup --out-manifest ./m.json
```

## Restore

```bash
db2gram restore -m manifest.json
db2gram restore --wizard             # asks for manifest, DB choice, target, --yes
db2gram restore -m manifest.json --only-db main-app
db2gram restore -m manifest.json --only-db main-app --target-url "postgresql://user:pass@localhost:5432/restore_test" --yes
```

Restore order: `download chunks → SHA-256 verify per part → join → decrypt →
unzip → SHA-256 verify → restore`. Without `--yes`, the tool asks for confirmation
showing the DB name + target host. Hosts that look like production (`prod`,
`production`, `live`) are rejected unless `--force` is passed.

Requirements for restore: `SECRET_KEY` + `TELEGRAM_BOT_TOKEN`. `ROOT_DATABASE_URL`
is not needed. The target database must already exist (create an empty one first).

## Emergency restore

You only need 3 things: `SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, and the manifest file
(from Telegram or your `--out-manifest` copy).

1. Prepare a fresh machine with Node.js 20+ and the `psql`/`mysql` clients.
2. Install the tool: `npm install -g db2gram` (or use `npx -y db2gram@latest`).
3. Set `SECRET_KEY` and `TELEGRAM_BOT_TOKEN` in the environment.
4. Download the latest `manifest-*.json` file from the Telegram chat to that machine.
5. Prepare an empty target database (`CREATE DATABASE restore_test;`).
6. Run:
   `db2gram restore -m manifest-XXXX.json --only-db <name> --target-url "<target-url>" --yes`
7. Confirm the log shows `restore complete` and all checksums match.
8. Verify the data in the target database.

## Scheduler (daily backup)

### systemd (recommended for VPS)

1. Copy files and edit paths/env to match your install:

   ```bash
   sudo cp systemd/db2gram.service /etc/systemd/system/
   sudo cp systemd/db2gram.timer /etc/systemd/system/
   sudo mkdir -p /opt/db2gram /var/lib/db2gram
   ```

2. Create `/etc/db2gram.env` (root-owned, secrets only):

   ```dotenv
   SECRET_KEY=...
   ROOT_DATABASE_URL=...
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```

   ```bash
   sudo chmod 600 /etc/db2gram.env
   sudo chown root:db2gram /etc/db2gram.env
   ```

3. If you installed via `npm install -g`, point `ExecStart` at the global binary
   (`which db2gram`) instead of `/usr/bin/node /opt/db2gram/dist/cli.js`.
   Otherwise deploy the checkout to `/opt/db2gram` with `config.yaml.enc` beside it.

4. Enable the daily timer:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now db2gram.timer
   systemctl list-timers | grep db2gram
   ```

   Default schedule is `02:00` daily (see `systemd/db2gram.timer`).

### cron (alternative)

See `crontab.example`. Example (runs daily at 02:00):

```bash
0 2 * * * cd /opt/db2gram && set -a && . /etc/db2gram.env && set +a && \
  /usr/bin/node dist/cli.js backup --format json --out-manifest /var/lib/db2gram/manifest-latest.json >> /var/log/db2gram.log 2>&1
```

If installed globally, replace the `node dist/cli.js` part with `/usr/local/bin/db2gram`.

## Adding a new dialect

Just implement `Dialect` and register it — the core stays untouched:

```ts
// src/dialects/sqlite.ts
import type { Dialect } from "./types.js";

export class SqliteDialect implements Dialect {
  readonly name = "sqlite";
  readonly urlSchemes = ["sqlite://"];
  async dump(url: string, output: string) {
    /* ... */
  }
  async restore(url: string, input: string) {
    /* ... */
  }
}
```

```ts
// src/dialects/index.ts
import { SqliteDialect } from "./sqlite.js";
registerDialect(new SqliteDialect());
```

## Project structure

```
src/
  cli.ts            # commander: backup, restore, encrypt-config, decrypt-config
  wizard.ts         # @clack/prompts wizard: fills missing env / full --wizard setup
  crypto.ts         # AES-256-GCM (string/buffer/stream) + db2gram1 envelope
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

## Manifest schema

```json
{
  "version": 1,
  "tool": "db2gram",
  "created_at": "2026-10-01T02:00:00.000Z",
  "databases": [
    {
      "name": "main-app",
      "dialect": "postgres",
      "database_url_enc": "db2gram1.<iv>.<ct>.<tag>",
      "dump_sha256": "…",
      "archive_sha256": "…",
      "chunks": [
        {
          "part": 1,
          "file_id": "BQACAgUAAxkBAA…",
          "size_bytes": 50331648,
          "sha256": "…"
        }
      ]
    }
  ]
}
```

`file_id` is stored (not a public URL) because `getFile` URLs expire after ~1 hour.

## Control database schema

```sql
backup_runs(id, started_at, finished_at, status, manifest_file_id)
backup_chunks(id, run_id, db_name, part_no, file_id, size_bytes, sha256)
```

Tables are created automatically on the first `backup` run.

## Security

- `SECRET_KEY` comes from the environment only; it is never written to logs/manifests.
- Archives are encrypted **before** upload.
- Database passwords are passed to clients via environment (`PGPASSWORD`, `MYSQL_PWD`),
  not CLI arguments, so they never leak into the process list.
- Credentials in logs are redacted (`postgres://user:***@host/db`).
- Temp files use `600` permissions and are always removed (try/finally).
- A `file_id` can only be downloaded by a bot with the same token — keep the token secret.

## Testing

```bash
npm run test:unit          # unit tests (no DB needed)
npm run test:integration   # requires Docker: PostgreSQL 18 + MariaDB 11
```

`scripts/test-integration.sh` starts throwaway containers, runs real dump/restore
round-trip tests, then cleans up.

## Troubleshooting

| Symptom                                                       | Likely cause / fix                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_KEY must decode to 32 bytes`                          | Key has extra newline/space or is not `openssl rand -base64 32` output. Regenerate and `export` without quotes issues.                |
| `required environment variable TELEGRAM_BOT_TOKEN is not set` | `.env` not in working dir or vars not exported. `db2gram` auto-loads `./.env`; for systemd/cron source `/etc/db2gram.env` explicitly. |
| `getUpdates` returns `{"result":[]}`                          | Bot received no new messages. Send `/start` or a test message, then retry.                                                            |
| `chat not found` on backup                                    | Wrong `TELEGRAM_CHAT_ID`, or bot not added / not admin in that group/channel. Re-add and resend a message.                            |
| `pg_dump: command not found`                                  | DB client missing on `PATH`. Install `postgresql-client` / `mariadb-client`.                                                          |
| Restore asks for confirmation in CI                           | Pass `--yes` (and `--force` only if you really target a prod-like host).                                                              |

## TODO

- Point-in-time recovery / incremental backup (full dumps only).
- Telegram end-to-end encryption.
- UI/dashboard (logs + manifest are enough).
