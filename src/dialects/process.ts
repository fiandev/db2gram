import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { DialectError } from "../errors.js";

export interface RunOptions {
  /** Extra environment variables (used for credentials so they never hit argv). */
  env?: NodeJS.ProcessEnv;
  /** Feed this file to the process stdin. */
  stdinFile?: string;
  /** Capture process stdout into this file (mode 600). */
  stdoutFile?: string;
  /** Human label for error messages. */
  label?: string;
}

const MAX_STDERR = 64 * 1024;

/**
 * Spawn a command, optionally piping a file to stdin / stdout, and reject on a
 * non-zero exit code. Credentials are passed through `env`, never argv.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<void> {
  const label = options.label ?? command;
  const child = spawn(command, args, {
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  let stderrLen = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrLen < MAX_STDERR) {
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    }
  });

  // stdin: pipe the dump in, or close immediately.
  if (options.stdinFile) {
    child.stdin.on("error", () => {
      /* EPIPE if the process exits early; surfaced via exit code instead. */
    });
    createReadStream(options.stdinFile).on("error", (err) => child.stdin.destroy(err)).pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  // stdout: stream to disk, or drain.
  let stdoutDone: Promise<void>;
  if (options.stdoutFile) {
    const out = createWriteStream(options.stdoutFile, { mode: 0o600 });
    stdoutDone = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
      child.stdout.on("error", reject);
    });
    child.stdout.pipe(out);
  } else {
    child.stdout.resume();
    stdoutDone = Promise.resolve();
  }

  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } catch (err) {
    throw new DialectError(
      `failed to start ${label}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  await stdoutDone;
  if (code !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
    throw new DialectError(`${label} ${reason}${stderr ? `: ${stderr}` : ""}`);
  }
}
