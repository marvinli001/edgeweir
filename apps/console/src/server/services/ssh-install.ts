import { randomUUID } from "node:crypto";
import {
  type HostKeyScan,
  type retrySshInstallInput,
  SSH_INSTALL_LIMITS,
  type SshCredential,
  type SshInstallError,
  type SshInstallHost,
  type SshInstallOptions,
  type SshInstallRun,
  type startSshInstallInput,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type * as z from "zod";
import { fail } from "../lib/errors";
import type { Logger } from "../lib/logger";
import {
  checkPrivateKey,
  openSshSession,
  type SshConnect,
  SshFailure,
  type SshSession,
  scanHostKey,
} from "../lib/ssh";
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
}

/** The credential as the run keeps it: buffers, zeroed when the run ends. */
interface Secrets {
  username: string;
  password?: Buffer;
  privateKey?: Buffer;
  passphrase?: Buffer;
  sudoPassword?: Buffer;
}

interface HostState extends Omit<SshInstallHost, "output"> {
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
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out.replace(PRIVATE_KEY_RE, REDACTED).replace(TOKEN_RE, REDACTED);
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

  push(chunk: Buffer) {
    if (this.sealed) return;
    const parts = (this.partial + chunk.toString("utf8")).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    // A line longer than the whole bound keeps its end.
    if (this.partial.length > SSH_INSTALL_LIMITS.outputBytes) this.partial = "";
    this.lines.push(...parts.map((line) => line.slice(-SSH_INSTALL_LIMITS.outputBytes)));
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
    const raw = [...this.lines, ...(this.partial ? [this.partial] : [])].join("\n");
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
  }
}

