import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TelegramError } from "../src/errors.js";
import { TelegramClient } from "../src/telegram.js";
import { TelegramMock } from "./helpers/telegram-mock.js";

const mock = new TelegramMock();
let client: TelegramClient;
let dir: string;

beforeAll(async () => {
  const baseUrl = await mock.start();
  client = new TelegramClient({ token: mock.token, chatId: "42", apiBase: baseUrl, maxRetries: 3 });
  dir = await mkdtemp(join(tmpdir(), "tgdb-telegram-"));
});
afterAll(async () => {
  await mock.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("TelegramClient", () => {
  it("uploads a document and returns its file_id", async () => {
    const file = join(dir, "chunk.part1");
    await writeFile(file, randomBytes(2048));
    const sent = await client.sendDocument(file, "part 1/3");
    expect(sent.fileId).toMatch(/^file-/);
    expect(mock.files.get(sent.fileId)?.caption).toBe("part 1/3");
    expect(mock.files.get(sent.fileId)?.chatId).toBe("42");
  });

  it("downloads the exact uploaded bytes", async () => {
    const file = join(dir, "chunk.part2");
    const data = randomBytes(5000);
    await writeFile(file, data);
    const sent = await client.sendDocument(file);
    const dest = join(dir, "downloaded.part2");
    await client.downloadFile(sent.fileId, dest);
    expect((await readFile(dest)).equals(data)).toBe(true);
  });

  it("honours 429 retry_after and succeeds", async () => {
    mock.failNext = 2;
    const file = join(dir, "chunk.part3");
    await writeFile(file, "retry me");
    const sent = await client.sendDocument(file);
    expect(sent.fileId).toMatch(/^file-/);
    expect(mock.failNext).toBe(0);
  });

  it("throws for an unknown file_id", async () => {
    await expect(client.getFile("does-not-exist")).rejects.toBeInstanceOf(TelegramError);
  });
});
