import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/**
 * One-shot SSH install (ADR-0066): the console connects to each host once,
 * runs the same install.sh as the manual command with a one-time token, then
 * disconnects. Credentials live only in the console's memory for the run;
 * runs themselves are in memory too and are lost when the console restarts.
 */
export const SSH_INSTALL_LIMITS = {
  /** Hosts per run (and per host key scan). */
  hosts: 200,
  defaultConcurrency: 5,
  maxConcurrency: 20,
  defaultTimeoutMinutes: 15,
  maxTimeoutMinutes: 60,
  /** Runs not yet finished at the same time. */
  activeRuns: 4,
  /** A finished run stays readable this long. */
  keepMinutes: 60,
  /** Output kept per host: the last lines, at most this many bytes. */
  outputLines: 64,
  outputBytes: 16 * 1024,
  privateKeyBytes: 16 * 1024,
} as const;

const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;

/** A host name, IPv4 or IPv6 address (without brackets) the console can connect to. */
export function isSshHost(value: string): boolean {
  if (IPV4_RE.test(value)) return true;
  if (value.includes(":")) return IPV6_RE.test(value) && z.ipv6().safeParse(value).success;
  // All-numeric labels that are not an IPv4 address are a typo, not a host name.
  return HOSTNAME_RE.test(value) && !/^[\d.]+$/.test(value);
}

/** Linux login names (useradd's default rule, plus upper case and a trailing `$`). */
const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?$/;
export const isSshUsername = (value: string) => USERNAME_RE.test(value);

const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * An OpenSSH SHA-256 host key fingerprint, `SHA256:` and 43 base64
 * characters; accepts the bare base64 and a trailing `=` as pasted from other
 * tools. Null when it is none.
 */
export function normalizeFingerprint(value: string): string | null {
  let v = value.trim();
  if (/^sha256:/i.test(v)) v = v.slice(7);
  v = `SHA256:${v.replace(/=+$/, "")}`;
  return FINGERPRINT_RE.test(v) ? v : null;
}

export const sshHost = z.string().trim().toLowerCase().refine(isSshHost, "invalid host");
export const sshPort = z.number().int().min(1).max(65535);
export const sshUsername = z.string().trim().refine(isSshUsername, "invalid user name");
export const hostKeyFingerprint = z.string().transform((value, ctx) => {
  const fingerprint = normalizeFingerprint(value);
  if (fingerprint === null) {
    ctx.addIssue({ code: "custom", message: "expected an OpenSSH SHA256 fingerprint" });
    return z.NEVER;
  }
  return fingerprint;
});
const nodeName = z.string().trim().max(64);

/** One line of the host list as parsed (the UI's paste box, CSV files). */
export interface SshHostLine {
  host: string;
  port: number;
  username?: string;
  nodeName?: string;
}

/**
 * The host list an operator pastes: one host per line as `host[:port] [user]
 * [name]` (IPv6 as `[addr]:port` or bare), or CSV `host,port,user,name`
 * (empty fields take the defaults; a header line starting with `host` is
 * skipped). Blank lines and `#` comments are ignored. Errors name the
 * 1-based line.
 */
export function parseSshHostList(text: string): {
  hosts: SshHostLine[];
  errors: { line: number; text: string }[];
} {
  const hosts: SshHostLine[] = [];
  const errors: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parsed = line.includes(",") ? parseCsvLine(line) : parsePlainLine(line);
    if (parsed === "header") return;
    if (parsed) hosts.push(parsed);
    else errors.push({ line: index + 1, text: line });
  });
  return { hosts, errors };
}

function parseCsvLine(line: string): SshHostLine | null | "header" {
  const [host = "", port = "", username = "", name = "", ...rest] = line.split(",").map((field) =>
    field
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim(),
  );
  if (/^host(name)?$/i.test(host)) return "header";
  if (rest.some((field) => field !== "")) return null;
  return entry(host.replace(/^\[(.*)\]$/, "$1"), port || undefined, username, name);
}

function parsePlainLine(line: string): SshHostLine | null {
  const [target = "", username = "", name = "", ...rest] = line.split(/\s+/);
  if (rest.length > 0) return null;
  let host = target;
  let port: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(target);
  if (bracketed) {
    host = bracketed[1] ?? "";
    port = bracketed[2];
  } else if ((target.match(/:/g) ?? []).length === 1) {
    [host = "", port] = target.split(":");
  }
  return entry(host, port, username, name);
}

