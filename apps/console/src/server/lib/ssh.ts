import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
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
function hostKeyAlgorithm(key: Buffer): string | null {
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
  sock?: ClientChannel,
  signal?: AbortSignal,
): Promise<HostKeyScan> {
  return new Promise((resolve) => {
    const client = new Client();
    let presented: Buffer | null = null;
    let done = false;
    const finish = (error: HostKeyScan["error"]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.removeAllListeners();
      client.on("error", () => {});
      client.destroy();
      resolve({
        host: target.host,
        port: target.port,
        algorithm: presented ? hostKeyAlgorithm(presented) : null,
        fingerprint: presented ? hostKeyFingerprint(presented) : null,
        error: presented ? null : error,
        errorHop: null,
        presentedFingerprint: null,
      });
    };
    const onAbort = () => finish("connection_lost");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    client.on("error", (error: SocketError) => finish(connectFailure(error)));
    client.on("ready", () => finish("not_ssh"));
    client.on("close", () => finish("not_ssh"));
    client.connect({
      ...(sock ? { sock } : { host: target.host }),
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

/** Only fixed error codes cross the SSH boundary. */
export class SshFailure extends Error {
  constructor(
    readonly code:
      | "host_key_mismatch"
      | "outbound_refused"
      | "unreachable"
      | "timeout"
      | "auth_failed"
      | "connection_lost"
      | "pty_refused"
      | "agent_unavailable",
    readonly presented: string | null = null,
    readonly hop: "jump" | "target" = "target",
  ) {
    super(code);
    this.name = "SshFailure";
  }
}

interface SshLogin {
  host: string;
  port: number;
  username: string;
  password?: Buffer;
  privateKey?: Buffer;
  passphrase?: Buffer;
  agentSocket?: string;
  agent?: boolean;
  agentForwarding?: boolean;
  hostKeyFingerprint: string;
  readyTimeoutMs: number;
  jump?: Omit<SshLogin, "jump">;
  onPhase?: (phase: "jump_connecting" | "target_connecting" | "authenticating") => void;
}
interface SshExecOptions {
  pty?: boolean;
  /** The remote script emits this only after stty has disabled echo and line processing. */
  inputReady?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface SshSession {
  exec(
    command: string,
    stdin: Buffer,
    onOutput: (chunk: Buffer) => void,
    options?: SshExecOptions,
  ): Promise<number | null>;
  forward(host: string, port: number): Promise<ClientChannel>;
  close(): void;
}
export type SshConnect = (login: SshLogin, signal: AbortSignal) => Promise<SshSession>;

/** Both handshakes verify the pinned key before ssh2 starts user authentication. */
export const openSshSession: SshConnect = async (login, signal) => {
  const clients: InstanceType<typeof Client>[] = [];
  const tunnels: ClientChannel[] = [];
  const close = () => {
    for (const tunnel of tunnels) tunnel.destroy();
    for (const client of [...clients].reverse()) client.destroy();
  };
  const onAbort = () => close();
  signal.addEventListener("abort", onAbort, { once: true });
  const connect = (config: SshLogin, hop: "jump" | "target", sock?: ClientChannel) =>
    new Promise<InstanceType<typeof Client>>((resolve, reject) => {
      if (signal.aborted) return reject(new SshFailure("connection_lost", null, hop));
      login.onPhase?.(hop === "jump" ? "jump_connecting" : "target_connecting");
      const client = new Client();
      clients.push(client);
      let presented: string | null = null;
      let ready = false;
      const failure = (error?: SocketError) => {
        if (ready) return;
        let code: SshFailure["code"] = "connection_lost";
        if (presented !== null && presented !== config.hostKeyFingerprint)
          code = "host_key_mismatch";
        else if (error?.level === "client-authentication") code = "auth_failed";
        else if (error) {
          const reason = connectFailure(error);
          code = reason === "not_ssh" ? "unreachable" : reason;
        }
        reject(new SshFailure(code, code === "host_key_mismatch" ? presented : null, hop));
      };
      client.on("error", failure);
      client.once("close", () => failure());
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => config.password?.toString("utf8") ?? ""));
      });
      client.once("ready", () => {
        ready = true;
        resolve(client);
      });
      const options: ConnectConfig = {
        ...(sock ? { sock } : { host: config.host, port: config.port }),
        username: config.username,
        readyTimeout: config.readyTimeoutMs,
        keepaliveInterval: 5000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer) => {
          presented = hostKeyFingerprint(key);
          if (presented === config.hostKeyFingerprint) login.onPhase?.("authenticating");
          return presented === config.hostKeyFingerprint;
        },
      };
      if (config.password) {
        options.password = config.password.toString("utf8");
        options.tryKeyboard = true;
      }
      if (config.privateKey) {
        options.privateKey = config.privateKey;
        if (config.passphrase) options.passphrase = config.passphrase.toString("utf8");
      }
      if (config.agent || config.agentForwarding) {
        if (!config.agentSocket) return reject(new SshFailure("agent_unavailable", null, hop));
        options.agent = config.agentSocket;
        options.agentForward = config.agentForwarding === true;
        // Forwarding alone must not add agent keys to the login methods.
        if (!config.agent)
          options.authHandler = [
            "none",
            ...(config.privateKey ? ["publickey" as const] : []),
            ...(config.password ? ["password" as const, "keyboard-interactive" as const] : []),
          ];
      }
      try {
        client.connect(options);
      } catch {
        failure();
      }
    });
  try {
    let sock: ClientChannel | undefined;
    if (login.jump) {
      const jump = await connect(login.jump, "jump");
      sock = await forward(jump, login.host, login.port);
      tunnels.push(sock);
      if (signal.aborted) throw new SshFailure("connection_lost");
    }
    const client = await connect(login, "target", sock);
    if (signal.aborted) throw new SshFailure("connection_lost");
    return session(client, close);
  } catch (error) {
    close();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

function forward(
  client: InstanceType<typeof Client>,
  host: string,
  port: number,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const lost = () => reject(new SshFailure("connection_lost", null, "jump"));
    client.once("close", lost);
    client.forwardOut("127.0.0.1", 0, host, port, (error, channel) => {
      client.removeListener("close", lost);
      if (error) reject(new SshFailure("unreachable", null, "target"));
      else resolve(channel);
    });
  });
}

function session(client: InstanceType<typeof Client>, close: () => void): SshSession {
  client.on("error", () => {});
  return {
    exec: (command, stdin, onOutput, options = {}) =>
      new Promise((resolve, reject) => {
        let channel: ClientChannel | undefined;
        let code: number | null = null;
        let finished = false;
        let sent = !options.pty;
        let pending = "";
        const decoder = new StringDecoder("utf8");
        const finish = (error?: SshFailure) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          client.removeListener("close", lost);
          options.signal?.removeEventListener("abort", aborted);
          if (error) {
            channel?.destroy();
            reject(error);
          } else resolve(code);
        };
        const lost = () => finish();
        const aborted = () => finish(new SshFailure("connection_lost"));
        const timer = setTimeout(
          () => finish(new SshFailure("timeout")),
          options.timeoutMs ?? 65 * 60_000,
        );
        client.once("close", lost);
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) return aborted();
        const receive = (chunk: Buffer) => {
          if (!sent) {
            pending += stripVTControlCharacters(decoder.write(chunk)).replace(/\r/g, "");
            if (pending.split("\n").includes(options.inputReady ?? "")) {
              sent = true;
              pending = "";
              channel?.write(stdin);
            } else if (pending.length > 16_384) finish(new SshFailure("pty_refused"));
            return;
          }
          onOutput(chunk);
        };
        client.exec(
          command,
          options.pty
            ? { pty: { term: "dumb", modes: { ECHO: 0, ECHONL: 0, ICANON: 0, ISIG: 0 } } }
            : {},
          (error, stream) => {
            if (finished) {
              stream?.destroy();
              return;
            }
            if (error)
              return finish(new SshFailure(options.pty ? "pty_refused" : "connection_lost"));
            channel = stream;
            stream.on("error", () => finish());
            stream.on("data", receive);
            stream.stderr.on("data", receive);
            stream.on("exit", (status: number | null) => {
              code = typeof status === "number" ? status : null;
            });
            stream.once("close", () => finish());
            if (!options.pty) stream.end(stdin);
          },
        );
      }),
    forward: (host, port) => forward(client, host, port),
    close,
  };
}

