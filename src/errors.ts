/**
 * Typed error hierarchy. Every failure path in db2gram throws one of these so the
 * CLI can map errors to exit codes and readable messages without guessing.
 */
export class Db2gramError extends Error {
  readonly code: string;

  constructor(message: string, code = "DB2GRAM_ERROR", options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EnvError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ENV_ERROR", options);
  }
}

export class ConfigError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG_ERROR", options);
  }
}

export class CryptoError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CRYPTO_ERROR", options);
  }
}

export class DialectError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "DIALECT_ERROR", options);
  }
}

export class PackagingError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "PACKAGING_ERROR", options);
  }
}

export class TelegramError extends Db2gramError {
  readonly retryAfter?: number;
  readonly status?: number;

  constructor(
    message: string,
    options?: { cause?: unknown; retryAfter?: number; status?: number },
  ) {
    super(message, "TELEGRAM_ERROR", { cause: options?.cause });
    this.retryAfter = options?.retryAfter;
    this.status = options?.status;
  }
}

export class ManifestError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "MANIFEST_ERROR", options);
  }
}

export class StateError extends Db2gramError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "STATE_ERROR", options);
  }
}
