import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
});
