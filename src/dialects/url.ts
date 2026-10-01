import { DialectError } from "../errors.js";

export interface ConnectionParams {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
  /** Raw query params (e.g. ssl, sslmode). */
  searchParams: URLSearchParams;
}

/** Parse a connection URL, percent-decoding credentials. Never logs the URL. */
export function parseConnectionUrl(url: string, defaultPort: number): ConnectionParams {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new DialectError("invalid connection URL", { cause: err });
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!database) {
    throw new DialectError("connection URL is missing a database name");
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
  if (!Number.isFinite(port) || port <= 0) {
    throw new DialectError(`connection URL has an invalid port "${parsed.port}"`);
  }
  return {
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname || "localhost",
    port,
    database,
    searchParams: parsed.searchParams,
  };
}
