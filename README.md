# tgdb-backup

Backup database otomatis multi-dialek ke Telegram. Setiap database di-*dump* ke SQL,
di-zip, **di-enkripsi (AES-256-GCM)**, dipecah menjadi chunk ≤48 MB, lalu di-upload
via Telegram Bot API. Di akhir run, tool mengirim **manifest** berisi daftar database
(URL terenkripsi) dan daftar chunk (`file_id`). Restore cukup satu perintah dari manifest.

> Telegram cloud **bukan** end-to-end encrypted, karena itu archive dienkripsi sebelum
> meninggalkan server. Tanpa `SECRET_KEY`, isi backup tidak bisa dibaca.

---

## 1. Fitur

- Backup harian terjadwal (systemd timer / cron) untuk banyak database sekaligus.
- Dialek **pluggable**: v1 mendukung **PostgreSQL** dan **MariaDB/MySQL**.
- Konfigurasi & kredensial terenkripsi at-rest (`config.yaml.enc`).
- Enkripsi archive dengan AES-256-GCM, format envelope `tgdb1.<iv>.<ct>.<tag>`.
- Chunking otomatis + verifikasi SHA-256 di setiap transisi.
- Restore satu perintah dengan konfirmasi interaktif dan proteksi host produksi.
- Riwayat run & chunk tersimpan di *control database* (`backup_runs`, `backup_chunks`).
- Log terstruktur, redaksi kredensial, `--dry-run`.

## 2. Kebutuhan

- Node.js **20+** (dikembangkan di Node 22). Kompatibel dijalankan dengan Bun.
- Client database di `PATH`: `pg_dump`, `psql` untuk PostgreSQL; `mysqldump`, `mysql`
  untuk MariaDB/MySQL.
- Bot Telegram + `chat_id` tujuan.
- Control database (PostgreSQL atau MariaDB) untuk tabel audit.

## 3. Instalasi

```bash
npm install
npm run build          # output ke dist/
npm test               # unit tests
# atau langsung tanpa build:
npm run dev -- backup --dry-run
```

Pasang sebagai perintah global (opsional):

```bash
npm link               # menyediakan `tgdb` di PATH
```

## 4. Setup bot Telegram

1. Chat `@BotFather` → `/newbot` → simpan **token**.
2. Buat channel/grup tujuan, tambahkan bot sebagai admin (atau kirim pesan ke bot),
   lalu ambil `chat_id` (mis. lewat `@userinfobot` atau
   `https://api.telegram.org/bot<token>/getUpdates`).
3. Isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID`.

## 5. Environment variables

| Var | Wajib | Deskripsi |
|---|---|---|
| `SECRET_KEY` | Ya | Kunci 32-byte base64 (`openssl rand -base64 32`). Untuk config, archive, dan URL di manifest. |
| `ROOT_DATABASE_URL` | Ya* | Control DB untuk `backup_runs`/`backup_chunks`. *Tidak diperlukan untuk `restore` dan `--dry-run`; bisa dimatikan dengan `TGDB_SKIP_STATE=1`. |
| `TELEGRAM_BOT_TOKEN` | Ya* | Token bot. *Tidak diperlukan untuk `--dry-run`. |
| `TELEGRAM_CHAT_ID` | Ya* | Chat/channel tujuan. *Tidak diperlukan untuk `--dry-run`. |
| `CONFIG_PATH` | Tidak | Path config terenkripsi (default `./config.yaml.enc`). |
| `CHUNK_SIZE_MB` | Tidak | Ukuran chunk (default `48`, maks Bot API 50). |
| `TMP_DIR` | Tidak | Direktori kerja sementara (default `/tmp/tgdb`). |
| `LOG_LEVEL` | Tidak | `debug` \| `info` \| `warn` \| `error` \| `silent` (default `info`). |
| `LOG_FORMAT` | Tidak | `json` untuk log terstruktur. |
| `TGDB_SKIP_STATE` | Tidak | `1` untuk melewati pencatatan audit. |
| `TELEGRAM_API_BASE` | Tidak | Override endpoint Bot API (untuk test). |

## 6. Konfigurasi

Salin `config.example.yaml`, isi database, lalu enkripsi:

```bash
cp config.example.yaml config.yaml
# edit config.yaml
export SECRET_KEY="$(openssl rand -base64 32)"   # simpan di tempat aman!
npx tgdb encrypt-config --in config.yaml --out config.yaml.enc
rm config.yaml                                     # JANGAN commit plaintext
```

Format `config.yaml`:

```yaml
databases:
  - name: "main-app"          # unik, dipakai untuk penamaan file
    dialect: "postgres"       # postgres | mariadb
    url: "postgresql://user:pass@host:5432/dbname"
  - name: "billing"
    dialect: "mariadb"
    url: "mariadb://user:pass@host:3306/billing"