function toSecrets(credential: SshCredential): Secrets {
  const buffer = (value: string | undefined) =>
    value === undefined ? undefined : Buffer.from(value, "utf8");
  return {
    username: credential.username,
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

/** Shell-quotes a value (POSIX single quotes). */
function sh(value: string): string {
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The fixed script the login shell runs (as `sh -c SCRIPT URL MODE ARGS…`).
 * stdin line 1 is the token, line 2 the sudo password (sudo -S only).
 * install.sh is fetched as the user and run as root with stdin from
 * /dev/null, so a sudo password sudo did not read stays unread. Exit 90: no
 * token on stdin, 91: download failed, 92: no temporary directory.
 */
export const REMOTE_SCRIPT = [
  "LC_ALL=C; export LC_ALL",
  "url=$0; mode=$1; shift",
  "IFS= read -r EDGEWEIR_TOKEN || exit 90",
  "export EDGEWEIR_TOKEN",
  "d=$(mktemp -d) || exit 92",
  "trap 'rm -rf \"$d\"' EXIT",
  'curl -fsSL -o "$d/install.sh" "$url" || exit 91',
  'if [ "$(id -u)" = 0 ]; then bash "$d/install.sh" "$@" </dev/null',
  `elif [ "$mode" = sudo-s ]; then sudo -S -p '' --preserve-env=EDGEWEIR_TOKEN sh -c 'exec bash "$0" "$@" </dev/null' "$d/install.sh" "$@"`,
  'else sudo -n --preserve-env=EDGEWEIR_TOKEN bash "$d/install.sh" "$@" </dev/null',
  "fi",
].join("\n");

/** The command line: only the script, URLs and options; never the token or a password. */
export function buildRemoteCommand(opts: {
  consoleUrl: string;
  serverUrl: string;
  caSha256: string;
  options: SshInstallOptions;
  sudo: "sudo-s" | "sudo-n";
}): string {
  const { options } = opts;
  const args = ["--server", opts.serverUrl, "--ca-sha256", opts.caSha256];
  if (options.version) args.push("--version", options.version);
  if (options.format !== "auto") args.push("--format", options.format);
  if (options.mirror) args.push("--mirror", options.mirror);
  if (options.mirrorOnly) args.push("--mirror-only");
  if (!options.modsecurity) args.push("--no-modsecurity");
  if (options.noStart) args.push("--no-start");
  const url = `${opts.consoleUrl.replace(/\/$/, "")}/install.sh`;
  return ["sh", "-c", REMOTE_SCRIPT, url, opts.sudo, ...args].map(sh).join(" ");
}

/** Why install.sh (or sudo before it) failed, from its exit status and output. */
export function classifyFailure(exitCode: number, output: string): SshInstallError {
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const SCAN_TIMEOUT_MS = 10_000;
const SCAN_CONCURRENCY = 20;

export class SshInstallRuns {
  private runs = new Map<string, RunState>();
  private readonly connect: SshConnect;
  private readonly scan: typeof scanHostKey;
  private readonly now: () => Date;

  constructor(deps: { connect?: SshConnect; scan?: typeof scanHostKey; now?: () => Date } = {}) {
    this.connect = deps.connect ?? openSshSession;
    this.scan = deps.scan ?? scanHostKey;
    this.now = deps.now ?? (() => new Date());
  }

  /** The host key each host presents; nothing is sent but the SSH handshake. */
  async scanHostKeys(hosts: { host: string; port: number }[]): Promise<HostKeyScan[]> {
    const results: HostKeyScan[] = new Array(hosts.length);
    await pool(
      hosts.map((host, index) => ({ host, index })),
      SCAN_CONCURRENCY,
      async ({ host, index }) => {
        results[index] = await this.scan(host, SCAN_TIMEOUT_MS);
      },
    );
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
      },
    });
    void this.drive(run, run.hosts);
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
    for (const host of hosts) {
      const fingerprint = wanted?.get(host.id)?.hostKeyFingerprint;
      if (fingerprint) host.hostKeyFingerprint = fingerprint;
      if (!host.ownUsername) host.username = input.credential.username;
      Object.assign(host, {
        state: "queued",
        error: null,
        exitCode: null,
        presentedFingerprint: null,
        tokenId: null,
        nodeId: null,
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
    run.ctx = ctx;
    await recordAudit(ctx.db, ctx.actor, {
      action: "ssh_install.start",
      targetType: "cluster",
      targetId: run.clusterId,
      targetName: run.clusterName,
      metadata: { runId: run.id, hosts: hosts.length, retry: true },
    });
    void this.drive(run, hosts);
    return this.snapshot(run);
  }

  /** Cancels everything (console shutdown): no credential outlives the process's work. */
  shutdown() {
    for (const run of this.runs.values()) {
      run.canceled = true;
      run.abort.abort();
      wipe(run.secrets);
      run.secrets = null;
    }
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
      run.ctx.log.error("ssh install run failed", { runId: run.id, error: String(error) });
    } finally {
      for (const host of hosts) {
        if (host.state === "queued") this.end(host, "canceled", null);
      }
      run.state = run.canceled ? "canceled" : "finished";
      run.finishedAt = this.now();
      wipe(run.secrets);
      run.secrets = null;
    }
  }

  private end(host: HostState, state: SshInstallHost["state"], error: SshInstallError | null) {
    host.state = state;
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
    host.attempts += 1;
    host.startedAt = this.now().toISOString();
    const abort = new AbortController();
    host.abort = abort;
    const timeout = setTimeout(() => abort.abort("timeout"), run.timeoutMinutes * 60_000);
    const onRunAbort = () => abort.abort("canceled");
    run.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    let session: SshSession | null = null;
    let outcome: { state: SshInstallHost["state"]; error: SshInstallError | null } = {
      state: "failed",
      error: "console_error",
    };
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
      session = await this.connect(
        {
          host: host.host,
          port: host.port,
          username: host.username,
          password: secrets.password,
          privateKey: secrets.privateKey,
          passphrase: secrets.passphrase,
          hostKeyFingerprint: host.hostKeyFingerprint,
          readyTimeoutMs: Math.min(20_000, run.timeoutMinutes * 60_000),
        },
        abort.signal,
      );
      if (abort.signal.aborted) throw abort.signal.reason;
      host.state = "installing";
      const command = buildRemoteCommand({
        consoleUrl: ctx.consoleUrl,
        serverUrl: ctx.serverUrl,
        caSha256: ctx.caSha256,
        options: run.options,
        sudo: secrets.sudoPassword ? "sudo-s" : "sudo-n",
      });
      const stdin = Buffer.concat([
        Buffer.from(`${minted.token}\n`, "utf8"),
        ...(secrets.sudoPassword ? [secrets.sudoPassword, Buffer.from("\n")] : []),
      ]);
      const live = session;
      const closeOnAbort = () => live.close();
      abort.signal.addEventListener("abort", closeOnAbort, { once: true });
      let exitCode: number | null;
      try {
        exitCode = await live.exec(command, stdin, (chunk) => host.output.push(chunk));
      } finally {
        stdin.fill(0);
        abort.signal.removeEventListener("abort", closeOnAbort);
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      host.exitCode = exitCode;
      if (exitCode === null) {
        outcome = { state: "failed", error: "connection_lost" };
      } else if (exitCode !== 0) {
        outcome = {
          state: "failed",
          error: classifyFailure(exitCode, host.output.text(secretStrings(secrets, host.token))),
        };
      } else {
        const use = await enrollmentTokenUse(ctx.db, minted.tokenId);
        host.nodeId = use.usedByNodeId;
        outcome = use.usedByNodeId
          ? { state: "succeeded", error: null }
          : { state: "failed", error: "not_enrolled" };
      }
    } catch (error) {
      if (error === "canceled") outcome = { state: "canceled", error: null };
      else if (error === "timeout") outcome = { state: "failed", error: "timeout" };
      else if (error instanceof SshFailure) {
        outcome = { state: "failed", error: abort.signal.aborted ? reasonOf(abort) : error.code };
        if (outcome.error === null) outcome.state = "canceled";
        host.presentedFingerprint = error.presented;
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
      session?.close();
    }
    try {
      if (outcome.state !== "succeeded" && host.tokenId) {
        // A late enrollment wins: the node exists, the install worked.
        const use = await expireUnusedEnrollmentToken(ctx.db, host.tokenId);
        if (use.usedByNodeId) {
          host.nodeId = use.usedByNodeId;
          outcome = { state: "succeeded", error: null };
        }
      }
    } finally {
      host.output.seal(secretStrings(secrets, host.token));
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
      return { ...rest, output: output.text(secretStrings(run.secrets, token)) };
    });
    return {
      id: run.id,
      clusterId: run.clusterId,
      nodeGroupId: run.nodeGroupId,
      state: run.state,
      concurrency: run.concurrency,
      timeoutMinutes: run.timeoutMinutes,
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

function reasonOf(abort: AbortController): SshInstallError | null {
  return abort.signal.reason === "timeout" ? "timeout" : null;
}