function entry(host: string, port: string | undefined, username: string, name: string) {
  const portNumber = port === undefined ? 22 : /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN;
  if (!isSshHost(host) || !(portNumber >= 1 && portNumber <= 65535)) return null;
  if (username && !isSshUsername(username)) return null;
  if (name.length > 64) return null;
  const line: SshHostLine = { host: host.toLowerCase(), port: portNumber };
  if (username) line.username = username;
  if (name) line.nodeName = name;
  return line;
}

const sshTarget = z.object({ host: sshHost, port: sshPort.default(22) });

export const scanHostKeysInput = z.object({
  hosts: z.array(sshTarget).min(1).max(SSH_INSTALL_LIMITS.hosts),
});

/** Why a host key could not be read. */
export const HOST_KEY_SCAN_ERRORS = ["unreachable", "timeout", "not_ssh"] as const;

export const hostKeyScan = z.object({
  host: z.string(),
  port: z.number().int(),
  /** The key type the console negotiates (ssh2's order, ssh-ed25519 first), e.g. `ssh-ed25519`. */
  algorithm: z.string().nullable(),
  /** OpenSSH `SHA256:…`; null when error is set. */
  fingerprint: z.string().nullable(),
  error: z.enum(HOST_KEY_SCAN_ERRORS).nullable(),
});
export type HostKeyScan = z.infer<typeof hostKeyScan>;

export const scanHostKeysResult = z.object({ hosts: z.array(hostKeyScan) });

/**
 * How the console signs in. A password, a private key (OpenSSH, PEM or PPK;
 * with its passphrase when encrypted), or both. A user other than root needs
 * sudo: with sudoPassword, `sudo -S`; without, passwordless sudo (`sudo -n`).
 * Kept in memory for the run only, never stored or logged.
 */
/** One line: sudo -S reads its password up to the first line break. */
const secretLine = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !/[\r\n]/.test(v), "must not contain line breaks");

export const sshCredential = z
  .object({
    /** The user for hosts whose line names none. */
    username: sshUsername.default("root"),
    password: secretLine.optional(),
    privateKey: z.string().min(1).max(SSH_INSTALL_LIMITS.privateKeyBytes).optional(),
    passphrase: secretLine.optional(),
    sudoPassword: secretLine.optional(),
  })
  .refine((c) => c.password !== undefined || c.privateKey !== undefined, {
    message: "a password or a private key is required",
    path: ["password"],
  });
