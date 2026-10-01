import { runCommand } from "./process.js";
import type { Dialect } from "./types.js";
import { parseConnectionUrl } from "./url.js";

const DEFAULT_PORT = 5432;

/**
 * PostgreSQL adapter. The password is passed via PGPASSWORD and `-w`
 * (--no-password) prevents an interactive prompt that would hang a scheduler.
 */
export class PostgresDialect implements Dialect {
  readonly name = "postgres";
  readonly urlSchemes = ["postgresql://", "postgres://"] as const;

  async dump(url: string, output: string): Promise<void> {
    const conn = parseConnectionUrl(url, DEFAULT_PORT);
    const args = [
      "--format=plain",
      "--no-password",
      "--host",
      conn.host,
      "--port",
      String(conn.port),
    ];
    if (conn.username) args.push("--username", conn.username);
    args.push("--dbname", conn.database);
    await runCommand("pg_dump", args, {
      env: passwordEnv(conn.password),
      stdoutFile: output,
      label: `pg_dump(${conn.database})`,
    });
  }

  async restore(url: string, input: string): Promise<void> {
    const conn = parseConnectionUrl(url, DEFAULT_PORT);
    const args = [
      "-v",
      "ON_ERROR_STOP=1",
      "--no-password",
      "--host",
      conn.host,
      "--port",
      String(conn.port),
    ];
    if (conn.username) args.push("--username", conn.username);
    args.push("--dbname", conn.database, "-f", input);
    await runCommand("psql", args, {
      env: passwordEnv(conn.password),
      label: `psql(${conn.database})`,
    });
  }
}

function passwordEnv(password: string): NodeJS.ProcessEnv {
  return password ? { PGPASSWORD: password } : {};
}