```

Membaca kembali untuk edit: `npx tgdb decrypt-config --in config.yaml.enc --out config.yaml`.

## 7. Backup

```bash
npx tgdb backup                       # manifest JSON
npx tgdb backup --format yaml         # manifest YAML
npx tgdb backup --dry-run             # dump→zip→enkripsi→split, tanpa upload
npx tgdb backup --out-manifest ./m.json
```

Alur per database: `dump → zip → encrypt → split(≤48MB) → upload chunk → manifest`.
Satu database gagal tidak menghentikan database lain; exit code ≠ 0 jika ada yang gagal.
Chunk yang gagal di-upload akan di-retry dengan menghormati `retry_after` (429).

## 8. Restore

```bash
npx tgdb restore -m manifest.json
npx tgdb restore -m manifest.json --only-db main-app
npx tgdb restore -m manifest.json --only-db main-app --target-url "postgresql://user:pass@localhost:5432/restore_test" --yes
```

Urutan restore: `download chunk → verifikasi SHA-256 per part → gabung → decrypt →
unzip → verifikasi SHA-256 → restore`. Tanpa `--yes`, tool meminta konfirmasi yang
menampilkan nama DB + host target. Host yang tampak produksi (`prod`, `production`,
`live`) ditolak kecuali `--force`.

## 9. Restore darurat (≤10 langkah)

1. Siapkan mesin baru dengan Node.js 20+ dan client `psql`/`mysql`.
2. `git clone` repo ini lalu `npm install && npm run build`.
3. Set `SECRET_KEY` dan `TELEGRAM_BOT_TOKEN` (tidak perlu `ROOT_DATABASE_URL`).
4. Unduh file `manifest-*.json` terbaru dari chat Telegram ke mesin tersebut.
5. Siapkan database target kosong.
6. Jalankan:
   `npx tgdb restore -m manifest-XXXX.json --only-db <nama> --target-url "<url-target>" --yes`
7. Pastikan log menunjukkan `restore complete` dan semua checksum cocok.
8. Verifikasi data di database target.

## 10. Scheduler

- systemd: pasang `systemd/tgdb-backup.service` dan `systemd/tgdb-backup.timer`
  (lihat komentar di dalam file). `systemctl enable --now tgdb-backup.timer`.
- cron: lihat `crontab.example`.

## 11. Menambah dialek baru

Cukup implementasikan `Dialect` dan daftarkan — core tidak perlu diubah:

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

## 12. Struktur proyek

```
src/
  cli.ts            # commander: backup, restore, encrypt-config, decrypt-config
  crypto.ts         # AES-256-GCM (string/buffer/stream) + envelope tgdb1
  config.ts         # schema zod, load/encrypt/decrypt config
  env.ts            # pembacaan & validasi environment
  manifest.ts       # build/parse/serialize manifest
  packaging.ts      # zip, enkripsi, split, join, verifikasi checksum
  telegram.ts       # sendDocument / getFile / download + retry 429
  state.ts          # backup_runs / backup_chunks (pg & mysql2)
  logger.ts         # log terstruktur + redaksi
  commands/         # orkestrasi backup & restore
  dialects/         # types, registry, mariadb, postgres, process runner
tests/              # unit + integration (Docker)
systemd/            # unit & timer
```

## 13. Skema manifest

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

`file_id` dipakai (bukan URL publik) karena URL `getFile` kedaluwarsa ±1 jam.

## 14. Skema control database

```sql
backup_runs(id, started_at, finished_at, status, manifest_file_id)
backup_chunks(id, run_id, db_name, part_no, file_id, size_bytes, sha256)
```

Tabel dibuat otomatis saat pertama kali `backup` dijalankan.

## 15. Keamanan

- `SECRET_KEY` hanya dari environment; tidak pernah ditulis ke log/manifest.
- Archive dienkripsi **sebelum** upload.
- Password database dioper ke client via environment (`PGPASSWORD`, `MYSQL_PWD`),
  bukan argumen CLI, agar tidak bocor ke process list.
- Kredensial di log diredaksi (`postgres://user:***@host/db`).
- File sementara ber-permission `600` dan selalu dihapus (try/finally).
- `file_id` hanya bisa diunduh oleh bot dengan token yang sama — jaga kerahasiaan token.

## 16. Batasan Telegram

- Upload bot maks **50 MB** → chunk default 48 MB.
- Rate limit: `retry_after` dipatuhi, backoff eksponensial untuk error transient.
- `getFile` kedaluwarsa ±1 jam → manifest menyimpan `file_id`.

## 17. Testing

```bash
npm run test:unit          # unit tests (tanpa DB)
npm run test:integration   # butuh Docker: PostgreSQL 18 + MariaDB 11
```

`scripts/test-integration.sh` menyalakan container sementara, menjalankan uji
round-trip dump/restore nyata, lalu membersihkannya.

## 18. Non-tujuan (v1)

- Point-in-time recovery / incremental backup (full dump saja).
- Enkripsi end-to-end Telegram.
- UI/dashboard (cukup log + manifest).
