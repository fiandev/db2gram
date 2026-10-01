# tgdb-backup — agent notes

CLI tool: dump → zip → AES-256-GCM encrypt → split → upload to Telegram; restore
from a manifest. See `README.md` and the PRD for the full spec.

## Runtime & tooling

- **Node.js 20+ ESM** is the primary runtime. Code is written to also run under Bun.
- Package manager: **npm** (`package-lock.json` is the lockfile).
- Tests: **vitest** (`npm test`, `npm run test:unit`, `npm run test:integration`).
- Types: `npm run typecheck` (strict, NodeNext). Build: `npm run build` → `dist/`.
- Prefer `node:`-prefixed builtins. Avoid runtime-specific APIs without a guard
  (see `fileToBlob` in `src/telegram.ts`).

## Conventions

- Source imports use explicit `.js` extensions (NodeNext). Do not import `.ts`.
- Types live next to their implementation; use `import type` / inline `type`.
- All thrown errors extend `TgdbError` (see `src/errors.ts`) with a stable `code`.
- Never log or persist credentials. Use `redactUrl()`; pass DB passwords via env
  (`PGPASSWORD`, `MYSQL_PWD`), never argv.
- Temp files are mode `600` and cleaned in `finally`.
- Keep `src/dialects/` pluggable: new engines implement `Dialect` and register
  once in `src/dialects/index.ts`. Core backup/restore must not change.

## Testing

- Unit tests mock Telegram with `tests/helpers/telegram-mock.ts` and use a fake
  dialect for end-to-end backup/restore.
- Integration tests (`tests/integration/`) need Docker; run via
  `npm run test:integration`. They skip automatically when env URLs are absent.

```ts
import { test, expect } from "vitest";
```
