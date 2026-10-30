import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshInstallRun } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import ssh2 from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { setLogLevel } from "../../src/server/lib/logger";
import { hostKeyFingerprint } from "../../src/server/lib/ssh";
import { claimEnrollmentToken } from "../../src/server/services/enrollment";
import {
  buildRemoteCommand,
  classifyFailure,
  REMOTE_SCRIPT,
  SshInstallRuns,
  scrubOutput,
} from "../../src/server/services/ssh-install";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const { Server, utils } = ssh2;

// Recognizable credentials: none of them may ever reach the database, the logs or an answer.
const PASSWORD = "Pw-6f1c2a9e-ssh-login";
const SUDO_PASSWORD = "Sudo-93b7d4e1-secret";
const PASSPHRASE = "Kp-0d8e55aa-phrase";
const SECRETS = [PASSWORD, SUDO_PASSWORD, PASSPHRASE];

const hostKey = utils.generateKeyPairSync("ed25519");
const otherHostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519", {
  passphrase: PASSPHRASE,
  cipher: "aes256-ctr",
  rounds: 16,
});
const plainClientKey = utils.generateKeyPairSync("ed25519");
const fingerprintOf = (publicKey: string) => {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("bad test key");
  return hostKeyFingerprint(parsed.getPublicSSH());
};
const HOST_FP = fingerprintOf(hostKey.public);
const OTHER_FP = fingerprintOf(otherHostKey.public);

type Exec = (call: {
  command: string;
  stdin: string;
  username: string;
  write: (text: string) => void;
}) => Promise<number | "hang">;

/** A real SSH server (ssh2) whose exec runs the test's script instead of a shell. */
async function sshServer(opts: { exec: Exec; key?: string; keyboardOnly?: boolean }) {
  const execs: { command: string; stdin: string; username: string }[] = [];
  const clients = new Set<{ end: () => void }>();
  const server = new Server({ hostKeys: [opts.key ?? hostKey.private] }, (client) => {
    clients.add(client);
    let username = "";
    client.on("authentication", (auth) => {
      username = auth.username;
      if (auth.method === "password" && !opts.keyboardOnly && auth.password === PASSWORD)
        return auth.accept();
      if (auth.method === "keyboard-interactive") {
        return auth.prompt([{ prompt: "Password: ", echo: false }], (answers) =>
          answers[0] === PASSWORD ? auth.accept() : auth.reject(),
        );
      }
      if (auth.method === "publickey") {
        const allowed = [clientKey, plainClientKey].some((pair) => {
          const parsed = utils.parseKey(pair.public);
          return (
            !(parsed instanceof Error) &&
            !Array.isArray(parsed) &&
            parsed.getPublicSSH().equals(auth.key.data)
          );
        });
        if (!allowed) return auth.reject();
        if (!auth.signature) return auth.accept();
        const parsed = utils.parseKey(
          auth.key.data.equals(fingerprintKey(clientKey.public))
            ? clientKey.public
            : plainClientKey.public,
        );
        if (parsed instanceof Error || Array.isArray(parsed)) return auth.reject();
        return parsed.verify(auth.blob as Buffer, auth.signature, auth.hashAlgo) === true
          ? auth.accept()
          : auth.reject();
      }
      auth.reject(
        opts.keyboardOnly
          ? ["keyboard-interactive"]
          : ["password", "publickey", "keyboard-interactive"],
      );
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          let stdin = "";
          stream.on("data", (chunk: Buffer) => {
            stdin += chunk.toString("utf8");
          });
          stream.on("end", async () => {
            execs.push({ command: info.command, stdin, username });
            const code = await opts.exec({
              command: info.command,
              stdin,
              username,
              write: (text) => stream.write(text),
            });
            if (code === "hang") return;
            stream.exit(code);
            stream.end();
          });
        });
      });
    });
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    execs,
    close: () => {
      for (const client of clients) client.end();
      server.close();
    },
  };
}

function fingerprintKey(publicKey: string): Buffer {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("bad test key");
  return parsed.getPublicSSH();
}

