import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import {
  type HostKeyScan,
  type retrySshInstallInput,
  SSH_INSTALL_LIMITS,
  SSH_INSTALL_STEPS,
  type SshCredential,
  type SshInstallError,
  type SshInstallHost,
  type SshInstallOptions,
  type SshInstallRun,
  type SshInstallStep,
  type SshJumpHost,
  type startSshInstallInput,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { ClientChannel } from "ssh2";
import type * as z from "zod";
import { fail } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { OutboundRefusedError } from "../lib/outbound";
import {
  checkPrivateKey,
  openSshSession,
  type SshConnect,
  SshFailure,
  type SshSession,
  scanHostKey,
  sshAgentStatus,
} from "../lib/ssh";
import {
  buildCleanupCommand,
  buildPreflightCommand,
  buildRemoteCommand,
  inputMarker,
} from "../lib/ssh-install-command";

export { buildRemoteCommand, REMOTE_SCRIPT } from "../lib/ssh-install-command";

import { type Actor, recordAudit } from "./audit";
import {
  createEnrollmentToken,
  enrollmentTokenUse,
  expireUnusedEnrollmentToken,
} from "./enrollment";
import { findNodeGroup } from "./node-groups";

/**
 * One-shot SSH install runs (ADR-0066). Everything lives in this process:
 * the runs, their per-host state and output, and the credential, which is
 * dropped (its buffers zeroed) as soon as the run ends. Nothing about a run
 * but its audit entries reaches the database; a restart forgets it.
 */

type StartInput = z.output<typeof startSshInstallInput>;
type RetryInput = z.output<typeof retrySshInstallInput>;

/** What a run needs to mint tokens and build the install command. */
export interface InstallContext {
  db: Database;
  log: Logger;
  actor: Actor;
  consoleUrl: string;
  serverUrl: string;
  caSha256: string;
  /**
   * The address to connect to: resolved once, refused (OutboundRefusedError) when it is a
   * special-purpose address EDGEWEIR_OUTBOUND_ALLOW_CIDRS does not allow.
   */
  resolve: Resolve;
}

export type Resolve = (host: string) => Promise<string>;

/** Pins the host's address, or fails the way the scan and the install name it. */
async function pin(
  resolve: Resolve,
  host: string,
  signal?: AbortSignal,
  hop: "jump" | "target" = "target",
): Promise<string> {
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw signal.reason;
    return await Promise.race([
      resolve(host),
      ...(signal
        ? [
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new SshFailure(
      error instanceof OutboundRefusedError ? "outbound_refused" : "unreachable",
      null,
      hop,
    );
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The credential as the run keeps it: buffers, zeroed when the run ends. */
interface Secrets {
  username: string;
  password?: Buffer;
  privateKey?: Buffer;
  passphrase?: Buffer;
  sudoPassword?: Buffer;
  agent: boolean;
  agentForwarding: boolean;
}

interface HostState extends Omit<SshInstallHost, "output" | "step" | "completedSteps"> {
  output: OutputTail;
  /** The current attempt's token, kept only while it runs (to scrub the output). */
  token: string | null;
  abort: AbortController | null;
  /** The host's line named its user; otherwise it follows the credential's. */
  ownUsername: boolean;
}

interface RunState {
  id: string;
  clusterId: string;
  clusterName: string;
  nodeGroupId: string | null;
  options: SshInstallOptions;
  concurrency: number;
  timeoutMinutes: number;
  createdAt: Date;
  finishedAt: Date | null;
  state: SshInstallRun["state"];
  canceled: boolean;
  hosts: HostState[];
  secrets: Secrets | null;
  jumpSecrets: Secrets | null;
  jumpHost: SshInstallRun["jumpHost"];
  tty: SshInstallRun["tty"];
  agentSocket?: string;
  work?: Promise<void>;
  abort: AbortController;
  ctx: InstallContext;
}

const REDACTED = "[redacted]";
const TOKEN_RE = /ewt_[A-Za-z0-9_-]+/g;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** Removes every secret, any enrollment token and any private key block from `text`. */
export function scrubOutput(text: string, secrets: readonly string[]): string {
  let out = text;
  const variants = secrets.flatMap((secret) => [secret, stripVTControlCharacters(secret)]);
  for (const secret of variants.sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out.replace(PRIVATE_KEY_RE, REDACTED).replace(TOKEN_RE, REDACTED);
}

/**
 * One EDGEWEIR_RESULT line of install.sh (or edgeweir-node enroll): only the
 * fields the run reads, each checked, so nothing else of the line is kept.
 */
export interface InstallResult {
  step: string;
  status: string;
  exit: number | null;
  failedStep: string | null;
  nodeId: string | null;
}

const RESULT_PREFIX = "EDGEWEIR_RESULT ";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD_RE = /^[a-z_]{1,32}$/;

/** The result a line carries, null for any other line. */
export function parseResultLine(line: string): InstallResult | null {
  if (!line.startsWith(RESULT_PREFIX) || line.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const word = (x: unknown) => (typeof x === "string" && WORD_RE.test(x) ? x : null);
  const step = word(v.step);
  const status = word(v.status);
  if (v.v !== 1 || !step || !status) return null;
  return {
    step,
    status,
    exit: Number.isInteger(v.exit) ? (v.exit as number) : null,
    failedStep: word(v.failed_step),
    nodeId: typeof v.node_id === "string" && UUID_RE.test(v.node_id) ? v.node_id : null,
  };
}

/** The node with this id and its cluster, if it still exists. */
async function nodeCluster(db: Database, id: string) {
  const [row] = await db
    .select({ id: schema.node.id, clusterId: schema.node.clusterId })
    .from(schema.node)
    .where(eq(schema.node.id, id));
  return row ?? null;
}

const isStep = (step: string | null): step is SshInstallStep =>
  (SSH_INSTALL_STEPS as readonly string[]).includes(step ?? "");

/**
 * The step a host is in from its results: the one that failed, else the one
 * after the last that passed (null: none reported yet, or all passed).
 */
export function currentStep(results: readonly InstallResult[]): SshInstallStep | null {
  let next = -1;
  for (const r of results) {
    if (r.step === "done") {
      if (r.status === "failed" && isStep(r.failedStep)) return r.failedStep;
      if (r.status === "ok") return null;
      continue;
    }
    if (!isStep(r.step)) continue;
    if (r.status === "failed") return r.step;
    next = Math.max(next, SSH_INSTALL_STEPS.indexOf(r.step) + 1);
  }
  return next < 0 ? null : (SSH_INSTALL_STEPS[next] ?? null);
}

/** The last enroll result (edgeweir-node's own since 1.7.0, else install.sh's). */
const enrollResult = (results: readonly InstallResult[]) =>
  results.findLast((r) => r.step === "enroll");

/**
 * Why install.sh failed: from its exit code (one per step, since its result
 * lines) and, for the enroll step, edgeweir-node's status; else from its output.
 */
export function classifyExit(
  exitCode: number,
  results: readonly InstallResult[],
  output: string,
): SshInstallError {
  // Without install.sh's last line the code is sudo's or the shell's.
  if (!results.some((r) => r.step === "done")) return classifyFailure(exitCode, output);
  switch (exitCode) {
    case 21:
      return "system_unsupported";
    case 22:
      return "console_unreachable";
    case 23:
      return "download_failed";
    case 24:
      return "verify_failed";
    case 26:
      switch (enrollResult(results)?.status) {
        case "token_rejected":
          return "token_rejected";
        case "enrolled_elsewhere":
          return "enrolled_elsewhere";
        case "unreachable":
        case "ca_mismatch":
          return "console_unreachable";
        case "busy":
          return "install_busy";
        default:
          return "install_failed";
      }
    case 27:
      return "start_failed";
    case 28:
      return "health_failed";
    case 29:
      return "install_busy";
    default:
      return "install_failed";
  }
}

/**
 * The last lines of a host's output. Raw until the attempt ends (scrubbed
 * on every read), then scrubbed once with that attempt's secrets and kept
 * only so. Whole lines are dropped from the front, so a secret is never cut
 * in half by the bound.
 */
class OutputTail {
  private lines: string[] = [];
  private partial = "";
  private sealed = false;
  private decoder = new StringDecoder("utf8");
  private discarding = false;
  cleanup: SshInstallHost["cleanup"] = "not_needed";
  phase: "downloading" | "installing" | null = null;
  /** install.sh's result lines of this attempt (kept out of the output shown). */
  results: InstallResult[] = [];

  push(chunk: Buffer) {
    if (this.sealed) return;
    const parts = (this.partial + this.decoder.write(chunk)).split(/\r\n?|\n/);
    this.partial = parts.pop() ?? "";
    for (const raw of parts) {
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (raw.length > SSH_INSTALL_LIMITS.outputBytes) continue;
      const line = stripVTControlCharacters(raw);
      if (line === "EDGEWEIR_PHASE downloading" || line === "EDGEWEIR_PHASE installing") {
        this.phase = line === "EDGEWEIR_PHASE downloading" ? "downloading" : "installing";
        continue;
      }
      if (line === "EDGEWEIR_TASK_STARTED") {
        this.cleanup = "pending";
        continue;
      }
      if (line.startsWith("EDGEWEIR_CLEANUP ")) {
        this.cleanup = line === "EDGEWEIR_CLEANUP stopped" ? "stopped" : "unknown";
        continue;
      }
      const result = parseResultLine(line);
      if (result) {
        if (this.results.length < 64) this.results.push(result);
      } else this.lines.push(line.slice(-SSH_INSTALL_LIMITS.outputBytes));
    }
    if (this.partial.length > SSH_INSTALL_LIMITS.outputBytes) {
      this.partial = "";
      this.discarding = true;
    }
    this.trim();
  }

  private trim() {
    let bytes = this.lines.reduce((sum, line) => sum + line.length + 1, this.partial.length);
    while (
      this.lines.length > 0 &&
      (this.lines.length > SSH_INSTALL_LIMITS.outputLines || bytes > SSH_INSTALL_LIMITS.outputBytes)
    ) {
      bytes -= (this.lines.shift() ?? "").length + 1;
    }
  }

  text(secrets: readonly string[]) {
    const raw = stripVTControlCharacters(
      [...this.lines, ...(this.partial && !this.discarding ? [this.partial] : [])].join("\n"),
    );
    return this.sealed ? raw : scrubOutput(raw, secrets);
  }

  /** Scrubs what is kept for good; later output is ignored. */
  seal(secrets: readonly string[]) {
    const text = this.text(secrets);
    this.lines = text ? text.split("\n") : [];
    this.partial = "";
    this.sealed = true;
  }

  reset() {
    this.lines = [];
    this.partial = "";
    this.sealed = false;
    this.results = [];
    this.cleanup = "not_needed";
    this.phase = null;
    this.decoder = new StringDecoder("utf8");
    this.discarding = false;
  }
}

function toSecrets(credential: SshCredential): Secrets {
  const buffer = (value: string | undefined) =>
    value === undefined ? undefined : Buffer.from(value, "utf8");
  return {
    username: credential.username,
    agent: credential.agent,
    agentForwarding: credential.agentForwarding,
    password: buffer(credential.password),
    privateKey: buffer(credential.privateKey),
    passphrase: buffer(credential.passphrase),
    sudoPassword: buffer(credential.sudoPassword),
  };
}

function wipe(secrets: Secrets | null) {
  if (!secrets) return;
  for (const value of [
    secrets.password,
    secrets.privateKey,
    secrets.passphrase,
    secrets.sudoPassword,
  ]) {
    value?.fill(0);
  }
}

function secretStrings(secrets: Secrets | null, token: string | null): string[] {
  const values = [secrets?.password, secrets?.passphrase, secrets?.sudoPassword].flatMap((value) =>
    value ? [value.toString("utf8")] : [],
  );
  return token ? [...values, token] : values;
}

/** Refuses a private key that does not parse, before anything connects. */
function checkCredential(credential: SshCredential) {
  if (credential.privateKey === undefined) return;
  const result = checkPrivateKey(
    Buffer.from(credential.privateKey, "utf8"),
    credential.passphrase === undefined ? undefined : Buffer.from(credential.passphrase, "utf8"),
  );
  if (result === "invalid") fail("SSH_PRIVATE_KEY_INVALID", "the private key cannot be read");
  if (result === "passphrase")
    fail("SSH_PRIVATE_KEY_PASSPHRASE", "the private key needs its passphrase, or it is wrong");
}

/** Why install.sh (or sudo before it) failed, from its exit status and output. */
export function classifyFailure(exitCode: number, output: string): SshInstallError {
  if (exitCode === 94) return "pty_refused";
  if (exitCode === 95) return "system_unsupported";
  if (exitCode === 91) return "download_failed";
  if (/^sudo: (?:a password is required|a terminal is required)/m.test(output))
    return "sudo_password_required";
  if (/incorrect password attempt|^Sorry, try again|no password was provided/m.test(output))
    return "sudo_password_wrong";
  if (/must have a tty to run sudo/.test(output)) return "sudo_requires_tty";
  if (
    /is not in the sudoers file|not allowed to (?:execute|preserve)|^sh: \d*:? ?sudo: not found|sudo: command not found/m.test(
      output,
    )
  )
    return "sudo_not_allowed";
  return "install_failed";
}

/** Runs `task` over `items` with at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

const SCAN_TIMEOUT_MS = 10_000;
const SCAN_CONCURRENCY = 20;

export class SshInstallRuns {
  private runs = new Map<string, RunState>();
  private readonly connect: SshConnect;
  private readonly scan: typeof scanHostKey;
  private readonly now: () => Date;
  /** Milliseconds per timeout minute (tests shorten it). */
  private readonly minuteMs: number;
  private readonly agentSocket: string | undefined;

  constructor(
    deps: {
      connect?: SshConnect;
      scan?: typeof scanHostKey;
      now?: () => Date;
      minuteMs?: number;
      agentSocket?: string;
    } = {},
  ) {
    this.connect = deps.connect ?? openSshSession;
    this.scan = deps.scan ?? scanHostKey;
    this.now = deps.now ?? (() => new Date());
    this.minuteMs = deps.minuteMs ?? 60_000;
    this.agentSocket = deps.agentSocket;
  }

  async capabilities() {
    const { available, reason } = await sshAgentStatus(this.agentSocket);
    return { version: 2 as const, agent: { available, reason } };
  }

  private async agentFor(...credentials: (SshCredential | undefined)[]) {
    if (!credentials.some((c) => c?.agent || c?.agentForwarding)) return undefined;
    const status = await sshAgentStatus(this.agentSocket);
    if (!status.available) fail("SSH_AGENT_UNAVAILABLE", "the Core SSH agent is unavailable");
    return status.socket;
  }

  /** DNS is always resolved and pinned in Core, including forwardOut's destination. */
  async scanHostKeys(
    hosts: { host: string; port: number }[],
    resolve: Resolve,
    jumpHost?: SshJumpHost,
  ): Promise<HostKeyScan[]> {
    const results: HostKeyScan[] = new Array(hosts.length);
    if (jumpHost) checkCredential(jumpHost.credential);
    const agentSocket = await this.agentFor(jumpHost?.credential);
    const secrets = jumpHost ? toSecrets(jumpHost.credential) : null;
    try {
      await pool(
        hosts.map((host, index) => ({ host, index })),
        SCAN_CONCURRENCY,
        async ({ host, index }) => {
          const abort = new AbortController();
          let session: SshSession | null = null;
          const timer = setTimeout(() => {
            abort.abort();
            session?.close();
          }, SCAN_TIMEOUT_MS);
          let hop: "jump" | "target" = "target";
          try {
            const address = await pin(resolve, host.host, abort.signal);
            let tunnel: ClientChannel | undefined;
            if (jumpHost && secrets) {
              hop = "jump";
              const jumpAddress = await pin(resolve, jumpHost.host, abort.signal, "jump");
              session = await this.connect(
                {
                  ...secrets,
                  host: jumpAddress,
                  port: jumpHost.port,
                  hostKeyFingerprint: jumpHost.hostKeyFingerprint,
                  readyTimeoutMs: SCAN_TIMEOUT_MS,
                  agentSocket,
                },
                abort.signal,
              );
              hop = "target";
              tunnel = await session.forward(address, host.port);
            }
            const scanned = await this.scan(
              { host: address, port: host.port },
              SCAN_TIMEOUT_MS,
              tunnel,
              abort.signal,
            );
            const timedOut = abort.signal.aborted && !scanned.fingerprint;
            results[index] = {
              ...scanned,
              host: host.host,
              error: timedOut ? "timeout" : scanned.error,
              errorHop: timedOut || scanned.error ? hop : null,
            };
          } catch (error) {
            results[index] = {
              host: host.host,
              port: host.port,
              algorithm: null,
              fingerprint: null,
              error: abort.signal.aborted
                ? "timeout"
                : error instanceof SshFailure && error.code !== "pty_refused"
                  ? error.code
                  : "unreachable",
              errorHop:
                error instanceof SshFailure && error.code === "host_key_mismatch" ? "jump" : hop,
              presentedFingerprint: error instanceof SshFailure ? error.presented : null,
            };
          } finally {
            clearTimeout(timer);
            session?.close();
          }
        },
      );
    } finally {
      wipe(secrets);
    }
    return results;
  }

  async start(input: StartInput, ctx: InstallContext): Promise<SshInstallRun> {
    this.prune();
    const seen = new Set<string>();
    for (const host of input.hosts) {
      const key = `${host.host}:${host.port}`;
      if (seen.has(key))
        fail("SSH_INSTALL_DUPLICATE_HOST", `${key} is listed twice`, { host: key });
      seen.add(key);
    }
    const active = [...this.runs.values()].filter((run) => run.state === "running").length;
    if (active >= SSH_INSTALL_LIMITS.activeRuns)
      fail("SSH_INSTALL_TOO_MANY_RUNS", "too many SSH installs are running", {
        limit: SSH_INSTALL_LIMITS.activeRuns,
      });
    checkCredential(input.credential);
    if (input.jumpHost) checkCredential(input.jumpHost.credential);
    const agentSocket = await this.agentFor(input.credential, input.jumpHost?.credential);
    const [cluster] = await ctx.db
      .select({ id: schema.cluster.id, name: schema.cluster.name })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, input.clusterId));
    if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
    if (input.nodeGroupId) {
      const group = await findNodeGroup(ctx.db, input.nodeGroupId);
      if (group.clusterId !== input.clusterId)
        fail("NODE_GROUP_CLUSTER_MISMATCH", "the node group belongs to another cluster");
    }
    if (
      [...this.runs.values()].filter((run) => run.state === "running").length >=
      SSH_INSTALL_LIMITS.activeRuns
    )
      fail("SSH_INSTALL_TOO_MANY_RUNS", "too many SSH installs are running", {
        limit: SSH_INSTALL_LIMITS.activeRuns,
      });
    const run: RunState = {
      id: randomUUID(),
      clusterId: cluster.id,
      clusterName: cluster.name,
      nodeGroupId: input.nodeGroupId ?? null,
      options: input.options,
      concurrency: input.concurrency,
      timeoutMinutes: input.timeoutMinutes,
      createdAt: this.now(),
      finishedAt: null,
      state: "running",
      canceled: false,
      secrets: toSecrets(input.credential),
      jumpSecrets: input.jumpHost ? toSecrets(input.jumpHost.credential) : null,
      jumpHost: input.jumpHost
        ? {
            host: input.jumpHost.host,
            port: input.jumpHost.port,
            hostKeyFingerprint: input.jumpHost.hostKeyFingerprint,
          }
        : null,
      tty: input.tty,
      agentSocket,
      abort: new AbortController(),
      ctx,
      hosts: input.hosts.map((host, index) => ({
        id: String(index),
        host: host.host,
        port: host.port,
        username: host.username ?? input.credential.username,
        nodeName: host.nodeName,
        hostKeyFingerprint: host.hostKeyFingerprint,
        state: "queued",
        phase: "queued",
        cleanup: "not_needed",
        cancelRequested: false,
        errorHop: null,
        error: null,
        exitCode: null,
        presentedFingerprint: null,
        tokenId: null,
        nodeId: null,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        output: new OutputTail(),
        token: null,
        abort: null,
        ownUsername: host.username !== undefined,
      })),
    };
    this.runs.set(run.id, run);
    try {
      await recordAudit(ctx.db, ctx.actor, {
        action: "ssh_install.start",
        targetType: "cluster",
        targetId: run.clusterId,
        targetName: run.clusterName,
        metadata: {
          runId: run.id,
          hosts: run.hosts.length,
          concurrency: run.concurrency,
          timeoutMinutes: run.timeoutMinutes,
          options: run.options,
          tty: run.tty,
          jumpHost: run.jumpHost,
          agentLogin: input.credential.agent,
          agentForwarding: input.credential.agentForwarding,
        },
      });
    } catch (error) {
      this.runs.delete(run.id);
      wipe(run.secrets);
      wipe(run.jumpSecrets);
      run.secrets = null;
      run.jumpSecrets = null;
      throw error;
    }
    run.work = this.drive(run, run.hosts);
    return this.snapshot(run);
  }

  get(id: string): SshInstallRun {
    return this.snapshot(this.find(id));
  }

  async cancel(id: string, actor: Actor): Promise<SshInstallRun> {
    const run = this.find(id);
    if (run.state === "running" && !run.canceled) {
      run.canceled = true;
      for (const host of run.hosts) {
        if (["queued", "connecting", "installing"].includes(host.state))
          host.cancelRequested = true;
        if (host.state === "queued") this.end(host, "canceled", null);
      }
      run.abort.abort();
      await recordAudit(run.ctx.db, actor, {
        action: "ssh_install.cancel",
        targetType: "cluster",
        targetId: run.clusterId,
        targetName: run.clusterName,
        metadata: { runId: run.id },
      });
    }
    return this.snapshot(run);
  }

  async retry(input: RetryInput, ctx: InstallContext): Promise<SshInstallRun> {
    const run = this.find(input.id);
    if (run.state === "running") fail("SSH_INSTALL_BUSY", "the run has not ended yet");
    const wanted = input.hosts ? new Map(input.hosts.map((h) => [h.id, h])) : null;
    const hosts = run.hosts.filter(
      (host) =>
        (host.state === "failed" || host.state === "canceled") && (!wanted || wanted.has(host.id)),
    );
    if (hosts.length === 0) fail("SSH_INSTALL_NOTHING_TO_RETRY", "no failed host to retry");
    const active = [...this.runs.values()].filter((r) => r.state === "running").length;
    if (active >= SSH_INSTALL_LIMITS.activeRuns)
      fail("SSH_INSTALL_TOO_MANY_RUNS", "too many SSH installs are running", {
        limit: SSH_INSTALL_LIMITS.activeRuns,
      });
    checkCredential(input.credential);
    if (!!run.jumpHost !== !!input.jumpHost)
      fail("SSH_JUMP_REQUIRED", "retry must keep the original SSH connection path");
    if (input.jumpHost) {
      checkCredential(input.jumpHost.credential);
      if (
        run.jumpHost &&
        (run.jumpHost.host !== input.jumpHost.host || run.jumpHost.port !== input.jumpHost.port)
      )
        fail("SSH_JUMP_REQUIRED", "retry must use the same jump host");
    }
    const agentSocket = await this.agentFor(input.credential, input.jumpHost?.credential);
    if (this.find(input.id).state === "running")
      fail("SSH_INSTALL_BUSY", "the run has not ended yet");
    if (
      [...this.runs.values()].filter((run) => run.state === "running").length >=
      SSH_INSTALL_LIMITS.activeRuns
    )
      fail("SSH_INSTALL_TOO_MANY_RUNS", "too many SSH installs are running", {
        limit: SSH_INSTALL_LIMITS.activeRuns,
      });
    for (const host of hosts) {
      const fingerprint = wanted?.get(host.id)?.hostKeyFingerprint;
      if (fingerprint) host.hostKeyFingerprint = fingerprint;
      if (!host.ownUsername) host.username = input.credential.username;
      Object.assign(host, {
        state: "queued",
        phase: "queued",
        cleanup: "not_needed",
        cancelRequested: false,
        errorHop: null,
        error: null,
        exitCode: null,
        presentedFingerprint: null,
        tokenId: null,
        startedAt: null,
        finishedAt: null,
      } satisfies Partial<HostState>);
      host.output.reset();
    }
    run.state = "running";
    run.canceled = false;
    run.finishedAt = null;
    run.abort = new AbortController();
    run.secrets = toSecrets(input.credential);
    run.jumpSecrets = input.jumpHost ? toSecrets(input.jumpHost.credential) : null;
    run.jumpHost = input.jumpHost
      ? {
          host: input.jumpHost.host,
          port: input.jumpHost.port,
          hostKeyFingerprint: input.jumpHost.hostKeyFingerprint,
        }
      : null;
    run.tty = input.tty;
    run.agentSocket = agentSocket;
    run.ctx = ctx;
    try {
      await recordAudit(ctx.db, ctx.actor, {
        action: "ssh_install.start",
        targetType: "cluster",
        targetId: run.clusterId,
        targetName: run.clusterName,
        metadata: {
          runId: run.id,
          hosts: hosts.length,
          retry: true,
          tty: run.tty,
          jumpHost: run.jumpHost,
          agentLogin: input.credential.agent,
          agentForwarding: input.credential.agentForwarding,
        },
      });
    } catch (error) {
      wipe(run.secrets);
      wipe(run.jumpSecrets);
      run.secrets = null;
      run.jumpSecrets = null;
      run.state = "finished";
      run.finishedAt = this.now();
      for (const host of hosts) this.end(host, "failed", "console_error");
      throw error;
    }
    run.work = this.drive(run, hosts);
    return this.snapshot(run);
  }

  /** Cancels everything (console shutdown): no credential outlives the process's work. */
  async shutdown() {
    for (const run of this.runs.values()) {
      if (run.state !== "running") continue;
      run.canceled = true;
      for (const host of run.hosts)
        if (["queued", "connecting", "installing"].includes(host.state))
          host.cancelRequested = true;
      run.abort.abort();
    }
    await Promise.all([...this.runs.values()].map((run) => run.work));
  }

  private find(id: string): RunState {
    this.prune();
    const run = this.runs.get(id);
    if (!run) fail("SSH_INSTALL_NOT_FOUND", "SSH install run not found");
    return run;
  }

  /** Forgets finished runs after SSH_INSTALL_LIMITS.keepMinutes. */
  private prune() {
    const cutoff = this.now().getTime() - SSH_INSTALL_LIMITS.keepMinutes * 60_000;
    for (const [id, run] of this.runs) {
      if (run.finishedAt && run.finishedAt.getTime() < cutoff) this.runs.delete(id);
    }
  }

  private async drive(run: RunState, hosts: HostState[]) {
    try {
      await pool(hosts, run.concurrency, (host) => this.installHost(run, host));
    } catch (error) {
      run.ctx.log.error("ssh install run failed", {
        runId: run.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      for (const host of hosts) {
        if (host.state === "queued") this.end(host, "canceled", null);
      }
      run.state = run.canceled ? "canceled" : "finished";
      run.finishedAt = this.now();
      wipe(run.secrets);
      wipe(run.jumpSecrets);
      run.secrets = null;
      run.jumpSecrets = null;
      run.agentSocket = undefined;
    }
  }

  private end(host: HostState, state: SshInstallHost["state"], error: SshInstallError | null) {
    host.state = state;
    host.phase = "finished";
    host.error = error;
    host.finishedAt = this.now().toISOString();
    host.abort = null;
  }

  private async installHost(run: RunState, host: HostState) {
    if (run.canceled || host.state !== "queued") return;
    const secrets = run.secrets;
    if (!secrets) return;
    const { ctx } = run;
    host.state = "connecting";
    host.phase = run.jumpHost ? "jump_connecting" : "target_connecting";
    host.attempts += 1;
    host.startedAt = this.now().toISOString();
    const abort = new AbortController();
    host.abort = abort;
    const timeout = setTimeout(() => abort.abort("timeout"), run.timeoutMinutes * this.minuteMs);
    const onRunAbort = () => abort.abort("canceled");
    run.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    let session: SshSession | null = null;
    const closeOnAbort = () => {
      session?.close();
      session = null;
    };
    abort.signal.addEventListener("abort", closeOnAbort, { once: true });
    let outcome: { state: SshInstallHost["state"]; error: SshInstallError | null } = {
      state: "failed",
      error: "console_error",
    };
    // install.sh named the failed step: a late enrollment does not make it a success.
    const taskId = randomUUID();
    const sudo = secrets.sudoPassword ? "sudo-s" : "sudo-n";
    let pty = run.tty === "always";
    let submitted = false;
    const sudoInput = () =>
      Buffer.concat([...(secrets.sudoPassword ? [secrets.sudoPassword] : []), Buffer.from("\n")]);
    const execOptions = () => ({ pty, inputReady: inputMarker(taskId), signal: abort.signal });
    try {
      const minted = await createEnrollmentToken(
        ctx.db,
        {
          clusterId: run.clusterId,
          nodeGroupId: run.nodeGroupId ?? undefined,
          nodeName: host.nodeName,
          ttlMinutes: run.timeoutMinutes + 5,
        },
        {
          actor: ctx.actor,
          consoleUrl: ctx.consoleUrl,
          serverUrl: ctx.serverUrl,
          caSha256: ctx.caSha256,
        },
      );
      host.tokenId = minted.tokenId;
      host.token = minted.token;
      if (abort.signal.aborted) throw abort.signal.reason;
      const address = await pin(ctx.resolve, host.host, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      const jump =
        run.jumpHost && run.jumpSecrets
          ? {
              ...run.jumpSecrets,
              host: await pin(ctx.resolve, run.jumpHost.host, abort.signal, "jump"),
              port: run.jumpHost.port,
              hostKeyFingerprint: run.jumpHost.hostKeyFingerprint,
              readyTimeoutMs: Math.min(20_000, run.timeoutMinutes * this.minuteMs),
              agentSocket: run.agentSocket,
            }
          : undefined;
      session = await this.connect(
        {
          host: address,
          port: host.port,
          username: host.username,
          password: secrets.password,
          privateKey: secrets.privateKey,
          passphrase: secrets.passphrase,
          agent: secrets.agent,
          agentForwarding: secrets.agentForwarding,
          agentSocket: run.agentSocket,
          jump,
          onPhase: (phase) => {
            host.phase = phase;
          },
          hostKeyFingerprint: host.hostKeyFingerprint,
          readyTimeoutMs: Math.min(20_000, run.timeoutMinutes * this.minuteMs),
        },
        abort.signal,
      );
      if (abort.signal.aborted) throw abort.signal.reason;
      host.phase = "preparing";
      if (host.username !== "root") {
        const preflight = async () => {
          let output = "";
          const stdin = sudoInput();
          try {
            const code = await session!.exec(
              buildPreflightCommand(taskId, sudo),
              stdin,
              (chunk) => {
                output += chunk.toString("utf8");
              },
              { ...execOptions(), timeoutMs: 15_000 },
            );
            if (code === null) throw new SshFailure("connection_lost");
            return code === 0 ? null : classifyFailure(code, output);
          } finally {
            stdin.fill(0);
          }
        };
        let error = await preflight();
        if (error === "sudo_requires_tty" && run.tty === "auto" && !pty) {
          pty = true;
          error = await preflight();
        }
        if (error) throw new InstallPreflightFailure(error);
      }
      host.state = "installing";
      host.phase = "installing";
      const command = buildRemoteCommand({
        consoleUrl: ctx.consoleUrl,
        serverUrl: ctx.serverUrl,
        caSha256: ctx.caSha256,
        options: run.options,
        sudo,
        taskId,
        timeoutSeconds:
          (run.timeoutMinutes * this.minuteMs -
            (this.now().getTime() - new Date(host.startedAt!).getTime())) /
          1000,
      });
      const stdin = Buffer.concat([Buffer.from(`${minted.token}\n`, "utf8"), sudoInput()]);
      let exitCode: number | null;
      submitted = true;
      host.cleanup = "pending";
      try {
        exitCode = await session.exec(
          command,
          stdin,
          (chunk) => {
            if (host.finishedAt !== null) return;
            host.output.push(chunk);
            if (host.output.phase) host.phase = host.output.phase;
            if (host.output.cleanup !== "not_needed") host.cleanup = host.output.cleanup;
          },
          execOptions(),
        );
      } finally {
        stdin.fill(0);
      }
      host.exitCode = exitCode;
      if (abort.signal.aborted) throw abort.signal.reason;
      const results = host.output.results;
      if (exitCode === null) {
        outcome = { state: "failed", error: "connection_lost" };
      } else if (exitCode === 124) {
        outcome = { state: "failed", error: "timeout" };
      } else if (exitCode !== 0) {
        outcome = {
          state: "failed",
          error: classifyExit(
            exitCode,
            results,
            host.output.text(secretStrings(secrets, host.token)),
          ),
        };
        // Enrolled before a later step failed: the node is there (a retry confirms it).
        host.nodeId = (await enrollmentTokenUse(ctx.db, minted.tokenId)).usedByNodeId;
      } else {
        const use = await enrollmentTokenUse(ctx.db, minted.tokenId);
        // An enrolled host (a retry, or one installed before): edgeweir-node 1.7.0
        // confirmed the identity is this console's and named its node.
        const known = use.usedByNodeId ?? enrollResult(results)?.nodeId ?? null;
        const node = known ? await nodeCluster(ctx.db, known) : null;
        if (node) host.nodeId = node.id;
        if (node && node.clusterId === run.clusterId) outcome = { state: "succeeded", error: null };
        else if (node) outcome = { state: "failed", error: "enrolled_elsewhere" };
        else outcome = { state: "failed", error: "not_enrolled" };
      }
    } catch (error) {
      if (error instanceof InstallPreflightFailure)
        outcome = { state: "failed", error: error.code };
      else if (error === "canceled") outcome = { state: "canceled", error: null };
      else if (error === "timeout") outcome = { state: "failed", error: "timeout" };
      else if (error instanceof SshFailure) {
        outcome = { state: "failed", error: abort.signal.aborted ? reasonOf(abort) : error.code };
        if (outcome.error === null) outcome.state = "canceled";
        host.presentedFingerprint = error.presented;
        host.errorHop = outcome.error === null ? null : error.hop;
      } else {
        // Never the error itself in the output: it could quote input.
        ctx.log.error("ssh install host failed", {
          runId: run.id,
          host: host.host,
          error: error instanceof Error ? error.name : "unknown",
        });
        outcome = { state: "failed", error: "console_error" };
      }
    } finally {
      clearTimeout(timeout);
      run.abort.signal.removeEventListener("abort", onRunAbort);
      abort.signal.removeEventListener("abort", closeOnAbort);
      if (host.tokenId && (abort.signal.aborted || outcome.state !== "succeeded"))
        await expireUnusedEnrollmentToken(ctx.db, host.tokenId).catch(() =>
          ctx.log.error("ssh install token expiry failed", { runId: run.id }),
        );
      if (submitted && host.cleanup !== "stopped") {
        host.phase = "stopping";
        host.cleanup = "pending";
        let stopped = false;
        const cleanupAbort = new AbortController();
        const cleanupTimer = setTimeout(() => cleanupAbort.abort(), 15_000);
        const stdin = sudoInput();
        try {
          // Reconnect through the same pinned path only when the original transport has gone.
          const clean = async (live: SshSession) => {
            let output = "";
            await live.exec(
              buildCleanupCommand(taskId, sudo),
              stdin,
              (chunk) => {
                host.output.push(chunk);
                output = (output + chunk.toString("utf8")).slice(-1024);
              },
              {
                pty,
                inputReady: inputMarker(taskId),
                signal: cleanupAbort.signal,
                timeoutMs: 12_000,
              },
            );
            if (/^EDGEWEIR_CLEANUP stopped\r?$/m.test(output)) stopped = true;
          };
          if (session) {
            try {
              await clean(session);
            } catch {
              /* A broken transport requires a fresh handshake. */
            }
          }
          if (!stopped && !cleanupAbort.signal.aborted) {
            session?.close();
            const jump =
              run.jumpHost && run.jumpSecrets
                ? {
                    ...run.jumpSecrets,
                    agentForwarding: false,
                    host: await pin(ctx.resolve, run.jumpHost.host, cleanupAbort.signal, "jump"),
                    port: run.jumpHost.port,
                    hostKeyFingerprint: run.jumpHost.hostKeyFingerprint,
                    readyTimeoutMs: 3000,
                    agentSocket: run.agentSocket,
                  }
                : undefined;
            session = await this.connect(
              {
                ...secrets,
                agentForwarding: false,
                host: await pin(ctx.resolve, host.host, cleanupAbort.signal),
                port: host.port,
                username: host.username,
                hostKeyFingerprint: host.hostKeyFingerprint,
                readyTimeoutMs: 3000,
                agentSocket: run.agentSocket,
                jump,
              },
              cleanupAbort.signal,
            );
            await clean(session);
          }
        } catch {
          /* A deadline on the host remains active even when reconnection fails. */
        } finally {
          clearTimeout(cleanupTimer);
          stdin.fill(0);
          host.cleanup = stopped ? "stopped" : "unknown";
        }
      }
      session?.close();
    }
    try {
      if (host.tokenId) {
        // Unused (an enrolled host confirmed its node, or the attempt failed): ended now.
        const use = await expireUnusedEnrollmentToken(ctx.db, host.tokenId);
        // Registration is a fact, not evidence that download/install/start/health completed.
        if (use.usedByNodeId) host.nodeId = use.usedByNodeId;
        else {
          const reported = enrollResult(host.output.results)?.nodeId;
          const node = reported ? await nodeCluster(ctx.db, reported) : null;
          if (node?.clusterId === run.clusterId) host.nodeId = node.id;
        }
      }
    } finally {
      host.output.seal([
        ...secretStrings(secrets, host.token),
        ...secretStrings(run.jumpSecrets, null),
      ]);
      host.token = null;
      this.end(host, outcome.state, outcome.error);
    }
    await recordAudit(ctx.db, ctx.actor, {
      action: "ssh_install.host",
      targetType: "cluster",
      targetId: run.clusterId,
      targetName: run.clusterName,
      metadata: {
        runId: run.id,
        host: host.host,
        port: host.port,
        user: host.username,
        hostKeyFingerprint: host.hostKeyFingerprint,
        outcome: outcome.state,
        error: outcome.error,
        exitCode: host.exitCode,
        nodeId: host.nodeId,
        cleanup: host.cleanup,
        cancelRequested: host.cancelRequested,
        errorHop: host.errorHop,
        tokenId: host.tokenId,
      },
    }).catch((error: unknown) =>
      ctx.log.error("ssh install audit failed", {
        runId: run.id,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  private snapshot(run: RunState): SshInstallRun {
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
    const hosts = run.hosts.map((host): SshInstallHost => {
      if (host.state === "connecting" || host.state === "installing") counts.running++;
      else counts[host.state]++;
      const { output, token, abort: _abort, ownUsername: _own, ...rest } = host;
      return {
        ...rest,
        step: host.state === "succeeded" ? null : currentStep(output.results),
        completedSteps: [
          ...new Set(
            output.results
              .filter(
                (r) =>
                  isStep(r.step) &&
                  (r.status === "ok" ||
                    (r.step === "enroll" &&
                      (r.status === "enrolled" || r.status === "already_enrolled") &&
                      (r.exit === null || r.exit === 0))),
              )
              .map((r) => r.step as SshInstallStep),
          ),
        ],
        output: output.text([
          ...secretStrings(run.secrets, token),
          ...secretStrings(run.jumpSecrets, null),
        ]),
      };
    });
    return {
      id: run.id,
      clusterId: run.clusterId,
      nodeGroupId: run.nodeGroupId,
      state: run.state,
      concurrency: run.concurrency,
      timeoutMinutes: run.timeoutMinutes,
      tty: run.tty,
      jumpHost: run.jumpHost,
      options: run.options,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      expiresAt: run.finishedAt
        ? new Date(run.finishedAt.getTime() + SSH_INSTALL_LIMITS.keepMinutes * 60_000).toISOString()
        : null,
      counts,
      hosts,
    };
  }
}

class InstallPreflightFailure extends Error {
  constructor(readonly code: SshInstallError) {
    super(code);
  }
}

function reasonOf(abort: AbortController): SshInstallError | null {
  return abort.signal.reason === "timeout" ? "timeout" : null;
}
