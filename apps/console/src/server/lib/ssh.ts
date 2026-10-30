import { createHash } from "node:crypto";
import type { HostKeyScan } from "@edgeweir/contract";
import ssh2, { type ClientChannel, type ConnectConfig } from "ssh2";

const { Client, utils } = ssh2;

/**
 * SSH for the one-shot node install (ADR-0066), on ssh2. Host keys are
 * never trusted blindly: scanning only reads the key the server presents
 * (and then refuses it), connecting refuses any key but the expected one.
 * Nothing here logs; callers keep credentials out of their own logs too.
 */

/** OpenSSH's `SHA256:` fingerprint of a host key blob (base64, no padding). */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** The key type of a host key blob (its first SSH string), e.g. `ssh-ed25519`. */
export function hostKeyAlgorithm(key: Buffer): string | null {
  if (key.length < 4) return null;
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 64 || key.length < 4 + length) return null;
  return key.subarray(4, 4 + length).toString("latin1");
}

type SocketError = Error & { level?: string; code?: string };

/** Errors before the handshake ended: the host did not answer, or not as an SSH server. */
function connectFailure(error: SocketError): "unreachable" | "timeout" | "not_ssh" {
  if (error.level === "client-timeout") return "timeout";
  if (error.level === "client-socket" || error.level === "client-dns") {
    return error.code === "ETIMEDOUT" ? "timeout" : "unreachable";
  }
  return "not_ssh";
}

/** Reads the host key a server presents, then refuses it: no credential is ever sent. */
export function scanHostKey(
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<HostKeyScan> {
  return new Promise((resolve) => {
    const client = new Client();
    let presented: Buffer | null = null;
    let done = false;
    const finish = (error: HostKeyScan["error"]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.on("error", () => {});
      client.end();
      resolve({
        host: target.host,
        port: target.port,
        algorithm: presented ? hostKeyAlgorithm(presented) : null,
        fingerprint: presented ? hostKeyFingerprint(presented) : null,
        error: presented ? null : error,
      });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs + 1000);
    client.on("error", (error: SocketError) => finish(connectFailure(error)));
    client.on("ready", () => finish("not_ssh"));
    client.on("close", () => finish("not_ssh"));
    client.connect({
      host: target.host,
      port: target.port,
      username: "edgeweir",
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        presented = Buffer.from(key);
        return false;
      },
    });
  });
}

/** Why a session could not be opened or used. */
export class SshFailure extends Error {
  constructor(
    readonly code:
      | "host_key_mismatch"
      | "outbound_refused"
      | "unreachable"
      | "timeout"
      | "auth_failed"
      | "connection_lost",
    /** The fingerprint the host presented, for host_key_mismatch. */
    readonly presented: string | null = null,
  ) {
    super(code);
    this.name = "SshFailure";
  }
}

export interface SshLogin {
  host: string;
  port: number;
  username: string;
  password?: Buffer;
  privateKey?: Buffer;
  passphrase?: Buffer;
  /** OpenSSH `SHA256:` fingerprint; any other host key ends the handshake. */
  hostKeyFingerprint: string;
  readyTimeoutMs: number;
}

export interface SshSession {
  /**
   * Runs `command` through the login shell, writes `stdin` and closes it,
   * streams stdout and stderr (merged) to `onOutput`; resolves with the exit
   * status, null when the command ended on a signal or the connection broke.
   */
  exec(command: string, stdin: Buffer, onOutput: (chunk: Buffer) => void): Promise<number | null>;
  close(): void;
}

export type SshConnect = (login: SshLogin, signal: AbortSignal) => Promise<SshSession>;

/** Opens an authenticated session (password, key, keyboard-interactive with the password). */
export const openSshSession: SshConnect = (login, signal) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    let ready = false;
    const fail = (failure: SshFailure) => {
      client.removeAllListeners();
      client.on("error", () => {});
      client.end();
      signal.removeEventListener("abort", onAbort);
      reject(failure);
    };
    const onAbort = () => fail(new SshFailure("connection_lost"));
    signal.addEventListener("abort", onAbort, { once: true });
    client.on("error", (error: SocketError) => {
      if (ready) return;
      if (presented !== null && presented !== login.hostKeyFingerprint)
        return fail(new SshFailure("host_key_mismatch", presented));
      if (error.level === "client-authentication") return fail(new SshFailure("auth_failed"));
      const reason = connectFailure(error);
      fail(new SshFailure(reason === "not_ssh" ? "unreachable" : reason));
    });
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      const password = login.password?.toString("utf8") ?? "";
      finish(prompts.map(() => password));
    });
    client.on("ready", () => {
      ready = true;
      signal.removeEventListener("abort", onAbort);
      resolve(session(client));
    });
    const config: ConnectConfig = {
      host: login.host,
      port: login.port,
      username: login.username,
      readyTimeout: login.readyTimeoutMs,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        presented = hostKeyFingerprint(key);
        return presented === login.hostKeyFingerprint;
      },
    };
    if (login.password) {
      config.password = login.password.toString("utf8");
      config.tryKeyboard = true;
    }
    if (login.privateKey) {
      config.privateKey = login.privateKey;
      if (login.passphrase) config.passphrase = login.passphrase.toString("utf8");
    }
    client.connect(config);
  });

function session(client: InstanceType<typeof Client>): SshSession {
  let lost = false;
  client.on("error", () => {
    lost = true;
  });
  return {
    exec: (command, stdin, onOutput) =>
      new Promise((resolve, reject) => {
        client.exec(command, (error, channel: ClientChannel) => {
          if (error) return reject(new SshFailure("connection_lost"));
          let code: number | null = null;
          channel.on("data", onOutput);
          channel.stderr.on("data", onOutput);
          channel.on("exit", (status: number | null) => {
            code = typeof status === "number" ? status : null;
          });
          channel.on("close", () => (lost ? resolve(null) : resolve(code)));
          client.once("close", () => resolve(null));
          channel.end(stdin);
        });
      }),
    close: () => client.end(),
  };
}

/** Whether a private key parses (with its passphrase); never says more than that. */
export function checkPrivateKey(
  key: Buffer,
  passphrase: Buffer | undefined,
): "ok" | "invalid" | "passphrase" {
  const parsed = utils.parseKey(key, passphrase);
  if (!(parsed instanceof Error)) return "ok";
  return /passphrase|encrypted|decrypt|bad (?:decrypt|password)/i.test(parsed.message)
    ? "passphrase"
    : "invalid";
}