/** No implicit SSH_AUTH_SOCK: only the Core administrator can choose this socket. */
export async function sshAgentStatus(configured: string | undefined): Promise<{
  available: boolean;
  reason: "not_configured" | "unavailable" | null;
  socket?: string;
}> {
  if (!configured) return { available: false, reason: "not_configured" };
  try {
    if (!isAbsolute(configured)) throw new Error("invalid agent");
    const socket = await realpath(configured);
    const stat = await lstat(socket);
    if (
      !stat.isSocket() ||
      (stat.uid !== process.getuid?.() && stat.uid !== 0) ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error("invalid agent");
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection(socket);
      const protocol = new ssh2.AgentProtocol(true);
      const timer = setTimeout(() => done(false), 2000);
      let ended = false;
      const done = (ok: boolean) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        connection.destroy();
        protocol.destroy();
        if (ok) resolve();
        else reject(new Error("agent unavailable"));
      };
      connection.on("error", () => done(false));
      protocol.on("error", () => done(false));
      connection.once("connect", () => {
        connection.pipe(protocol).pipe(connection);
        protocol.getIdentities((error, keys) => done(!error && !!keys?.length));
      });
    });
    return { available: true, reason: null, socket };
  } catch {
    return { available: false, reason: "unavailable" };
  }
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
