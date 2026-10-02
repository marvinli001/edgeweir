import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";

// deploy.sh installs and upgrades the 宝塔 / aaPanel compose deployments
// (docs/deploy/baota.md). Servers only download the script, so it carries the
// compose templates itself; they must stay identical to the files in the repo.
const repo = resolve(import.meta.dirname, "../../../..");
const script = resolve(repo, "deploy.sh");
const read = (file: string) => readFileSync(resolve(repo, file), "utf8");

/** Runs bash with deploy.sh sourced (functions only) and returns stdout. */
function sourced(code: string, env: Record<string, string> = {}): string {
  return execFileSync("/bin/bash", ["-c", `source "$1"; ${code}`, "bash", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", EDGEWEIR_YES: "1", ...env },
  });
}

/** Like sourced, with errexit as when run, and the exit status and stderr too. */
function run(code: string, env: Record<string, string> = {}) {
  const result = spawnSync(
    "/bin/bash",
    ["-c", `source "$1"; set -Eeuo pipefail; ${code}`, "bash", script],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", EDGEWEIR_YES: "1", ...env },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratch = mkdtempSync(resolve(tmpdir(), "deploy-sh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
/** A fresh directory with the given files. */
function directory(files: Record<string, string> = {}): string {
  const dir = resolve(scratch, `d${dirs++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(resolve(dir, name), content);
  }
  return dir;
}

/**
 * A docker stand-in for the install checks: the daemon answers, there is no
 * edgeweir-console container, and `docker volume inspect` succeeds when
 * VOLUME is set.
 */
const DOCKER = `docker() {
  case "$1 \${2:-}" in
    "volume inspect") [[ -n \${VOLUME:-} ]] ;;
    "inspect "*) return 1 ;;
    *) return 0 ;;
  esac
}`;

describe("deploy.sh", () => {
  it("parses as bash", () => {
    execFileSync("bash", ["-n", script]);
  });

  it.each([
    ["host", "compose.baota-host.yml"],
    ["bundled", "compose.baota.yml"],
  ])("carries the %s template byte for byte (%s)", (mode, file) => {
    const printed = execFileSync("bash", [script, "template", mode], { encoding: "utf8" });
    expect(printed, `copy ${file} into deploy.sh`).toBe(read(file));
  });

  it("dumps host databases with the pinned PostgreSQL image of the bundled template", () => {
    const pinned = read("compose.baota.yml").match(/^\s*image:\s*(postgres:\S+)$/m)?.[1];
    expect(pinned).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(read("deploy.sh")).toContain(`readonly PG_IMAGE=${pinned}\n`);
  });

  it("keeps the web console on loopback and the node channel public with host networking", () => {
    const host = read("compose.baota-host.yml");
    expect(host).toMatch(/^\s*network_mode: host$/m);
    expect(host).toMatch(/^\s*HOST: 127\.0\.0\.1$/m);
    expect(host).toMatch(/^\s*NODE_API_HOST: 0\.0\.0\.0$/m);
    expect(host).not.toMatch(/^\s*ports:/m);
  });

  it("generates master keys envelope.ts accepts, with and without openssl", () => {
    // Without openssl the script falls back to /dev/urandom and base64.
    const bare = mkdtempSync(resolve(tmpdir(), "deploy-sh-"));
    for (const tool of ["base64", "basename", "dirname", "head", "od", "tr"]) {
      const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(found, resolve(bare, tool));
    }
    for (const path of [process.env.PATH ?? "", bare]) {
      for (let i = 0; i < 20; i++) {
        const key = sourced("rand_base64 32", { PATH: path }).trim();
        expect(() => new MasterKey(key), `${path}: ${key}`).not.toThrow();
      }
      expect(sourced("rand_hex 24", { PATH: path }).trim()).toMatch(/^[0-9a-f]{48}$/);
    }
  });

  it.each([
    ["127.0.0.1", "5432", "edgeweir", "edgeweir", "p@ss:w/rd$%&?#中 ", ""],
    ["db.example.com", "6543", "edge-weir", "app_user", "s3cret", "verify-full"],
    ["2001:db8::5", "5432", "edgeweir", "edgeweir", "x", "no-verify"],
  ])("builds and parses DATABASE_URL for %s", (host, port, name, user, password, sslmode) => {
    const url = sourced(
      "DB_HOST=$H DB_PORT=$P DB_NAME=$D DB_USER=$U DB_PASS=$W DB_SSLMODE=$S; db_url",
      { H: host, P: port, D: name, U: user, W: password, S: sslmode },
    );
    // The URL goes into .env unquoted: nothing Compose would expand or cut.
    expect(url).not.toMatch(/[\s"'`\\$#]/);
    expect(sourced('env_safe "$URL" && echo safe', { URL: url }).trim()).toBe("safe");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe(password);
    const fields = sourced(
      'db_parse "$URL"; printf "%s\\n" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_USER" "$DB_PASS" "$DB_SSLMODE"',
      { URL: url },
    );
    expect(fields.split("\n").slice(0, 6)).toEqual([host, port, name, user, password, sslmode]);
  });

  it("rejects connection strings it cannot hand to a PostgreSQL client", () => {
    for (const url of [
      "mysql://u:p@h/db",
      "postgres://h/db",
      "postgres://u:p@h1:5432,h2:5432/db",
      "postgres://u:p@h:5432",
    ]) {
      expect(() => sourced('db_parse "$URL"', { URL: url }), url).toThrow();
    }
  });

  it.each([
    ["https://cdn-admin.example.com", true],
    ["http://[2001:db8::1]:3000", true],
    ["https://cdn-admin.example.com:65535", true],
    ["https://cdn-admin.example.com:65536", false],
    ["https://cdn-admin.example.com/console", false],
    ["cdn-admin.example.com:8080", false],
  ])("valid_url %s: %s", (url, valid) => {
    expect(run('valid_url "$URL"', { URL: url }).status === 0).toBe(valid);
  });

  describe("install refuses to start over earlier data (P1-52)", () => {
    const unattended = {
      EDGEWEIR_PUBLIC_URL: "https://cdn-admin.example.com",
      EDGEWEIR_NO_PULL: "1",
    };

    it("stops on the bundled database volume an earlier install left", () => {
      const dir = resolve(scratch, "fresh-bundled");
      const result = run(`${DOCKER}; cmd_install`, {
        ...unattended,
        EDGEWEIR_DB: "bundled",
        EDGEWEIR_DIR: dir,
        VOLUME: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Docker 卷 edgeweir_postgres-data 已存在");
      expect(result.stderr).toContain("docker volume rm edgeweir_postgres-data");
      expect(existsSync(dir)).toBe(false);
    });

    it("stops on a host database a console has already migrated", () => {
      const dir = resolve(scratch, "fresh-host");
      // server version, CREATE on the database and on public, migrations table
      const psql = (used: string) => `pg_client() { echo "18 t t ${used}"; }`;
      const env = {
        ...unattended,
        EDGEWEIR_DB: "host",
        EDGEWEIR_DIR: dir,
        DATABASE_URL: "postgres://edgeweir:secret@127.0.0.1:5432/edgeweir",
      };
      const used = run(`${DOCKER}; ${psql("t")}; cmd_install`, env);
      expect(used.status).toBe(1);
      expect(used.stderr).toContain("数据库 edgeweir 里已经有 Edgeweir 的数据");
      expect(existsSync(dir)).toBe(false);
      // An empty database gets past the check (to the image, missing here).
      const empty = run(`${DOCKER}; ${psql("f")}; resolve_version() { exit 7; }; cmd_install`, env);
      expect(empty.status, empty.stderr).toBe(7);
    });

    it("never writes into a directory that holds other files", () => {
      const dir = directory({ "compose.yml": "services: {}\n", "deploy.sh": "" });
      const result = run(`${DOCKER}; cmd_install`, {
        ...unattended,
        EDGEWEIR_DB: "bundled",
        EDGEWEIR_DIR: dir,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不是空目录（有 compose.yml）");
      expect(readFileSync(resolve(dir, "compose.yml"), "utf8")).toBe("services: {}\n");
      // The script itself, downloaded into the directory, is not in the way.
      expect(sourced('other_entries "$D"', { D: directory({ "deploy.sh": "" }) })).toBe("");
      expect(sourced('other_entries "$D"', { D: directory({ ".env.old": "" }) })).toBe(
        ".env.old\n",
      );
    });
  });

  describe("backups (P1-54)", () => {
    it("leave the master key and the session secret out of the .env copy", () => {
      const dir = directory({
        ".env": [
          "# comment",
          "EDGEWEIR_MASTER_KEY=bWFzdGVyLWtleS1tYXN0ZXIta2V5LW1hc3Rlci1rZXkhIQ==",
          "BETTER_AUTH_SECRET=session-secret-session-secret-session",
          "POSTGRES_PASSWORD=0123abcd",
          "EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com",
          "",
        ].join("\n"),
      });
      const copy = sourced("DIR=$D; env_for_backup", { D: dir });
      expect(copy).not.toContain("bWFzdGVy");
      expect(copy).not.toContain("session-secret");
      expect(copy).toMatch(/^# EDGEWEIR_MASTER_KEY= /m);
      expect(copy).toMatch(/^# BETTER_AUTH_SECRET= /m);
      expect(copy).toContain("POSTGRES_PASSWORD=0123abcd\n");
      expect(copy).toContain("EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com\n");
    });

    it("keep the newest EDGEWEIR_BACKUP_KEEP and nothing they did not create", () => {
      const names = [
        "20260901-090000",
        "20260915-120000-before-20260915-a1b2c3d",
        "20260929-153000",
        "20261001-080000-before-20261001-b2c3d4e",
      ];
      const dir = directory({
        ...Object.fromEntries(names.map((n) => [`backups/${n}/edgeweir.dump`, "x"])),
        "backups/manual/edgeweir.dump": "x",
      });
      sourced("DIR=$D; prune_backups 2", { D: dir });
      expect(readdirSync(resolve(dir, "backups")).sort()).toEqual([...names.slice(2), "manual"]);
      sourced("DIR=$D; prune_backups 0", { D: dir });
      expect(readdirSync(resolve(dir, "backups"))).toHaveLength(3);
      expect(sourced("backup_keep")).toBe("5");
      expect(sourced("backup_keep", { EDGEWEIR_BACKUP_KEEP: "08" })).toBe("8");
      expect(run("backup_keep", { EDGEWEIR_BACKUP_KEEP: "all" }).status).toBe(1);
    });
  });

  describe("update versions (P1-56)", () => {
    // Two images of the same day; the smaller commit hash is the newer one.
    const labels = `docker() {
      case "$*" in
        *20260930-f00baa1*) echo 2026-09-30T10:00:00+08:00 ;;
        *20260930-0123456*) echo 2026-09-30T12:00:00+02:00 ;;
      esac
    }`;

    it.each([
      ["20260929-fffffff", "20260930-0000000", "newer"],
      ["20260930-0000000", "20260929-fffffff", "older"],
      ["20260930-f00baa1", "20260930-0123456", "newer"],
      ["20260930-0123456", "20260930-f00baa1", "older"],
      ["20260930-f00baa1", "20260930-abcdef0", "unknown"],
      ["20260930-abcdef0", "20260930-abcdef0@sha256:00", "same"],
      ["latest", "20260930-0123456", "unknown"],
      ["20260929-a1b2c3d@sha256:00", "20260930-0123456", "newer"],
    ])("orders %s → %s as %s", (from, to, order) => {
      expect(sourced(`${labels}; version_order "$FROM" "$TO"`, { FROM: from, TO: to })).toBe(
        `${order}\n`,
      );
    });

    it("reads release timestamps without date -d", () => {
      for (const time of [
        "1970-01-01T00:00:00Z",
        "2026-09-30T10:00:00+08:00",
        "2026-09-30T12:00:00.123-02:30",
        "2000-02-29T23:59:59Z",
        "2100-03-01T00:00:00+0100",
      ]) {
        expect(sourced('iso_epoch "$T"', { T: time }), time).toBe(
          String(Math.floor(Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) / 1000)),
        );
      }
      expect(run('iso_epoch "$T"', { T: "yesterday" }).status).toBe(1);
    });
  });

  describe("update and config keep local changes (P1-56)", () => {
    it("records what it writes, so later edits can be told from template updates", () => {
      const dir = directory();
      sourced("DIR=$D; COMPOSE_FILE=compose.yml; write_template host", { D: dir });
      expect(readFileSync(resolve(dir, "compose.yml"), "utf8")).toBe(
        read("compose.baota-host.yml"),
      );
      expect(statSync(resolve(dir, "compose.yml")).mode & 0o777).toBe(0o600);
      expect(readFileSync(resolve(dir, ".compose.cksum"), "utf8")).toBe(
        sourced('file_sum "$D/compose.yml"', { D: dir }),
      );
    });

    it("replaces an untouched compose file and keeps an edited one", () => {
      const template = sourced("template bundled");
      const older = template.replace("restart: unless-stopped", "restart: always");
      const update = (dir: string) =>
        run("DIR=$D; COMPOSE_FILE=compose.yml; update_template", { D: dir });
      const sum = (dir: string) => sourced('file_sum "$D/compose.yml"', { D: dir });

      // Written by an earlier script and never edited: replaced, also unattended.
      const untouched = directory({ "compose.yml": older });
      writeFileSync(resolve(untouched, ".compose.cksum"), sum(untouched));
      expect(update(untouched).status).toBe(0);
      expect(readFileSync(resolve(untouched, "compose.yml"), "utf8")).toBe(template);
      expect(readFileSync(resolve(untouched, ".compose.cksum"), "utf8")).toBe(sum(untouched));

      // Edited after the script wrote it: the change is shown and the file kept.
      const edited = directory({ "compose.yml": older });
      writeFileSync(resolve(edited, ".compose.cksum"), "0-0");
      const kept = update(edited);
      expect(kept.status).toBe(0);
      expect(kept.stderr).toContain("-    restart: always");
      expect(kept.stderr).toContain("compose.override.yml");
      expect(readFileSync(resolve(edited, "compose.yml"), "utf8")).toBe(older);
    });

    it("passes compose.override.yml to Compose", () => {
      const dir = directory({
        ".env": "POSTGRES_PASSWORD=x\n",
        "compose.yml": "services: {}\n",
        "compose.override.yml": "services: {}\n",
      });
      // compose() runs docker through env(1): a docker on PATH that prints its arguments.
      const bin = directory({ docker: '#!/bin/sh\nprintf "%s\\n" "$@"\n' });
      execFileSync("chmod", ["+x", resolve(bin, "docker")]);
      const args = sourced("DIR=$D; COMPOSE_FILE=compose.yml; compose ps", {
        D: dir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      expect(args).toContain(`-f\n${dir}/compose.yml\n-f\n${dir}/compose.override.yml\n`);
      rmSync(resolve(dir, "compose.override.yml"));
      expect(
        sourced("DIR=$D; COMPOSE_FILE=compose.yml; compose ps", {
          D: dir,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        }),
      ).not.toContain("override");
    });

    it.each([
      ["https://a.example.com:8443", "8443", "8443", "same"],
      ["https://a.example.com:8443", "8443", "9443", "follow"],
      ["https://a.example.com:8443", "", "9443", "follow"],
      ["", "", "8443", "same"],
      // An nginx stream in front: config leaves the published port alone.
      ["https://a.example.com:8443", "127.0.0.1:18443", "8443", "same"],
      ["https://a.example.com:8443", "127.0.0.1:18443", "9443", "custom"],
      ["https://a.example.com:8443", "18443", "9443", "custom"],
    ])(
      "config with %s and EDGEWEIR_NODE_API_PORT=%j, new port %s: %s",
      (url, port, next, change) => {
        expect(
          sourced('node_port_change "$OLD_URL" "$OLD_PORT" "$NEW_PORT"', {
            OLD_URL: url,
            OLD_PORT: port,
            NEW_PORT: next,
          }),
        ).toBe(`${change}\n`);
      },
    );
  });
});