export type SshCredential = z.infer<typeof sshCredential>;

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** install.sh options (ADR-0016); the defaults are the manual command's. */
export const sshInstallOptions = z.object({
  /** edgeweir-node version (semver, no `v`); empty: the latest. */
  version: z
    .string()
    .trim()
    .refine((v) => v === "" || SEMVER_RE.test(v), "expected a version like 1.6.2")
    .default(""),
  format: z.enum(["auto", "deb", "rpm", "tar"]).default("auto"),
  /** Release mirror (`--mirror`); empty: the console's mirror, then GitHub. */
  mirror: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === "" || /^https?:\/\/[^\s'"]+$/.test(v), "expected an http(s) URL")
    .default(""),
  mirrorOnly: z.boolean().default(false),
  /** False passes `--no-modsecurity`. */
  modsecurity: z.boolean().default(true),
  /** `--no-start`: install and enroll, do not start the service. */
  noStart: z.boolean().default(false),
});
export type SshInstallOptions = z.infer<typeof sshInstallOptions>;

export const sshInstallHostInput = z.object({
  host: sshHost,
  port: sshPort.default(22),
  /** Defaults to the credential's user. */
  username: sshUsername.optional(),
  /** Empty: the node names itself after its host name. */
  nodeName: nodeName.default(""),
  /** The host key the operator confirmed (scanHostKeys) or pasted; any other key is refused. */
  hostKeyFingerprint,
});

export const startSshInstallInput = z.object({
  clusterId: uuid,
  /** Defaults to the cluster's default node group. */
  nodeGroupId: uuid.optional(),
  credential: sshCredential,
  hosts: z.array(sshInstallHostInput).min(1).max(SSH_INSTALL_LIMITS.hosts),
  options: sshInstallOptions.default(sshInstallOptions.parse({})),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(SSH_INSTALL_LIMITS.maxConcurrency)
    .default(SSH_INSTALL_LIMITS.defaultConcurrency),
  /** Per host, from connecting to install.sh exiting. */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(SSH_INSTALL_LIMITS.maxTimeoutMinutes)
    .default(SSH_INSTALL_LIMITS.defaultTimeoutMinutes),
});
export type StartSshInstallInput = z.input<typeof startSshInstallInput>;

export const retrySshInstallInput = z.object({
  id: uuid,
  /** Required again: the run dropped the credential when it ended. */
  credential: sshCredential,
  /**
   * Hosts to retry (default: every failed or canceled one), optionally with a
   * corrected host key fingerprint.
   */
  hosts: z
    .array(z.object({ id: z.string().max(8), hostKeyFingerprint: hostKeyFingerprint.optional() }))
    .max(SSH_INSTALL_LIMITS.hosts)
    .optional(),
});

export const SSH_INSTALL_HOST_STATES = [
  "queued",
  "connecting",
  "installing",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type SshInstallHostState = (typeof SSH_INSTALL_HOST_STATES)[number];

/** Why a host failed (`ssh_install_error_<code>` in the UI). */
export const SSH_INSTALL_ERRORS = [
  "host_key_mismatch",
  "unreachable",
  "timeout",
  "auth_failed",
  "sudo_password_required",
  "sudo_password_wrong",
  "sudo_requires_tty",
  "sudo_not_allowed",
  "download_failed",
  "install_failed",
  /** install.sh exited 0 without using the token (most often: already enrolled). */
  "not_enrolled",
  "connection_lost",
  "console_error",
] as const;
export type SshInstallError = (typeof SSH_INSTALL_ERRORS)[number];

export const sshInstallHost = z.object({
  /** Stable within the run (its position), used to retry it. */
  id: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  nodeName: z.string(),
  hostKeyFingerprint: z.string(),
  state: z.enum(SSH_INSTALL_HOST_STATES),
  error: z.enum(SSH_INSTALL_ERRORS).nullable(),
  /** install.sh's exit status once it ended. */
  exitCode: z.number().int().nullable(),
  /** The host key presented when it did not match. */
  presentedFingerprint: z.string().nullable(),
  /** The one-time token of the current attempt (GET /enrollment-tokens/{id} follows it). */
  tokenId: uuid.nullable(),
  nodeId: uuid.nullable(),
  attempts: z.number().int(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  /** The last lines of the host's output, credentials and tokens removed. */
  output: z.string(),
});
export type SshInstallHost = z.infer<typeof sshInstallHost>;

export const sshInstallRun = z.object({
  id: uuid,
  clusterId: uuid,
  nodeGroupId: uuid.nullable(),
  /** running until every host ended; canceled when cancel ended it. */
  state: z.enum(["running", "finished", "canceled"]),
  concurrency: z.number().int(),
  timeoutMinutes: z.number().int(),
  options: sshInstallOptions,
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  /** The run is forgotten after this (finished runs only). */
  expiresAt: isoDateTime.nullable(),
  counts: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    canceled: z.number().int(),
  }),
  hosts: z.array(sshInstallHost),
});
export type SshInstallRun = z.infer<typeof sshInstallRun>;

const idParam = z.object({ id: uuid });

export const sshInstallsContract = {
  /** Connects to each host only to read its host key, for the operator to confirm. */
  scanHostKeys: oc
    .route({ method: "POST", path: "/ssh-installs/host-keys", tags: ["nodes"] })
    .input(scanHostKeysInput)
    .output(scanHostKeysResult),
  /** Starts installing on every host; the credential is kept in memory until the run ends. */
  start: oc
    .route({ method: "POST", path: "/ssh-installs", tags: ["nodes"] })
    .input(startSshInstallInput)
    .output(sshInstallRun),
  /** A run's state (poll it); 404 SSH_INSTALL_NOT_FOUND after a console restart or expiry. */
  get: oc
    .route({ method: "GET", path: "/ssh-installs/{id}", tags: ["nodes"] })
    .input(idParam)
    .output(sshInstallRun),
  /** Stops the run: queued hosts are canceled, running ones disconnected. */
  cancel: oc
    .route({ method: "POST", path: "/ssh-installs/{id}/cancel", tags: ["nodes"] })
    .input(idParam)
    .output(sshInstallRun),
  /** Runs failed or canceled hosts of an ended run again, with the credential sent anew. */
  retry: oc
    .route({ method: "POST", path: "/ssh-installs/{id}/retry", tags: ["nodes"] })
    .input(retrySshInstallInput)
    .output(sshInstallRun),
};

/**
 * Requests whose body carries SSH credentials: `/api/v1` refuses an
 * Idempotency-Key on them before anything (not even the body's hash) is kept.
 */
export function carriesSshCredentials(method: string, pathname: string): boolean {
  return method === "POST" && /^\/api\/v1\/ssh-installs(?:\/[^/]+\/retry)?\/?$/.test(pathname);
}
