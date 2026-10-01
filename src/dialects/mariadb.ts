import { runCommand } from "./process.js";
import type { Dialect } from "./types.js";
import { parseConnectionUrl } from "./url.js";

const DEFAULT_PORT = 3306;

/**
 * MariaDB / MySQL adapter.
 *
 * Credentials are passed via the MYSQL_PWD environment variable so the
 * password never appears in the process list.
 */
export class MariadbDialect implements Dialect {
  readonly name = "mariadb";
  readonly urlSchemes = ["mariadb://", "mysql://"] as const;

  async dump(url: string, output: string): Promise<void> {
    const conn = parseConnectionUrl(url, DEFAULT_PORT);
    const args = [
      "--single-transaction",
      "--quick",
      "--routines",
      "--events",
      "--host",
      conn.host,
      "--port",
      String(conn.port),
    ];
    if (conn.username) args.push("--user", conn.username);
    args.push(conn.database);
    await runCommand("mysqldump", args, {
      env: passwordEnv(conn.password),
      stdoutFile: output,
      label: `mysqldump(${conn.database})`,
    });
  }

  async restore(url: string, input: string): Promise<void> {
    const conn = parseConnectionUrl(url, DEFAULT_PORT);
    const args = ["--host", conn.host, "--port", String(conn.port)];
    if (conn.username) args.push("--user", conn.username);
    args.push(conn.database);
    await runCommand("mysql", args, {
      env: passwordEnv(conn.password),
      stdinFile: input,
      label: `mysql(${conn.database})`,
    });
  }
}

function passwordEnv(password: string): NodeJS.ProcessEnv {
  return password ? { MYSQL_PWD: password } : {};
}
