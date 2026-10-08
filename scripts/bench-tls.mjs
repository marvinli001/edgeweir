// TLS handshakes without connection reuse for scripts/bench.sh
// (BENCH_SCENARIO=tls and tls-resume). Every request opens a new TLS
// connection to BENCH_URL (https) with BENCH_HOST as SNI and Host, sends one
// GET with Connection: close and reads the answer. tls never offers a
// session, so each connection is a full handshake; tls-resume offers the
// session of the loop's previous connection (TLS 1.2 session ID or ticket,
// TLS 1.3 ticket). oha cannot do the first: rustls resumes sessions itself.
//
// BENCH_CONCURRENCY loops share BENCH_REQUESTS across worker processes (one
// per core at most). Writes BENCH_OUTPUT in oha's JSON shape (summary,
// latencyPercentiles in seconds, statusCodeDistribution) plus the handshake
// counts, and fails when a tls connection was resumed or fewer than 90% of
// the tls-resume connections were.
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import tls from "node:tls";

const url = new URL(process.env.BENCH_URL);
const host = process.env.BENCH_HOST;
const resume = process.env.BENCH_SCENARIO === "tls-resume";
const maxVersion = process.env.BENCH_TLS_VERSION === "1.2" ? "TLSv1.2" : "TLSv1.3";

/** One connection: resolves status, X-Cache, latency (ms), reused and the session to offer next. */
function once(session) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let next = session;
    const chunks = [];
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: host,
      rejectUnauthorized: false,
      maxVersion,
      ALPNProtocols: ["http/1.1"],
      session: resume ? session : undefined,
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("timeout")));
    if (resume) socket.on("session", (s) => (next = s));
    socket.on("secureConnect", () =>
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", (error) =>
      resolve({ status: 0, error: error.code ?? error.message, ms: 0, reused: false, next }),
    );
    socket.on("end", () => {
      const head = Buffer.concat(chunks).toString("latin1").split("\r\n\r\n", 1)[0];
      resolve({
        status: Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0),
        cache: head.match(/^x-cache: *(\S+)/im)?.[1] ?? "",
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        reused: socket.isSessionReused(),
        version: socket.getProtocol(),
        next,
      });
    });
  });
}

if (process.argv[2] === "worker") {
  const [loops, requests] = process.argv.slice(3).map(Number);
  const latencies = [];
  const statuses = {};
  const errors = {};
  let reused = 0;
  let hits = 0;
  const versions = {};
  let left = requests;
  await Promise.all(
    Array.from({ length: loops }, async () => {
      let session;
      while (left > 0) {
        left--;
        const r = await once(session);
        session = r.next;
        if (r.status === 0) {
          errors[r.error] = (errors[r.error] ?? 0) + 1;
          continue;
        }
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        latencies.push(r.ms);
        if (r.reused) reused++;
        if (r.cache.toUpperCase() === "HIT") hits++;
        versions[r.version] = (versions[r.version] ?? 0) + 1;
      }
    }),
  );
  process.send({ latencies, statuses, errors, reused, hits, versions });
} else {
  const total = Number(process.env.BENCH_REQUESTS);
  const concurrency = Number(process.env.BENCH_CONCURRENCY);
  // Warm the cache (and check the site answers) before measuring.
  for (let i = 0; i < 2; i++) await once();
  const warm = await once();
  if (warm.status !== 200 || warm.cache.toUpperCase() !== "HIT") {
    console.error(
      `Refusing to benchmark: ${host} at ${url.origin} answers ${warm.status} ${warm.error ?? ""} X-Cache ${warm.cache || "-"}, not a cache HIT.`,
    );
    process.exit(1);
  }
  const workers = Math.max(1, Math.min(concurrency, availableParallelism()));
  const started = process.hrtime.bigint();
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const loops = Math.floor(concurrency / workers) + (i < concurrency % workers ? 1 : 0);
      const requests = Math.floor(total / workers) + (i < total % workers ? 1 : 0);
      return new Promise((resolve, reject) => {
        const child = fork(new URL(import.meta.url).pathname, ["worker", loops, requests]);
        child.on("message", resolve);
        child.on("error", reject);
        child.on("exit", (code) => code && reject(new Error(`worker exited ${code}`)));
      });
    }),
  );
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const latencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const sum = (key) =>
    results.reduce((all, r) => {
      for (const [k, v] of Object.entries(r[key])) all[k] = (all[k] ?? 0) + v;
      return all;
    }, {});
  const statusCodeDistribution = sum("statuses");
  const errorDistribution = sum("errors");
  const answered = latencies.length;
  const reused = results.reduce((n, r) => n + r.reused, 0);
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const percentile = (p) =>
    answered ? latencies[Math.min(answered - 1, Math.floor((p / 100) * answered))] / 1000 : null;
  const report = {
    summary: {
      successRate: answered / total,
      total: seconds,
      requestsPerSec: total / seconds,
    },
    latencyPercentiles: { p50: percentile(50), p90: percentile(90), p99: percentile(99) },
    statusCodeDistribution,
    errorDistribution,
    tls: {
      scenario: resume ? "tls-resume" : "tls",
      maxVersion,
      workers,
      handshakes: answered,
      reused,
      full: answered - reused,
      cacheHits: hits,
      versions: sum("versions"),
    },
  };
  writeFileSync(process.env.BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.tls));
  if (!resume && reused > 0) {
    console.error(`${reused} connection(s) were resumed: not a full handshake each.`);
    process.exitCode = 1;
  }
  if (resume && reused < answered * 0.9) {
    console.error(`only ${reused} of ${answered} connections were resumed.`);
    process.exitCode = 1;
  }
}
