import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/dialects/index.js";
import { runCommand } from "../src/dialects/process.js";
import { assertUrlScheme, getDialect, hasDialect, registerDialect } from "../src/dialects/registry.js";
import type { Dialect } from "../src/dialects/types.js";
import { parseConnectionUrl } from "../src/dialects/url.js";
import { DialectError } from "../src/errors.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "db2gram-dialects-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("dialect registry", () => {
  it("registers the built-in dialects", () => {
    expect(hasDialect("postgres")).toBe(true);
    expect(hasDialect("mariadb")).toBe(true);
    expect(getDialect("postgres").urlSchemes).toContain("postgresql://");
  });

  it("throws on an unknown dialect with a helpful message", () => {
    expect(() => getDialect("oracle")).toThrow(DialectError);
  });

  it("rejects duplicate registration", () => {
    const fake: Dialect = {
      name: "postgres",
      urlSchemes: ["postgres://"],
      dump: async () => {},
      restore: async () => {},
    };
    expect(() => registerDialect(fake)).toThrow(DialectError);
  });

  it("validates URL schemes", () => {
    expect(() => assertUrlScheme(getDialect("postgres"), "postgresql://h/db")).not.toThrow();
    expect(() => assertUrlScheme(getDialect("postgres"), "mysql://h/db")).toThrow(DialectError);
  });
});

describe("connection URL parsing", () => {
  it("decodes credentials and defaults the port", () => {
    const conn = parseConnectionUrl("postgresql://us%40er:p%3Ass@db.internal/mydb", 5432);
    expect(conn.username).toBe("us@er");
    expect(conn.password).toBe("p:ss");
    expect(conn.host).toBe("db.internal");
    expect(conn.port).toBe(5432);
    expect(conn.database).toBe("mydb");
  });

  it("honours an explicit port and strips leading slashes", () => {
    const conn = parseConnectionUrl("mariadb://root:root@127.0.0.1:3307/billing", 3306);
    expect(conn.port).toBe(3307);
    expect(conn.database).toBe("billing");
  });

  it("rejects a URL without a database name", () => {
    expect(() => parseConnectionUrl("postgresql://host/", 5432)).toThrow(DialectError);
  });
});

describe("runCommand", () => {
  it("pipes a file through stdin to stdout", async () => {
    const input = join(dir, "in.txt");
    const output = join(dir, "out.txt");
    await writeFile(input, "hello world");
    await runCommand("sh", ["-c", "cat"], { stdinFile: input, stdoutFile: output });
    expect(await readFile(output, "utf8")).toBe("hello world");
  });

  it("rejects on a non-zero exit code and surfaces stderr", async () => {
    await expect(runCommand("sh", ["-c", "echo boom >&2; exit 3"])).rejects.toThrow(/boom/);
  });

  it("rejects when the binary does not exist", async () => {
    await expect(runCommand("definitely-not-a-binary-xyz", [])).rejects.toBeInstanceOf(DialectError);
  });

  it("never leaks a password through argv", async () => {
    const secret = randomBytes(8).toString("hex");
    const script = join(dir, "args.sh");
    const output = join(dir, "args.out");
    await writeFile(script, "#!/bin/sh\nprintf '%s' \"$*\" > \"$OUT\"\n");
    await runCommand("sh", [script], {
      env: { OUT: output, PGPASSWORD: secret },
      label: "args",
    });
    const args = await readFile(output, "utf8");
    expect(args).not.toContain(secret);
  });
});