describe("SSH install (ADR-0066)", async () => {
  // The test servers listen on loopback, a special-purpose address the outbound policy refuses
  // unless allowed.
  const { ctx, client: pglite } = await createTestContext({
    EDGEWEIR_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8",
  });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  const logs: string[] = [];
  const writes = { out: process.stdout.write, err: process.stderr.write };

  /** Enrolls a node with the token from stdin, as `edgeweir-node enroll` would. */
  const enroll = async (stdin: string, name = "") => {
    const token = stdin.split("\n")[0] ?? "";
    await ctx.db.transaction(async (tx) => {
      const row = await claimEnrollmentToken(tx, token);
      if (!row) throw new Error("token not claimable");
      const [node] = await tx
        .insert(schema.node)
        .values({
          clusterId: row.clusterId,
          nodeGroupId: row.nodeGroupId,
          name: row.nodeName || name || "edge",
        })
        .returning();
      await tx
        .update(schema.enrollmentToken)
        .set({ usedAt: new Date(), usedByNodeId: node?.id })
        .where(eq(schema.enrollmentToken.id, row.id));
    });
  };

  const until = async (id: string, done: (r: SshInstallRun) => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const current = await admin.sshInstalls.get({ id });
      if (done(current)) return current;
      if (Date.now() > deadline) throw new Error(`run not done: ${JSON.stringify(current)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const ended = (id: string) => until(id, (r) => r.state !== "running");

  const host = (port: number, extra: Record<string, unknown> = {}) => ({
    host: "127.0.0.1",
    port,
    hostKeyFingerprint: HOST_FP,
    ...extra,
  });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    // Every log line of the whole file, at debug level, for the "never logged" checks.
    setLogLevel("debug");
    const capture = (original: typeof process.stdout.write) =>
      ((chunk: unknown, ...rest: unknown[]) => {
        logs.push(String(chunk));
        return (original as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
      }) as typeof process.stdout.write;
    process.stdout.write = capture(writes.out);
    process.stderr.write = capture(writes.err);
  });
  afterAll(async () => {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
    setLogLevel("error");
    await pglite.close();
  });
  beforeEach(() => {
    ctx.sshInstalls = new SshInstallRuns({ minuteMs: 60_000 });
  });

  it("scans host keys: the fingerprint the server presents, unreachable and non-SSH hosts", async () => {
    const server = await sshServer({ exec: async () => 0 });
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const notSsh: NetServer = createServer((socket) =>
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
    );
    await new Promise<void>((r) => notSsh.listen(0, "127.0.0.1", r));
    try {
      const { hosts } = await admin.sshInstalls.scanHostKeys({
        hosts: [
          { host: "127.0.0.1", port: server.port },
          { host: "127.0.0.1", port: closedPort },
          { host: "127.0.0.1", port: (notSsh.address() as AddressInfo).port },
          { host: "10.0.0.1", port: 22 },
          { host: "no-such-host.invalid", port: 22 },
        ],
      });
      expect(hosts[0]).toEqual({
        host: "127.0.0.1",
        port: server.port,
        algorithm: "ssh-ed25519",
        fingerprint: HOST_FP,
        error: null,
      });
      expect(hosts[1]).toMatchObject({ fingerprint: null, error: "unreachable" });
      expect(hosts[2]).toMatchObject({ fingerprint: null, error: "not_ssh" });
      // Private addresses only with EDGEWEIR_OUTBOUND_ALLOW_CIDRS, like every outbound target.
      expect(hosts[3]).toMatchObject({
        host: "10.0.0.1",
        fingerprint: null,
        error: "outbound_refused",
      });
      expect(hosts[4]).toMatchObject({ fingerprint: null, error: "unreachable" });
      // Only the handshake: the scan never authenticates nor runs anything.
      expect(server.execs).toEqual([]);
    } finally {
      server.close();
      notSsh.close();
    }
  });

  it("installs over password + sudo -S; the token and passwords only travel on stdin and never come back", async () => {
    const server = await sshServer({
      exec: async ({ stdin, write }) => {
        // A careless install script echoing what it got: the console must scrub it.
        const [token, sudo] = stdin.split("\n");
        write(`[edgeweir] installing\ndebug token=${token} sudo=${sudo}\n`);
        write(`-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n`);
        await enroll(stdin);
        write("[edgeweir] done: installed and enrolled\n");
        return 0;
      },
    });
    try {
      const started = await admin.sshInstalls.start({
        clusterId,
        credential: { username: "deploy", password: PASSWORD, sudoPassword: SUDO_PASSWORD },
        hosts: [host(server.port, { nodeName: "edge-ssh-1" })],
        options: { version: "1.6.2", mirror: "https://mirror.example.com/edgeweir" },
      });
      expect(started.state).toBe("running");
      const done = await ended(started.id);
      const [result] = done.hosts;
      expect(done).toMatchObject({ state: "finished", counts: { succeeded: 1, failed: 0 } });
      expect(result).toMatchObject({
        state: "succeeded",
        error: null,
        exitCode: 0,
        username: "deploy",
        attempts: 1,
      });
      expect(result?.nodeId).toBeTruthy();
      const [node] = await ctx.db
        .select()
        .from(schema.node)
        .where(eq(schema.node.id, result?.nodeId ?? ""));
      expect(node?.name).toBe("edge-ssh-1");

      const [exec] = server.execs;
      const [token, sudo, rest] = (exec?.stdin ?? "").split("\n");
      expect(token).toMatch(/^ewt_/);
      expect(sudo).toBe(SUDO_PASSWORD);
      expect(rest).toBe("");
      expect(exec?.username).toBe("deploy");
      // The command line: script, URLs and options only.
      for (const secret of [...SECRETS, token ?? ""]) expect(exec?.command).not.toContain(secret);
      expect(exec?.command).toContain(`${origin}/install.sh sudo-s --server`);
      expect(exec?.command).toContain(
        "--version 1.6.2 --mirror https://mirror.example.com/edgeweir",
      );
      expect(exec?.command).toContain(`--ca-sha256 ${ctx.nodeCa.fingerprintSha256}`);

      expect(result?.output).toContain("[edgeweir] done: installed and enrolled");
      expect(result?.output).toContain("debug token=[redacted] sudo=[redacted]");
      expect(result?.output).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(result?.output).not.toMatch(/ewt_/);

      const audits = (await admin.auditLogs.list({ action: "ssh_install.host" })).items;
      expect(audits[0]?.metadata).toMatchObject({
        runId: started.id,
        host: "127.0.0.1",
        port: server.port,
        user: "deploy",
        hostKeyFingerprint: HOST_FP,
        outcome: "succeeded",
        nodeId: result?.nodeId,
      });
    } finally {
      server.close();
    }
  });

  it("authenticates with an encrypted private key, and with keyboard-interactive; sudo -n without a sudo password", async () => {
    const server = await sshServer({
      keyboardOnly: false,
      exec: async ({ stdin }) => {
        await enroll(stdin);
        return 0;
      },
    });
    const keyboard = await sshServer({
      keyboardOnly: true,
      exec: async ({ stdin }) => {
        await enroll(stdin);
        return 0;
      },
    });
    try {
      const byKey = await ended(
        (
          await admin.sshInstalls.start({
            clusterId,
            credential: { username: "ops", privateKey: clientKey.private, passphrase: PASSPHRASE },
            hosts: [host(server.port)],
          })
        ).id,
      );
      expect(byKey.hosts[0]).toMatchObject({ state: "succeeded", username: "ops" });
      expect(server.execs[0]?.command).toContain("install.sh sudo-n --server");
      expect(server.execs[0]?.stdin.split("\n")).toHaveLength(2); // the token line only

      const byKeyboard = await ended(
        (
          await admin.sshInstalls.start({
            clusterId,
            credential: { password: PASSWORD },
            hosts: [host(keyboard.port)],
          })
        ).id,
      );
      expect(byKeyboard.hosts[0]).toMatchObject({ state: "succeeded", username: "root" });
    } finally {
      server.close();
      keyboard.close();
    }
  });

  it("refuses unreadable keys and wrong passphrases before connecting", async () => {
    const base = { clusterId, hosts: [host(1)] };
    const invalid = await rpcError(
      admin.sshInstalls.start({ ...base, credential: { privateKey: "not a key" } }),
    );
    expect(invalid.code).toBe("SSH_PRIVATE_KEY_INVALID");
    const noPhrase = await rpcError(
      admin.sshInstalls.start({ ...base, credential: { privateKey: clientKey.private } }),
    );
    expect(noPhrase.code).toBe("SSH_PRIVATE_KEY_PASSPHRASE");
    const wrong = await rpcError(
      admin.sshInstalls.start({
        ...base,
        credential: { privateKey: clientKey.private, passphrase: "wrong-phrase" },
      }),
    );
    expect(wrong.code).toBe("SSH_PRIVATE_KEY_PASSPHRASE");
    for (const error of [invalid, noPhrase, wrong]) {
      expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
        PASSPHRASE,
      );
    }
  });

  it("refuses hosts the outbound policy refuses, without connecting", async () => {
    const done = await ended(
      (
        await admin.sshInstalls.start({
          clusterId,
          credential: { password: PASSWORD },
          hosts: [{ host: "10.0.0.1", hostKeyFingerprint: HOST_FP }],
        })
      ).id,
    );
    expect(done.hosts[0]).toMatchObject({ state: "failed", error: "outbound_refused" });
  });

  it("refuses a host key other than the confirmed one, expires that host's token, keeps going with the others", async () => {
    const impostor = await sshServer({ key: otherHostKey.private, exec: async () => 0 });
    const genuine = await sshServer({
      exec: async ({ stdin }) => {
        await enroll(stdin);
        return 0;
      },
    });
    try {
      const done = await ended(
        (
          await admin.sshInstalls.start({
            clusterId,
            credential: { password: PASSWORD },
            hosts: [host(impostor.port), host(genuine.port)],
          })
        ).id,
      );
      expect(done.hosts[0]).toMatchObject({
        state: "failed",
        error: "host_key_mismatch",
        presentedFingerprint: OTHER_FP,
      });
      expect(done.hosts[1]).toMatchObject({ state: "succeeded" });
      // The impostor never got to authenticate, let alone see the token.
      expect(impostor.execs).toEqual([]);
      const [token] = await ctx.db
        .select()
        .from(schema.enrollmentToken)
        .where(eq(schema.enrollmentToken.id, done.hosts[0]?.tokenId ?? ""));
      expect(token?.usedAt).toBeNull();
      expect(token?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      impostor.close();
      genuine.close();
    }
  });

  it("names what failed: authentication, sudo, download, install, not enrolled; then retries with a new credential", async () => {
    let behaviour: "sudo" | "download" | "fail" | "noop" | "ok" = "sudo";
    const server = await sshServer({
      exec: async ({ stdin, write }) => {
        if (behaviour === "sudo") {
          write("Sorry, try again.\nsudo: 1 incorrect password attempt\n");
          return 1;
        }
        if (behaviour === "download") return 91;
        if (behaviour === "fail") {
          write("[edgeweir] error: checksum mismatch\n");
          return 1;
        }
        if (behaviour === "noop") {
          write(
            "[edgeweir] already enrolled; to enroll again with a new token, run this command with --force\n",
          );
          return 0;
        }
        await enroll(stdin);
        return 0;
      },
    });
    try {
      const wrongPassword = await ended(
        (
          await admin.sshInstalls.start({
            clusterId,
            credential: { password: "wrong-password" },
            hosts: [host(server.port)],
          })
        ).id,
      );
      expect(wrongPassword.hosts[0]).toMatchObject({ state: "failed", error: "auth_failed" });

      const first = await admin.sshInstalls.start({
        clusterId,
        credential: { username: "deploy", password: PASSWORD, sudoPassword: "wrong" },
        hosts: [host(server.port)],
      });
      let done = await ended(first.id);
      expect(done.hosts[0]).toMatchObject({
        state: "failed",
        error: "sudo_password_wrong",
        exitCode: 1,
      });
      for (const [b, error] of [
        ["download", "download_failed"],
        ["fail", "install_failed"],
        ["noop", "not_enrolled"],
      ] as const) {
        behaviour = b;
        await admin.sshInstalls.retry({
          id: first.id,
          credential: { username: "deploy", password: PASSWORD },
        });
        done = await ended(first.id);
        expect(done.hosts[0], b).toMatchObject({ state: "failed", error });
      }
      expect(
        (
          await rpcError(
            admin.sshInstalls.retry({
              id: first.id,
              credential: { password: "x" },
              hosts: [{ id: "7" }],
            }),
          )
        ).code,
      ).toBe("SSH_INSTALL_NOTHING_TO_RETRY");
      behaviour = "ok";
      await admin.sshInstalls.retry({
        id: first.id,
        credential: { username: "deploy", password: PASSWORD, sudoPassword: SUDO_PASSWORD },
      });
      done = await ended(first.id);
      expect(done.hosts[0]).toMatchObject({ state: "succeeded", attempts: 5, error: null });
      // Each attempt had its own token; the failed ones are expired and unused.
      const tokens = await ctx.db.select().from(schema.enrollmentToken);
      expect(new Set(server.execs.map((e) => e.stdin.split("\n")[0])).size).toBe(5);
      expect(
        tokens.filter((t) => t.usedAt === null).every((t) => t.expiresAt.getTime() <= Date.now()),
      ).toBe(true);
      expect(
        (await rpcError(admin.sshInstalls.retry({ id: first.id, credential: { password: "x" } })))
          .code,
      ).toBe("SSH_INSTALL_NOTHING_TO_RETRY");
    } finally {
      server.close();
    }
  });

  it("cancels: running hosts are disconnected, queued ones never start; a host over its timeout fails", async () => {
    const server = await sshServer({ exec: async () => "hang" });
    try {
      const started = await admin.sshInstalls.start({
        clusterId,
        credential: { password: PASSWORD },
        hosts: [host(server.port), { ...host(server.port), host: "localhost" }],
        concurrency: 1,
      });
      // The server records an exec once stdin ends, which can trail the "installing" state.
      await until(started.id, () => server.execs.length === 1);
      expect(
        (await rpcError(admin.sshInstalls.retry({ id: started.id, credential: { password: "x" } })))
          .code,
      ).toBe("SSH_INSTALL_BUSY");
      await admin.sshInstalls.cancel({ id: started.id });
      const done = await ended(started.id);
      expect(done.state).toBe("canceled");
      expect(done.hosts.map((h) => h.state)).toEqual(["canceled", "canceled"]);
      expect(done.hosts[1]?.attempts).toBe(0);
      expect(server.execs).toHaveLength(1);

      ctx.sshInstalls = new SshInstallRuns({ minuteMs: 300 });
      const slow = await ended(
        (
          await admin.sshInstalls.start({
            clusterId,
            credential: { password: PASSWORD },
            hosts: [host(server.port)],
          })
        ).id,
      );
      expect(slow.hosts[0]).toMatchObject({ state: "failed", error: "timeout" });
    } finally {
      server.close();
    }
  });

  it("limits runs: duplicate hosts, active runs, unknown runs", async () => {
    const server = await sshServer({ exec: async () => "hang" });
    try {
      const duplicate = await rpcError(
        admin.sshInstalls.start({
          clusterId,
          credential: { password: PASSWORD },
          hosts: [host(server.port), host(server.port)],
        }),
      );
      expect(duplicate.code).toBe("SSH_INSTALL_DUPLICATE_HOST");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(
          (
            await admin.sshInstalls.start({
              clusterId,
              credential: { password: PASSWORD },
              hosts: [host(server.port)],
            })
          ).id,
        );
      }
      const tooMany = await rpcError(
        admin.sshInstalls.start({
          clusterId,
          credential: { password: PASSWORD },
          hosts: [host(server.port)],
        }),
      );
      expect(tooMany.code).toBe("SSH_INSTALL_TOO_MANY_RUNS");
      for (const id of ids) await admin.sshInstalls.cancel({ id });
      for (const id of ids) await ended(id);
      const missing = await rpcError(
        admin.sshInstalls.get({ id: "00000000-0000-4000-8000-000000000000" }),
      );
      expect(missing.code).toBe("SSH_INSTALL_NOT_FOUND");
    } finally {
      server.close();
    }
  });

  it("on /api/v1: write keys only, no service accounts, no Idempotency-Key with credentials", async () => {
    const reader = (await admin.accessKeys.create({ name: "ssh-ro", scope: "read" })).key;
    const writer = (await admin.accessKeys.create({ name: "ssh-rw", scope: "write" })).key;
    const account = await admin.serviceAccounts.create({
      name: "ssh-sa",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const service = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    const body = {
      clusterId,
      credential: { password: PASSWORD },
      hosts: [host(1)],
    };
    const post = (
      key: string,
      path: string,
      payload: unknown,
      extra: Record<string, string> = {},
    ) =>
      app.request(`${origin}/api/v1${path}`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", ...extra },
        body: JSON.stringify(payload),
      });
    expect((await post(reader, "/ssh-installs", body)).status).toBe(403);
    expect((await post(service, "/ssh-installs", body)).status).toBe(403);
    expect(
      (await post(service, "/ssh-installs/host-keys", { hosts: [{ host: "127.0.0.1", port: 1 }] }))
        .status,
    ).toBe(403);
    const idem = await post(writer, "/ssh-installs", body, { "idempotency-key": "k1" });
    expect(idem.status).toBe(400);
    expect(((await idem.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_UNSUPPORTED");
    const idemRetry = await post(
      writer,
      "/ssh-installs/00000000-0000-4000-8000-000000000000/retry",
      { credential: { password: PASSWORD } },
      { "idempotency-key": "k2" },
    );
    expect(idemRetry.status).toBe(400);
    expect(await ctx.db.select().from(schema.idempotencyKey)).toEqual([]);

    const started = await post(writer, "/ssh-installs", body);
    expect(started.status).toBe(200);
    const run = (await started.json()) as SshInstallRun;
    const read = await app.request(`${origin}/api/v1/ssh-installs/${run.id}`, {
      headers: { "x-api-key": reader },
    });
    expect(read.status).toBe(200);
    await ended(run.id);
    // Validation errors never echo the credential.
    const invalid = await post(writer, "/ssh-installs", {
      ...body,
      credential: { password: `${PASSWORD}\n` },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(PASSWORD);
  });

  it("never writes a credential to any table or any log line", async () => {
    // Runs above used every credential in every way (start, retry, failures, cancel).
    const tables = await ctx.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const rows = (tables as unknown as { rows: { table_name: string }[] }).rows ?? tables;
    expect(rows.length).toBeGreaterThan(20);
    for (const { table_name } of rows as { table_name: string }[]) {
      const dump = await ctx.db.execute(sql.raw(`select * from "${table_name}"`));
      const text = JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      for (const secret of SECRETS)
        expect(text, `${table_name} holds a credential`).not.toContain(secret);
    }
    const allLogs = logs.join("");
    for (const secret of SECRETS) expect(allLogs).not.toContain(secret);
    expect(allLogs).not.toMatch(/ewt_[A-Za-z0-9_-]{20,}/);
  });
});

describe("remote command and output", () => {
  const options = {
    version: "",
    format: "auto" as const,
    mirror: "",
    mirrorOnly: false,
    modsecurity: true,
    noStart: false,
  };

  it("quotes every word and carries only the script, URLs and options", () => {
    const command = buildRemoteCommand({
      consoleUrl: "https://console.example.com/",
      serverUrl: "https://console.example.com:8443",
      caSha256: "ab".repeat(32),
      options: {
        ...options,
        format: "rpm",
        mirrorOnly: true,
        modsecurity: false,
        noStart: true,
        mirror: "https://m.example.com/a'b",
      },
      sudo: "sudo-n",
    });
    expect(command.startsWith("sh -c 'LC_ALL=C;")).toBe(true);
    expect(command).toContain(
      `https://console.example.com/install.sh sudo-n --server https://console.example.com:8443 --ca-sha256 ${"ab".repeat(32)} --format rpm --mirror 'https://m.example.com/a'"'"'b' --mirror-only --no-modsecurity --no-start`,
    );
  });

  it("classifies sudo's refusals and the script's exits", () => {
    expect(classifyFailure(1, "sudo: a password is required\n")).toBe("sudo_password_required");
    expect(classifyFailure(1, "Sorry, try again.\nsudo: 3 incorrect password attempts")).toBe(
      "sudo_password_wrong",
    );
    expect(classifyFailure(1, "sudo: sorry, you must have a tty to run sudo")).toBe(
      "sudo_requires_tty",
    );
    expect(
      classifyFailure(1, "deploy is not in the sudoers file.  This incident will be reported."),
    ).toBe("sudo_not_allowed");
    expect(classifyFailure(127, "sh: 1: sudo: not found")).toBe("sudo_not_allowed");
    expect(classifyFailure(91, "")).toBe("download_failed");
    expect(classifyFailure(1, "[edgeweir] error: cosign verify-blob failed")).toBe(
      "install_failed",
    );
  });

  it("scrubs secrets, enrollment tokens and private key blocks", () => {
    expect(scrubOutput("a=pw1 b=pw1pw1 ewt_AbC-12_x c", ["pw1", "pw1pw1"])).toBe(
      "a=[redacted] b=[redacted] [redacted] c",
    );
    expect(scrubOutput("x\n-----BEGIN RSA PRIVATE KEY-----\nMII\n", [])).toBe("x\n[redacted]");
  });

  describe("the remote script under sh", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ssh-install-script-"));
      const stub = (name: string, body: string) => {
        writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(dir, name), 0o755);
      };
      // curl -fsSL -o FILE URL: writes an install.sh that reports what it got.
      stub(
        "curl",
        `[ "$4" = "http://console.test/install.sh" ] || exit 22
cat >"$3" <<'SH'
echo "args=$*"
echo "token=$EDGEWEIR_TOKEN"
if IFS= read -r line; then echo "stdin=$line"; else echo "stdin=<eof>"; fi
SH`,
      );
      stub("id", `echo "\${FAKE_UID:-1000}"`);
      // sudo -S -p '' --preserve-env=…: reads one password line, then runs the rest.
      stub(
        "sudo",
        `if [ "$1" = -S ]; then IFS= read -r pw; echo "sudo-password=$pw"; shift 4; else shift 2; fi
exec "$@"`,
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const exec = (
      mode: string,
      stdin: string,
      env: Record<string, string> = {},
      url = "http://console.test/install.sh",
    ) =>
      new Promise<string>((resolve) => {
        const child = execFile(
          "sh",
          ["-c", REMOTE_SCRIPT, url, mode, "--server", "https://c:8443"],
          { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } },
          (error, stdout) =>
            resolve(error ? `exit ${(error as { code?: number }).code}\n${stdout}` : stdout),
        );
        child.stdin?.end(stdin);
      });

    it("as root: the token from stdin line 1 in EDGEWEIR_TOKEN, install.sh's stdin empty", async () => {
      expect(await exec("sudo-s", "ewt_tok\nleft-over-password\n", { FAKE_UID: "0" })).toBe(
        "args=--server https://c:8443\ntoken=ewt_tok\nstdin=<eof>\n",
      );
    });

    it("with sudo -S: sudo reads line 2, install.sh still reads nothing", async () => {
      expect(await exec("sudo-s", "ewt_tok\nsudo-pw\n")).toBe(
        "sudo-password=sudo-pw\nargs=--server https://c:8443\ntoken=ewt_tok\nstdin=<eof>\n",
      );
    });

    it("with sudo -n, and exit 91 when the download fails", async () => {
      expect(await exec("sudo-n", "ewt_tok\n")).toBe(
        "args=--server https://c:8443\ntoken=ewt_tok\nstdin=<eof>\n",
      );
      expect(await exec("sudo-n", "ewt_tok\n", {}, "http://other/install.sh")).toBe("exit 91\n");
      expect(await exec("sudo-n", "")).toBe("exit 90\n");
    });
  });
});
