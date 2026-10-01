import { createWriteStream } from "node:fs";
import * as nodeFs from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TelegramError } from "./errors.js";
import type { Logger } from "./logger.js";
import { sleep } from "./util.js";

const DEFAULT_API_BASE = "https://api.telegram.org";

export interface TelegramClientOptions {
  token: string;
  chatId?: string;
  apiBase?: string;
  logger?: Logger;
  maxRetries?: number;
}

export interface SentDocument {
  messageId: number;
  fileId: string;
  fileUniqueId?: string;
}

export interface RemoteFile {
  filePath: string;
  fileSize?: number;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface RawMessage {
  message_id: number;
  document?: { file_id: string; file_unique_id?: string };
}

interface RawFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 500, 30_000);
  return base + Math.floor(Math.random() * 250);
}

async function fileToBlob(path: string): Promise<Blob> {
  // `openAsBlob` streams from disk without buffering; not all runtimes expose it.
  const openAsBlob = (nodeFs as { openAsBlob?: (p: string, o?: { type?: string }) => Promise<Blob> })
    .openAsBlob;
  if (typeof openAsBlob === "function") {
    return openAsBlob(path, { type: "application/octet-stream" });
  }
  const buf = await readFile(path);
  return new Blob([buf], { type: "application/octet-stream" });
}

/**
 * Minimal Telegram Bot API client built on native fetch + FormData (Node 20+,
 * also Bun-compatible). Implements the PRD's rate-limit contract: honour
 * `retry_after` on 429 and back off exponentially on transient failures.
 */
export class TelegramClient {
  readonly #token: string;
  readonly #chatId?: string;
  readonly #apiBase: string;
  readonly #logger?: Logger;
  readonly #maxRetries: number;

  constructor(options: TelegramClientOptions) {
    if (!options.token) throw new TelegramError("TELEGRAM_BOT_TOKEN is required");
    this.#token = options.token;
    this.#chatId = options.chatId;
    this.#apiBase = (options.apiBase ?? process.env.TELEGRAM_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.#logger = options.logger;
    this.#maxRetries = options.maxRetries ?? 4;
  }

  #requireChatId(): string {
    if (!this.#chatId) throw new TelegramError("TELEGRAM_CHAT_ID is required");
    return this.#chatId;
  }

  async #call<T>(method: string, makeInit: () => RequestInit): Promise<T> {
    const url = `${this.#apiBase}/bot${this.#token}/${method}`;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, makeInit());
      } catch (err) {
        if (attempt <= this.#maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new TelegramError(`network error calling ${method}`, { cause: err });
      }

      const text = await response.text();
      let envelope: TelegramEnvelope<T> | undefined;
      try {
        envelope = JSON.parse(text) as TelegramEnvelope<T>;
      } catch {
        envelope = undefined;
      }

      if (response.ok && envelope?.ok) {
        return envelope.result as T;
      }

      const retryAfter = envelope?.parameters?.retry_after;
      if ((response.status === 429 || retryAfter !== undefined) && attempt <= this.#maxRetries) {
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
        this.#logger?.warn("telegram rate limited, retrying", { method, attempt, wait_ms: waitMs });
        await sleep(waitMs);
        continue;
      }
      if (response.status >= 500 && attempt <= this.#maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }

      throw new TelegramError(
        `Telegram ${method} failed: ${envelope?.description ?? response.statusText}`,
        { status: response.status, retryAfter },
      );
    }
  }

  /** Upload a file via sendDocument. Returns the Telegram file_id. */
  async sendDocument(filePath: string, caption?: string): Promise<SentDocument> {
    const chatId = this.#requireChatId();
    const blob = await fileToBlob(filePath);
    const name = basename(filePath);
    const result = await this.#call<RawMessage>("sendDocument", () => {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (caption) form.set("caption", caption);
      form.set("document", blob, name);
      return { method: "POST", body: form };
    });
    if (!result.document?.file_id) {
      throw new TelegramError("sendDocument response did not include a document file_id");
    }
    return {
      messageId: result.message_id,
      fileId: result.document.file_id,
      fileUniqueId: result.document.file_unique_id,
    };
  }

  /** Resolve a file_id to a temporary download path (valid ~1 hour). */
  async getFile(fileId: string): Promise<RemoteFile> {
    const result = await this.#call<RawFile>("getFile", () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    }));
    if (!result.file_path) {
      throw new TelegramError(`getFile did not return a file_path for ${fileId}`);
    }
    return { filePath: result.file_path, fileSize: result.file_size };
  }

  /** Download a file_id to a local path. */
  async downloadFile(fileId: string, destination: string): Promise<void> {
    const remote = await this.getFile(fileId);
    const url = `${this.#apiBase}/file/bot${this.#token}/${remote.filePath}`;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (err) {
        if (attempt <= this.#maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new TelegramError(`network error downloading ${fileId}`, { cause: err });
      }
      if (!response.ok || !response.body) {
        if (response.status >= 500 && attempt <= this.#maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new TelegramError(`failed to download ${fileId}: HTTP ${response.status}`, {
          status: response.status,
        });
      }
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(destination, { mode: 0o600 }),
      );
      return;
    }
  }
}
