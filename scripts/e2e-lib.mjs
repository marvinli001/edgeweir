// Helpers the E2E stories share: the console's address, waiting, the
// compose stack's containers and the /api/v1 operator.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { rpc, signInResponse } from "./e2e-auth.mjs";

export const execute = promisify(execFile);
export const base = `http://localhost:${process.env.E2E_CONSOLE_PORT ?? 13000}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pass = (message) => console.log(`PASS ${message}`);

/**
 * Polls `fn` every `interval` ms until it returns something truthy, for at
 * most `seconds`; the timeout names `label` and what `detail` says last.
 */
export async function waitFor(label, fn, seconds = 180, interval = 1000, detail = () => "") {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(interval);
  }
  const why = await detail();
  throw new Error(`timeout: ${label}${why ? ` (last: ${why})` : ""}`);
}

/**
 * The compose stack with `profiles`: `run` is docker with `maxBuffer` of
 * output (or the story's own `run`); `nodeIn` runs a node script in a
 * service with `input` on stdin; `psql` queries the console's database.
 */
export function stack({ profiles = [], maxBuffer = 8 * 1024 * 1024, run } = {}) {
  const compose = [
    "compose",
    "-f",
    "compose.e2e.yml",
    ...profiles.flatMap((p) => ["--profile", p]),
  ];
  run ??= async (args, opts = {}) => (await execute("docker", args, { maxBuffer, ...opts })).stdout;
  const containerId = async (service) => {
    const id = (await run([...compose, "ps", "-q", service])).trim();
    assert.ok(id, `${service} is not running`);
    return id;
  };
  async function nodeIn(service, script, input) {
    const id = await containerId(service);
    return new Promise((resolvePromise, reject) => {
      const child = spawn("docker", ["exec", "-i", id, "node", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolvePromise(Buffer.concat(out).toString("utf8"))
          : reject(new Error(`${service}: ${Buffer.concat(err).toString("utf8")}`)),
      );
      child.stdin.end(input ?? "");
    });
  }
  async function psql(query) {
    return (
      await run([
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "edgeweir",
        "-d",
        "edgeweir",
        "-At",
        "-c",
        query,
      ])
    ).trim();
  }
  return { compose, run, containerId, nodeIn, psql };
}

/** Raw /api/v1 call: { status, headers, json, text }. */
export async function call(key, method, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) : null,
  };
}

/**
 * The signed-in operator with an AccessKey named `keyName`. An AccessKey
 * allows 600 requests until it has been idle for 60 seconds; stories that
 * poll longer than that move to a fresh key every `rotateEvery` calls (0:
 * never).
 */
export async function actor(email, password, keyName, { rotateEvery = 500 } = {}) {
  const response = await waitFor(
    `sign in ${email}`,
    async () => {
      const r = await signInResponse(base, email, password);
      return r.status === 200 ? r : null;
    },
    60,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const createKey = async () =>
    (await rpc(base, cookie, "accessKeys/create", { name: keyName })).key;
  const user = { cookie, key: await createKey() };
  let calls = 0;
  user.raw = async (method, path, body) => {
    if (rotateEvery && ++calls % rotateEvery === 0) user.key = await createKey();
    return call(user.key, method, path, body);
  };
  user.ok = async (method, path, body) => {
    const result = await user.raw(method, path, body);
    assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${result.text}`);
    return result.json;
  };
  return user;
}
