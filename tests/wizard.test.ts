import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyEnvValues,
  ensureBackupWizard,
  ensureConfigCryptoWizard,
  ensureRestoreWizard,
  getMissingBackupVars,
  getMissingRestoreVars,
  validateRequiredInput,
  validateSecretKeyInput,
} from "../src/wizard.js";

const VALID_KEY = randomBytes(32).toString("base64");

describe("wizard validation", () => {
  it("accepts a valid SECRET_KEY and rejects garbage", () => {
    expect(validateSecretKeyInput(VALID_KEY)).toBeUndefined();
    expect(validateSecretKeyInput("")).toMatch(/required/);
    expect(validateSecretKeyInput("not-a-key")).toMatch(/32 bytes/);
  });

  it("requires non-empty values", () => {
    expect(validateRequiredInput("TELEGRAM_BOT_TOKEN", "  ")).toMatch(/required/);
    expect(validateRequiredInput("TELEGRAM_BOT_TOKEN", "abc")).toBeUndefined();
  });
});

describe("getMissingBackupVars", () => {
  it("reports every required var when env is empty", () => {
    expect(getMissingBackupVars(false, {})).toEqual([
      "SECRET_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "ROOT_DATABASE_URL",
    ]);
  });

  it("only requires SECRET_KEY for dry runs", () => {
    expect(getMissingBackupVars(true, {})).toEqual(["SECRET_KEY"]);
    expect(getMissingBackupVars(true, { SECRET_KEY: VALID_KEY })).toEqual([]);
  });

  it("skips ROOT_DATABASE_URL when state logging is disabled", () => {
    const env = { SECRET_KEY: VALID_KEY, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", DB2GRAM_SKIP_STATE: "1" };
    expect(getMissingBackupVars(false, env)).toEqual([]);
  });

  it("uses existing env values without prompting", () => {
    const env = {
      SECRET_KEY: VALID_KEY,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_CHAT_ID: "1",
      ROOT_DATABASE_URL: "postgresql://u:p@localhost:5432/s",
    };
    expect(getMissingBackupVars(false, env)).toEqual([]);
  });
});

describe("getMissingRestoreVars", () => {
  it("requires SECRET_KEY and TELEGRAM_BOT_TOKEN only", () => {
    expect(getMissingRestoreVars({})).toEqual(["SECRET_KEY", "TELEGRAM_BOT_TOKEN"]);
    expect(getMissingRestoreVars({ SECRET_KEY: VALID_KEY, TELEGRAM_BOT_TOKEN: "t" })).toEqual([]);
  });
});

describe("ensure*Wizard in non-interactive mode", () => {
  it("resolves the backup config path without prompting", async () => {
    // vitest has no TTY, so the wizard must not block on prompts.
    const result = await ensureBackupWizard({ dryRun: true, configPath: "./custom.enc" });
    expect(result.configPath).toBe("./custom.enc");
  });

  it("fails fast when the restore manifest is missing", async () => {
    await expect(ensureRestoreWizard({})).rejects.toThrow(/manifest/);
  });

  it("passes explicit restore options through untouched", async () => {
    const result = await ensureRestoreWizard({ manifestPath: "./m.json", onlyDb: "db1", yes: true });
    expect(result).toEqual({ manifestPath: "./m.json", onlyDb: "db1", targetUrl: undefined, yes: true });
  });

  it("passes config crypto paths through without prompting", async () => {
    const encrypted = await ensureConfigCryptoWizard({
      inPath: "./config.yaml",
      outPath: "./config.yaml.enc",
      defaultIn: "./config.yaml",
      defaultOut: "./config.yaml.enc",
    });
    expect(encrypted).toEqual({ inPath: "./config.yaml", outPath: "./config.yaml.enc" });
  });

  it("falls back to defaults for empty config crypto paths", async () => {
    const decrypted = await ensureConfigCryptoWizard({
      defaultIn: "./config.yaml.enc",
      defaultOut: "./config.yaml",
    });
    expect(decrypted).toEqual({ inPath: "./config.yaml.enc", outPath: "./config.yaml" });
  });

  it("rejects --wizard without an interactive terminal", async () => {
    await expect(
      ensureConfigCryptoWizard({ wizard: true, defaultIn: "./a", defaultOut: "./b" }),
    ).rejects.toThrow(/interactive terminal/);
  });
});

describe("applyEnvValues", () => {
  it("sets and clears process.env entries", () => {
    applyEnvValues({ DB2GRAM_WIZARD_TEST: "abc" });
    expect(process.env.DB2GRAM_WIZARD_TEST).toBe("abc");
    applyEnvValues({ DB2GRAM_WIZARD_TEST: undefined });
    expect(process.env.DB2GRAM_WIZARD_TEST).toBeUndefined();
  });
});
