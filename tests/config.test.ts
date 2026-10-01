import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptConfigFile,
  encryptConfigFile,
  loadConfigFile,
  parseConfig,
  serializeConfig,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

const KEY = randomBytes(32);
const YAML = `databases:
  - name: main-app
    dialect: postgres
    url: "postgresql://user:pass@host:5432/dbname"
  - name: billing
    dialect: mariadb
    url: "mariadb://user:pass@host:3306/billing"
`;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "db2gram-config-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("parses and validates a config", () => {
    const config = parseConfig(YAML);
    expect(config.databases).toHaveLength(2);
    expect(config.databases[0]?.name).toBe("main-app");
  });

  it("rejects duplicate database names", () => {
    const dup = `databases:
  - {name: a, dialect: postgres, url: "postgres://h/db"}
  - {name: a, dialect: mariadb, url: "mysql://h/db"}
`;
    expect(() => parseConfig(dup)).toThrow(ConfigError);
  });

  it("rejects a config with no databases", () => {
    expect(() => parseConfig("databases: []")).toThrow(ConfigError);
  });

  it("encrypt-config then decrypt-config round-trips identically", async () => {
    const plain = join(dir, "config.yaml");
    const enc = join(dir, "config.yaml.enc");
    const back = join(dir, "config.back.yaml");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(plain, YAML);
    await encryptConfigFile(plain, enc, KEY);
    await decryptConfigFile(enc, back, KEY);

    expect(await readFile(back, "utf8")).toBe(YAML);
  });

  it("loadConfigFile transparently handles encrypted and plaintext files", async () => {
    const enc = join(dir, "config.yaml.enc");
    const encrypted = await loadConfigFile(enc, KEY);
    expect(encrypted.databases).toHaveLength(2);

    const plain = join(dir, "plain.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(plain, serializeConfig(encrypted));
    const parsed = await loadConfigFile(plain, KEY);
    expect(parsed.databases[1]?.dialect).toBe("mariadb");
  });
});
