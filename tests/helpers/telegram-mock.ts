import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface UploadedFile {
  fileId: string;
  filename: string;
  data: Buffer;
  chatId?: string;
  caption?: string;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: Array<{ name: string; filename: string; data: Buffer }>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body: Buffer, contentType: string | undefined): ParsedMultipart {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  const fields: Record<string, string> = {};
  const files: ParsedMultipart["files"] = [];
  if (!boundary) return { fields, files };

  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  let index = body.indexOf(delimiter);

  while (index !== -1) {
    const next = body.indexOf(delimiter, index + delimiter.length);
    if (next === -1) break;
    let part = body.subarray(index + delimiter.length, next);
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }
    const sepIndex = part.indexOf(separator);
    if (sepIndex !== -1) {
      const headerText = part.subarray(0, sepIndex).toString("utf8");
      const data = part.subarray(sepIndex + separator.length);
      const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? "";
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
      if (filename !== undefined) files.push({ name, filename, data });
      else fields[name] = data.toString("utf8");
    }
    index = next;
  }
  return { fields, files };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/**
 * In-process stand-in for the Telegram Bot API. Implements just enough of
 * sendDocument / getFile / file download to exercise the client and E2E tests.
 */
export class TelegramMock {
  readonly files = new Map<string, UploadedFile>();
  readonly calls: string[] = [];
  /** Number of upcoming sendDocument calls that should answer 429. */
  failNext = 0;
  baseUrl = "";

  #server: Server;
  #counter = 0;

  constructor(readonly token = "test-token") {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    this.calls.push(`${req.method} ${url}`);

    if (url === `/bot${this.token}/sendDocument`) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        json(res, 429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 0",
          parameters: { retry_after: 0 },
        });
        return;
      }
      const body = await readBody(req);
      const { fields, files } = parseMultipart(body, req.headers["content-type"]);
      const file = files[0];
      if (!file) {
        json(res, 400, { ok: false, error_code: 400, description: "no document" });
        return;
      }
      this.#counter += 1;
      const fileId = `file-${this.#counter}`;
      this.files.set(fileId, {
        fileId,
        filename: file.filename,
        data: file.data,
        chatId: fields.chat_id,
        caption: fields.caption,
      });
      json(res, 200, {
        ok: true,
        result: {
          message_id: this.#counter,
          document: { file_id: fileId, file_unique_id: `u-${this.#counter}` },
        },
      });
      return;
    }

    if (url === `/bot${this.token}/getFile`) {
      const body = await readBody(req);
      let fileId = "";
      try {
        fileId = (JSON.parse(body.toString("utf8")) as { file_id?: string }).file_id ?? "";
      } catch {
        fileId = "";
      }
      const file = this.files.get(fileId);
      if (!file) {
        json(res, 404, { ok: false, error_code: 404, description: "file not found" });
        return;
      }
      json(res, 200, {
        ok: true,
        result: { file_id: fileId, file_path: `docs/${fileId}`, file_size: file.data.length },
      });
      return;
    }

    if (req.method === "GET" && url.startsWith(`/file/bot${this.token}/`)) {
      const fileId = decodeURIComponent(url.slice(`/file/bot${this.token}/`.length).split("/").pop() ?? "");
      const file = this.files.get(fileId);
      if (!file) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(file.data);
      return;
    }

    json(res, 404, { ok: false, error_code: 404, description: "unknown method" });
  }
}
