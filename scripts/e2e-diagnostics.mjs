// Node diagnostics (ADR-0053) of the core node edge-e2e-1, which runs
// `edgeweir-node supervise --manage-nginx` as the image's user edgeweir:
//   a. its heartbeats carry the clock offset it measured against the
//      console's console_time: the node shows an offset within ±2 s, not
//      skewed (both containers run on the VM's clock), measured recently
//   b. `edgeweir-node diagnose` passes every check (identity, certificate,
//      console, agent, configuration, data plane, clock); `--json` names the
//      node and a revision the console showed as applied around it
//   c. `edgeweir-node pprof` writes gzipped heap and 1 s CPU profiles from
//      the agent's diagnostics socket; an unknown profile is refused
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revokeAccessKey, signInWithAccessKey } from "./e2e-auth.mjs";
import { base, pass, sleep } from "./e2e-lib.mjs";

const execute = promisify(execFile);
const compose = ["compose", "-f", "compose.e2e.yml"];
const NODE = "edge-e2e-1";

/** Runs a command in the node container: its exit code and output. */
async function inNode(...args) {
  try {
    const { stdout, stderr } = await execute(
      "docker",
      [...compose, "exec", "-T", "node", ...args],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const session = await signInWithAccessKey(
  base,
  "admin@e2e.test",
  "e2e-admin-password-123",
  "diagnostics-e2e",
);
const api = async (path) => {
  const r = await fetch(`${base}/api/v1${path}`, { headers: { "x-api-key": session.key } });
  assert.equal(r.status, 200, `GET ${path}: ${r.status}`);
  return r.json();
};

// a. The offset arrives with the second heartbeat after a start (the first
//    measures it); the core node has been running for minutes.
let node;
for (let i = 0; i < 60; i++) {
  node = (await api("/nodes")).find((n) => n.name === NODE);
  if (node?.clock) break;
  await sleep(1000);
}
assert.ok(node?.clock, `${NODE} reports no clock offset: ${JSON.stringify(node?.clock)}`);
assert.ok(Math.abs(node.clock.offsetMs) < 2000, `offset ${node.clock.offsetMs} ms`);
assert.equal(node.clock.skewed, false);
assert.ok(
  Date.now() - Date.parse(node.clock.measuredAt) < 60_000,
  `measured ${node.clock.measuredAt}`,
);
pass(`a. ${NODE} reports a clock offset of ${node.clock.offsetMs} ms, not skewed`);

// b. diagnose, as the image's user (the agent's).
const text = await inNode("edgeweir-node", "diagnose");
assert.equal(text.code, 0, `diagnose exited ${text.code}:\n${text.stdout}${text.stderr}`);
const lines = text.stdout.trim().split("\n");
const names = lines.map((l) => l.slice(6, 20).trim());
assert.deepEqual(names, [
  "identity",
  "certificate",
  "console",
  "agent",
  "configuration",
  "data plane",
  "clock",
]);
for (const l of lines) assert.ok(l.startsWith("ok "), `not ok: ${l}`);
const json = await inNode("edgeweir-node", "diagnose", "--json");
assert.equal(json.code, 0, json.stderr);
const report = JSON.parse(json.stdout);
assert.equal(report.agent.node_id, node.id);
// The earlier sections' cleanups may still be rolling out: the revision the
// agent applied lies between the console's view before and after diagnose.
const applied = report.agent.config.applied_revision;
const after = (await api("/nodes")).find((n) => n.name === NODE);
assert.ok(
  applied >= node.appliedRevision && applied <= after.appliedRevision,
  `applied ${applied}, console ${node.appliedRevision}..${after.appliedRevision}`,
);
assert.equal(report.agent.config.state, "applied");
assert.ok(report.agent.clock && Math.abs(report.agent.clock.offset_millis) < 2000);
pass(`b. diagnose: ${lines.length} checks ok, revision ${applied} applied`);

// c. Profiles from the diagnostics socket.
for (const [profile, extra] of [
  ["heap", []],
  ["profile", ["--seconds", "1"]],
]) {
  const out = `/tmp/e2e-${profile}.pb.gz`;
  const r = await inNode("edgeweir-node", "pprof", profile, ...extra, "--output", out);
  assert.equal(r.code, 0, `pprof ${profile}: ${r.stderr}`);
  const magic = await inNode("sh", "-c", `od -An -tx1 -N2 ${out} && rm -f ${out}`);
  assert.equal(magic.stdout.trim(), "1f 8b", `${profile} is not gzipped: ${magic.stdout}`);
}
const unknown = await inNode("edgeweir-node", "pprof", "cmdline", "--output", "/tmp/e2e-x");
assert.notEqual(unknown.code, 0);
assert.match(unknown.stderr, /unknown profile/);
pass("c. pprof: heap and CPU profiles from the diagnostics socket; an unknown profile refused");

await revokeAccessKey(base, session);
