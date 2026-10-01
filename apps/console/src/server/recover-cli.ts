import { parseArgs } from "node:util";
import type { Database } from "@edgeweir/db";
import { DrizzleQueryError } from "drizzle-orm";
import type { Auth } from "./lib/auth";
import {
  checkNewPassword,
  findOperator,
  RecoveryError,
  type RecoveryResult,
  recoverAccount,
} from "./services/recovery";

export const RECOVER_USAGE = `Usage: node dist/server/recover.js [--reset-password] [--disable-two-factor]

Recovers the console's only account when you can no longer sign in.

  --reset-password      Set a new password: asked for twice without echo on a
                        terminal, otherwise read from the first line of
                        standard input.
  --disable-two-factor  Turn two-factor authentication off and delete the TOTP
                        secret and backup codes.
  -h, --help            Show this help.

Signs out every session of the account and writes an audit log entry
(account.recover). Reads DATABASE_URL and the other settings from the
environment, like the console.
`;

/** Standard input: a terminal (read in raw mode, without echo) or a pipe. */
export interface RecoverStdin {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface RecoverIo {
  stdin: RecoverStdin;
  /** The account and what changed. */
  stdout: { write(text: string): unknown };
  /** Prompts, usage and errors. */
  stderr: { write(text: string): unknown };
}

export interface RecoverConnection {
  db: Database;
  auth: Auth;
  close(): Promise<void>;
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const CTRL_U = "\u0015";
const ESCAPE = "\u001b";

/** Reads one line from a terminal in raw mode, so the characters are not echoed. */
function readHidden(input: RecoverStdin, prompt: { write(text: string): unknown }, label: string) {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      prompt.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === CTRL_C || (ch === CTRL_D && value === "")) {
          return finish(new RecoveryError("cancelled"));
        }
        // Arrow and function keys: drop the escape sequence.
        if (ch === ESCAPE) return;
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (ch === CTRL_U) value = "";
        else if (ch >= " ") value += ch;
      }
    };
    prompt.write(label);
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** The first line of piped input, without its line ending; null when there is none. */
function readLine(input: RecoverStdin) {
  return new Promise<string | null>((resolve, reject) => {
    let buffered = "";
    const done = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
    };
    const onData = (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      done();
      resolve(buffered.slice(0, end).replace(/\r$/, ""));
    };
    const onEnd = () => {
      done();
      resolve(buffered === "" ? null : buffered.replace(/\r$/, ""));
    };
    const onError = (error: Error) => {
      done();
      reject(error);
    };
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * The new password, never taken from the command line (it would show in the
 * process list and the shell history): typed twice on a terminal, or the
 * first line of standard input (`docker compose exec -T … < file`).
 */
export async function readNewPassword(
  io: RecoverIo,
  check: (password: string) => Promise<void>,
): Promise<string> {
  if (io.stdin.isTTY && io.stdin.setRawMode) {
    const password = await readHidden(io.stdin, io.stderr, "New password: ");
    await check(password);
    const again = await readHidden(io.stdin, io.stderr, "Repeat new password: ");
    if (again !== password) throw new RecoveryError("the passwords do not match");
    return password;
  }
  const password = await readLine(io.stdin);
  if (!password) throw new RecoveryError("no password on standard input");
  await check(password);
  return password;
}

function report(result: RecoveryResult, disableTwoFactor: boolean): string[] {
  const lines: string[] = [];
  if (result.passwordReset) lines.push("Password reset.");
  if (disableTwoFactor) {
    lines.push(
      result.twoFactorDisabled
        ? "Two-factor authentication turned off."
        : "Two-factor authentication was already off.",
    );
  }
  const n = result.sessionsRevoked;
  lines.push(`Signed out ${n} ${n === 1 ? "session" : "sessions"}.`);
  return lines;
}

/** What went wrong, without query parameters (a failed update carries the password hash). */
function failure(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    return error.cause instanceof Error ? error.cause.message : "database query failed";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `recover.js`: returns the exit code (0 done, 1 failed, 2 usage). Nothing
 * secret is printed: not the password, its hash or a session token.
 */
export async function runRecover(
  argv: string[],
  io: RecoverIo,
  connect: () => RecoverConnection | Promise<RecoverConnection>,
): Promise<number> {
  let values: { "reset-password"?: boolean; "disable-two-factor"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "reset-password": { type: "boolean" },
        "disable-two-factor": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.stderr.write(`error: ${(error as Error).message}\n\n${RECOVER_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout.write(RECOVER_USAGE);
    return 0;
  }
  const resetPassword = values["reset-password"] === true;
  const disableTwoFactor = values["disable-two-factor"] === true;
  if (!resetPassword && !disableTwoFactor) {
    io.stderr.write(RECOVER_USAGE);
    return 2;
  }

  let connection: RecoverConnection | undefined;
  try {
    connection = await connect();
    const { auth } = connection;
    const operator = await findOperator(connection.db);
    io.stdout.write(`Account: ${operator.name} <${operator.email}>\n`);
    const password = resetPassword
      ? await readNewPassword(io, (value) => checkNewPassword(auth, value))
      : undefined;
    const result = await recoverAccount(connection, { password, disableTwoFactor });
    for (const line of report(result, disableTwoFactor)) io.stdout.write(`${line}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`error: ${failure(error)}\n`);
    return 1;
  } finally {
    await connection?.close().catch(() => {});
  }
}
