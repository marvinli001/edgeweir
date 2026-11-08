import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSshInstallInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboundRefusedError } from "../../src/server/lib/outbound";
import { openSshSession, scanHostKey, sshAgentStatus } from "../../src/server/lib/ssh";
import { inputMarker, sh } from "../../src/server/lib/ssh-install-command";
import { type InstallContext, SshInstallRuns } from "../../src/server/services/ssh-install";
import { createTestContext, seedOperator } from "./helpers";

// The opt-in runner owns real sshd containers, sudo policies, firewall rules and ssh-agent.
describe.skipIf(process.env.EDGEWEIR_SSH_REAL !== "1")("real sshd installation lifecycle", () => {
  const jump = "172.30.121.2",
    target = "172.30.122.3";
  const password = randomBytes(24).toString("base64url");
  let ctx: Awaited<ReturnType<typeof createTestContext>>["ctx"];
  let database: Awaited<ReturnType<typeof createTestContext>>["client"];
  let context: InstallContext;
  let clusterId = "",
    jumpKey = "",
    targetKey = "",
    consoleUrl = "";
  let server: Server;
  let agent: ChildProcess;
  const folder = mkdtempSync(join(tmpdir(), "edgeweir-agent-test-"));
  const agentSocket = join(folder, "agent.sock");
  let script = "exit 25\n";
  const run = (command: string, args: string[], input?: string) =>
    execFileSync(command, args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
    }).trim();
  const container = (which: "jump" | "target") =>
    process.env[which === "jump" ? "SSH_TEST_JUMP_CONTAINER" : "SSH_TEST_TARGET_CONTAINER"]!;
  const onHost = (which: "jump" | "target", command: string) =>
    run("docker", ["exec", container(which), "bash", "-ec", command]);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate: () => boolean | Promise<boolean>, seconds = 20) => {
    for (let i = 0; i < seconds * 10; i++) {
      try {
        if (await predicate()) return;
      } catch {
        /* fixture may still be starting */
      }
      await sleep(100);
    }
    throw new Error("fixture deadline exceeded");
  };
  const login = (extra = {}) => ({
    host: jump,
    port: 22,
    username: "root",
    password: Buffer.from(password),
    hostKeyFingerprint: jumpKey,
    readyTimeoutMs: 2000,
    ...extra,
  });
  const ended = async (runs: SshInstallRuns, id: string) => {
    await waitFor(() => runs.get(id).state !== "running", 35);
    return runs.get(id);
  };
  const start = (runs: SshInstallRuns, extra: Record<string, unknown> = {}) =>
    runs.start(
      startSshInstallInput.parse({
        clusterId,
        credential: { username: "deploy", password, sudoPassword: password },
        hosts: [{ host: jump, hostKeyFingerprint: jumpKey }],
        timeoutMinutes: 1,
        ...extra,
      }),
      context,
    );
  const clean = (which: "jump" | "target") => {
    expect(onHost(which, "find /tmp -maxdepth 1 -name 'edgeweir-ssh-*' -print")).toBe("");
    expect(
      onHost(
        which,
        'if [ -f /tmp/edgeweir-fixture-pids ]; then while read -r pid; do ps -o stat= -p "$pid" 2>/dev/null || true; done </tmp/edgeweir-fixture-pids; fi',
      )
        .split("\n")
        .filter(Boolean)
        .every((stat) => stat.startsWith("Z")),
    ).toBe(true);
    onHost(which, "rm -f /tmp/edgeweir-fixture-pids");
  };
  beforeAll(async () => {
    ({ ctx, client: database } = await createTestContext());
    const actor = await seedOperator(ctx.db);
    const [cluster] = await ctx.db.insert(schema.cluster).values({ name: "real-ssh" }).returning();
    clusterId = cluster!.id;
    context = {
      db: ctx.db,
      log: ctx.log,
      actor: { type: "user", id: actor.userId },
      consoleUrl: "",
      serverUrl: "https://unused:8443",
      caSha256: "ab".repeat(32),
      resolve: async (host) => host,
    };
    for (const which of ["jump", "target"] as const) {
      await waitFor(
        () => onHost(which, "test -f /etc/ssh/ssh_host_ed25519_key.pub && echo ready") === "ready",
      );
      run(
        "docker",
        ["exec", "-i", container(which), "chpasswd"],
        ["root", "deploy", "nopass", "denied", "notty"]
          .map((user) => `${user}:${password}`)
          .join("\n") + "\n",
      );
    }
    jumpKey = (await scanHostKey({ host: jump, port: 22 }, 2000)).fingerprint!;
    targetKey = onHost("target", "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1]!;
    expect(jumpKey).not.toBe(targetKey);
    server = createServer((_req, res) => {
      if (script !== "hang-download") {
        res.writeHead(200);
        res.end(script);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    consoleUrl = `http://172.30.122.1:${(server.address() as { port: number }).port}`;
    context.consoleUrl = consoleUrl;
    agent = spawn("ssh-agent", ["-D", "-a", agentSocket], { stdio: "ignore" });
    await waitFor(() => existsSync(agentSocket));
    const key = ssh2.utils.generateKeyPairSync("ed25519");
    run("ssh-add", ["-"], key.private);
    for (const which of ["jump", "target"] as const)
      run(
        "docker",
        [
          "exec",
          "-i",
          container(which),
          "bash",
          "-ec",
          "mkdir -p /root/.ssh; chmod 700 /root/.ssh; cat >/root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys",
        ],
        key.public,
      );
  }, 30_000);
  afterAll(async () => {
    agent?.kill();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await database?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("uses requiretty without echoing token/password, keeps installer stdin empty, and preserves explicit failure", async () => {
    script = `#!/bin/bash\n[ "$1" = --token-file ] || exit 99\n[ "$(stat -c %a "$2")" = 600 ] || exit 98\nif read -r leftover; then echo leaked-input; exit 97; fi\nprintf '\\033[32mEDGEWEIR_RESULT {"v":1,"step":"check","status":"ok"}\\033[0m\\r\\n'\nprintf 'EDGEWEIR_RESULT {"v":1,"step":"done","status":"failed","failed_step":"install","exit":25}\\r\\n'\nexit 25\n`;
    const runs = new SshInstallRuns();
    const result = await ended(runs, (await start(runs)).id);
    expect(result.hosts[0]).toMatchObject({
      state: "failed",
      error: "install_failed",
      exitCode: 25,
      cleanup: "stopped",
      completedSteps: ["check"],
    });
    expect(result.hosts[0]?.output).not.toContain(password);
    expect(result.hosts[0]?.output).not.toMatch(/ewt_|leaked-input|EDGEWEIR_RESULT/);
    clean("jump");
  }, 30_000);

  it("keeps root and passwordless sudo and never retries an installer that mentions TTY", async () => {
    script =
      "#!/bin/bash\necho attempt >>/tmp/edgeweir-fixture-attempts\necho 'sudo: sorry, you must have a tty to run sudo'\nexit 1\n";
    for (const username of ["root", "nopass"]) {
      const runs = new SshInstallRuns();
      const done = await ended(
        runs,
        (await start(runs, { credential: { username, password } })).id,
      );
      expect(done.hosts[0]).toMatchObject({
        state: "failed",
        error: "sudo_requires_tty",
        cleanup: "stopped",
      });
    }
    expect(onHost("jump", "wc -l </tmp/edgeweir-fixture-attempts")).toBe("2");
    onHost("jump", "rm /tmp/edgeweir-fixture-attempts");
    clean("jump");
  }, 20_000);

  it("reports wrong sudo password, denied sudo, refused PTY, and explicit no-TTY accurately", async () => {
    for (const [username, sudoPassword, tty, error] of [
      ["deploy", "wrong", "auto", "sudo_password_wrong"],
      ["denied", password, "auto", "sudo_not_allowed"],
      ["notty", password, "always", "pty_refused"],
      ["deploy", password, "never", "sudo_requires_tty"],
    ]) {
      const runs = new SshInstallRuns();
      const done = await ended(
        runs,
        (await start(runs, { tty, credential: { username, password, sudoPassword } })).id,
      );
      expect(done.hosts[0]).toMatchObject({ state: "failed", error, cleanup: "not_needed" });
    }
  }, 30_000);

  it("uses one pinned jump for target scan and install; direct target SSH is blocked", async () => {
    expect((await scanHostKey({ host: target, port: 22 }, 500)).error).toBe("timeout");
    const jumpHost = {
      host: jump,
      port: 22,
      hostKeyFingerprint: jumpKey,
      credential: { username: "root", password, agent: false, agentForwarding: false },
    };
    const runs = new SshInstallRuns();
    const direct = await runs.scanHostKeys([{ host: target, port: 22 }], async (host) => host);
    expect(direct[0]).toMatchObject({ error: "timeout", errorHop: "target", fingerprint: null });
    const scan = await runs.scanHostKeys(
      [{ host: target, port: 22 }],
      async (host) => host,
      jumpHost,
    );
    expect(scan[0]).toMatchObject({ fingerprint: targetKey, error: null });
    script = "exit 25\n";
    const done = await ended(
      runs,
      (await start(runs, { jumpHost, hosts: [{ host: target, hostKeyFingerprint: targetKey }] }))
        .id,
    );
    expect(done.hosts[0]).toMatchObject({ error: "install_failed", cleanup: "stopped" });
    for (const hop of ["jump", "target"] as const) {
      const before = onHost(hop, "cat /var/log/sshd.log").split("Accepted password").length;
      const bad = await ended(
        runs,
        (
          await start(runs, {
            jumpHost: { ...jumpHost, hostKeyFingerprint: hop === "jump" ? targetKey : jumpKey },
            hosts: [{ host: target, hostKeyFingerprint: hop === "target" ? jumpKey : targetKey }],
          })
        ).id,
      );
      expect(bad.hosts[0]).toMatchObject({ error: "host_key_mismatch", errorHop: hop });
      expect(onHost(hop, "cat /var/log/sshd.log").split("Accepted password").length).toBe(before);
    }
    await expect(
      runs.scanHostKeys(
        [{ host: target, port: 22 }],
        async () => {
          throw new OutboundRefusedError();
        },
        jumpHost,
      ),
    ).resolves.toMatchObject([{ error: "outbound_refused" }]);
    clean("target");
  }, 30_000);

  it("uses Core agent for login, forwards only when opted in and revokes the remote socket at close", async () => {
    expect(await sshAgentStatus(undefined)).toMatchObject({
      available: false,
      reason: "not_configured",
    });
    expect(await sshAgentStatus(agentSocket)).toMatchObject({ available: true });
    for (const agentForwarding of [false, true]) {
      const session = await openSshSession(
        login({ password: undefined, agent: true, agentSocket, agentForwarding }),
        new AbortController().signal,
      );
      let output = "";
      try {
        const code = await session.exec(
          agentForwarding
            ? `ssh -oBatchMode=yes -oStrictHostKeyChecking=no -oUserKnownHostsFile=/dev/null root@127.0.0.1 true && printf '%s' "$SSH_AUTH_SOCK"`
            : `test -z "$SSH_AUTH_SOCK"`,
          Buffer.alloc(0),
          (chunk) => {
            output += chunk.toString();
          },
        );
        expect(code).toBe(0);
      } finally {
        session.close();
      }
      if (agentForwarding) {
        const socket = output.split("\n").at(-1)!;
        await waitFor(
          () => onHost("jump", `test ! -S ${sh(socket)} && echo revoked`) === "revoked",
        );
      }
    }
  }, 20_000);

  it("authenticates both hops with the agent and revokes target forwarding immediately on cancellation", async () => {
    script = `printf '%s' "$SSH_AUTH_SOCK" >/tmp/edgeweir-fixture-agent-socket
ssh -oBatchMode=yes -oStrictHostKeyChecking=no -oUserKnownHostsFile=/dev/null root@172.30.122.2 true || exit 25
echo $$ >/tmp/edgeweir-fixture-pids
sleep 120
`;
    const runs = new SshInstallRuns({ agentSocket });
    const started = await start(runs, {
      credential: { username: "root", agent: true, agentForwarding: true },
      jumpHost: {
        host: jump,
        port: 22,
        hostKeyFingerprint: jumpKey,
        credential: { username: "root", agent: true },
      },
      hosts: [{ host: target, hostKeyFingerprint: targetKey }],
    });
    await waitFor(
      () => onHost("target", "test -s /tmp/edgeweir-fixture-pids && echo running") === "running",
    );
    const socket = onHost("target", "cat /tmp/edgeweir-fixture-agent-socket");
    expect(socket).toMatch(/^\/tmp\/ssh-.*\/agent\./);
    expect(onHost("jump", "find /tmp -type s -path '/tmp/ssh-*/agent.*' -print")).toBe("");
    await runs.cancel(started.id, context.actor);
    await waitFor(
      () => onHost("target", `test ! -S ${sh(socket)} && echo revoked`) === "revoked",
      3,
    );
    const done = await ended(runs, started.id);
    expect(done.hosts[0]).toMatchObject({
      state: "canceled",
      cleanup: "stopped",
      cancelRequested: true,
    });
    onHost("target", "rm -f /tmp/edgeweir-fixture-agent-socket");
    clean("target");
  }, 30_000);

  it("transmits terminal control bytes only after raw mode acknowledgement", async () => {
    const session = await openSshSession(login(), new AbortController().signal);
    const id = randomUUID(),
      secret = Buffer.from(
        "test\\u0003\\u001b\\u007f安全".replace(/\\u([0-9a-f]{4})/g, (_, n) =>
          String.fromCharCode(parseInt(n, 16)),
        ),
      );
    let output = "";
    try {
      const code = await session.exec(
        `stty raw -echo || exit 94; printf '\\n${inputMarker(id)}\\n'; head -c ${secret.length} | wc -c`,
        secret,
        (chunk) => {
          output += chunk.toString();
        },
        { pty: true, inputReady: inputMarker(id), timeoutMs: 3000 },
      );
      expect(code).toBe(0);
      expect(output.trim()).toBe(String(secret.length));
    } finally {
      secret.fill(0);
      session.close();
    }
  });

  it("cancels running and queued hosts, terminates their real processes and temporary files", async () => {
    script =
      "#!/bin/bash\necho $$ >/tmp/edgeweir-fixture-pids\nsleep 120 & echo $! >>/tmp/edgeweir-fixture-pids\nwait\n";
    const runs = new SshInstallRuns();
    const started = await start(runs, {
      concurrency: 1,
      hosts: [
        { host: jump, hostKeyFingerprint: jumpKey },
        { host: target, hostKeyFingerprint: targetKey },
      ],
    });
    await waitFor(
      () => onHost("jump", "test -s /tmp/edgeweir-fixture-pids && echo started") === "started",
    );
    const requested = await runs.cancel(started.id, context.actor);
    expect(requested.hosts[0]?.cancelRequested).toBe(true);
    const done = await ended(runs, started.id);
    expect(done.hosts[0]).toMatchObject({ state: "canceled", cleanup: "stopped" });
    expect(done.hosts[1]).toMatchObject({ state: "canceled", attempts: 0, cleanup: "not_needed" });
    clean("jump");
  }, 30_000);

  it("times out during download and installation, with confirmed remote termination", async () => {
    for (const body of [
      "hang-download",
      "#!/bin/bash\necho $$ >/tmp/edgeweir-fixture-pids\nsleep 120 & echo $! >>/tmp/edgeweir-fixture-pids\nwait\n",
    ]) {
      script = body;
      const runs = new SshInstallRuns({ minuteMs: 2000 });
      const done = await ended(runs, (await start(runs)).id);
      expect(done.hosts[0]).toMatchObject({
        state: "failed",
        error: "timeout",
        cleanup: "stopped",
      });
      clean("jump");
    }
  }, 30_000);

  it("forces a TERM-resistant installer to stop and removes its private temporary token copies", async () => {
    script = `#!/bin/bash
trap "" TERM
cp "$2" "$TMPDIR/retained-token"
echo $$ >/tmp/edgeweir-fixture-pids
bash -c 'trap "" TERM; sleep 120' & echo $! >>/tmp/edgeweir-fixture-pids
wait
`;
    const runs = new SshInstallRuns({ minuteMs: 2000 });
    const done = await ended(runs, (await start(runs)).id);
    expect(done.hosts[0]).toMatchObject({ state: "failed", error: "timeout", cleanup: "stopped" });
    clean("jump");
  }, 30_000);

  it("keeps a deadline after SSH loss and reports remote state unknown when cleanup cannot reconnect", async () => {
    script =
      "#!/bin/bash\necho $$ >/tmp/edgeweir-fixture-pids\nsleep 120 & echo $! >>/tmp/edgeweir-fixture-pids\nwait\n";
    const runs = new SshInstallRuns({ minuteMs: 3000 });
    const started = await start(runs);
    await waitFor(
      () => onHost("jump", "test -s /tmp/edgeweir-fixture-pids && echo started") === "started",
    );
    onHost("jump", "pkill -x sshd; pkill -x sshd-session || true; pkill -x sshd-auth || true");
    try {
      const done = await ended(runs, started.id);
      expect(done.hosts[0]).toMatchObject({ state: "failed", cleanup: "unknown" });
      expect(["connection_lost", "timeout"]).toContain(done.hosts[0]?.error);
      await waitFor(
        () => onHost("jump", "find /tmp -maxdepth 1 -name 'edgeweir-ssh-*' -print") === "",
        25,
      );
      clean("jump");
    } finally {
      run("docker", [
        "exec",
        "-d",
        container("jump"),
        "/usr/sbin/sshd",
        "-D",
        "-E",
        "/var/log/sshd.log",
      ]);
    }
  }, 40_000);
});
