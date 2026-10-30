// Challenge providers G20 end to end (managed challenge and third-party
// CAPTCHA providers, challenge-v3), after G19. Both nodes of the default
// cluster (`node` and `node-upgrade-peer`) serve the sites below and ask the
// g20-captcha mock (docker/e2e/g20-captcha, profile g20) instead of
// Cloudflare's siteverify (EDGEWEIR_CHALLENGE_VERIFY_ENDPOINTS in
// compose.e2e.yml). The host reaches `node` through its published port, so
// the node sees every request below from the default network's gateway.
//   a. headless Chromium without automation signals (no --enable-automation,
//      AutomationControlled off, a desktop User-Agent) passes the managed
//      challenge of an Under Attack site (managed.g20.test -> whoami) without
//      interaction: 403 managed -> POST verify with s=0 -> 303 -> 200 from
//      whoami, an HttpOnly __ew_pass of level 3; managed_challenge and
//      js_challenge rules challenge their paths only (403 managed, 403 pow)
//      and the browser's level-3 pass satisfies both
//   b. managed -> interactive: User-Agents of automation tools (curl/,
//      python-requests) or none get the built-in image captcha (403
//      X-Edgeweir-Challenge: captcha, no provider); a solved managed page
//      posted with s=1 gets it instead of a pass, with s=0 a level-3 pass;
//      after four managed pages without a pass the fifth is interactive
//   c. provider.g20.test: Under Attack managed with the site's own Turnstile
//      provider (fake secret); a wrong managed answer from the host's /24
//      makes even a browser User-Agent interactive there; curl gets the
//      provider page (X-Edgeweir-Challenge-Provider: turnstile, the widget
//      script, CSP allowing challenges.cloudflare.com, the built-in form);
//      p_token=bad and other-host (hostname-mismatch) fail with the error on
//      the page, p_token=good passes at level 4 (the mock saw the saved
//      secret, the token and the client's address); alt=builtin serves the
//      built-in captcha without asking the mock; the secret is in no API
//      answer or audit entry
//   d. fallback: the mock answering 500 serves the built-in captcha for the
//      good token and marks the provider down (the next page is the
//      built-in captcha, without asking the mock); a wrong saved secret
//      (invalid-input-secret) does the same once the provider is back after
//      60 s; the node logs the provider unavailable; the outcomes (managed
//      issued / passed / escalated, turnstile issued / passed / failed /
//      fallback, captcha and pow issued) reach /analytics/dimensions
// Everything is cleaned up; `node scripts/e2e-g20.mjs --cleanup` removes
// sites an aborted run left.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { actor, pass, stack, waitFor } from "./e2e-lib.mjs";

const { chromium } = createRequire(resolve("apps/console/package.json"))("@playwright/test");
const edgePort = Number(process.env.E2E_NODE_PORT ?? 18080);
const { compose, run, nodeIn } = stack({ profiles: ["upgrades", "g20"] });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const HOST_MANAGED = "managed.g20.test";
/** docker/e2e/g20-captcha/server.mjs answers good tokens for this host name. */
const HOST_PROVIDER = "provider.g20.test";
const SITES = { managed: "g20-managed", provider: "g20-provider" };
/** A desktop Chrome without HeadlessChrome or any fragment of challenge.lua's AUTOMATION. */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 edgeweir-e2e-g20";
const CURL_UA = "curl/8.10.1";
const PYTHON_UA = "python-requests/2.32.3";
const POW_BITS = 12;
/** Managed pages a client network may get without passing (challenge.lua MANAGED_LOOP). */
const MANAGED_LOOP = 4;
/** Seconds a provider stays down on a node (challenge.lua PROVIDER_DOWN). */
const PROVIDER_DOWN = 60;
/** Fake values (push protection refuses key-shaped ones); the mock knows SECRET. */
const SITE_KEY = "g20-e2e-sitekey";
const SECRET = "fake-turnstile-secret-e2e";
const WRONG_SECRET = "fake-turnstile-secret-wrong";
const VERIFY = "/.edgeweir/challenge/verify";
/** challenge.lua's managed signals, computed as the page computes them. */
const SIGNALS = () => {
  const n = navigator;
  let s = 0;
  if (n.webdriver) s |= 1;
  if (!n.languages || !n.languages.length) s |= 2;
  if (/HeadlessChrome|PhantomJS/.test(n.userAgent)) s |= 4;
  if (!screen.width || !screen.height) s |= 8;
  return s;
};

/** A request from the host to the edge node's HTTP port: { status, headers, body }. */
function edge(host, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: edgePort,
        path,
        method,
        headers: { host, ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("edge timeout")));
    req.end(body);
  });
}
const challengeOf = (r) => r.headers["x-edgeweir-challenge"] ?? null;
const providerOf = (r) => r.headers["x-edgeweir-challenge-provider"] ?? null;
const passCookie = (r) =>
  [r.headers["set-cookie"] ?? []]
    .flat()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("__ew_pass="))
    ?.slice("__ew_pass=".length) ?? null;
const prefix24 = (ip) => ip.split(".").slice(0, 3).join(".");

/** Fields of a pass cookie value (v1.<kid>.<payload>.<signature>). */
function passFields(value) {
  const [version, kid, payload, signature] = value.split(".");
  const [site, level, prefix, ua, iat, exp] = Buffer.from(payload, "base64url")
    .toString("utf8")
    .split("|");
  return {
    version,
    kid,
    payload,
    signature,
    site,
    level: Number(level),
    prefix,
    ua,
    iat: Number(iat),
    exp: Number(exp),
  };
}

/** Leading zero bits of a digest (challenge.lua leading_zero_bits). */
function zeroBits(digest) {
  let bits = 0;
  for (const b of digest) {
    if (b !== 0) return bits + Math.clz32(b) - 24;
    bits += 8;
  }
  return bits;
}
const powBits = (token, n) => zeroBits(createHash("sha256").update(`${token}:${n}`).digest());
/** The first answer the node accepts (pow_ok: sha256(token:n) with `bits` leading zero bits). */
function solvePow(token, bits) {
  for (let n = 0; ; n++) if (powBits(token, n) >= bits) return String(n);
}
/** An answer the node refuses. */
function wrongPow(token, bits) {
  for (let n = 0; ; n++) if (powBits(token, n) < bits) return String(n);
}

/** POST /.edgeweir/challenge/verify with the form fields. */
const verify = (host, ua, fields) =>
  edge(host, VERIFY, {
    method: "POST",
    headers: { "user-agent": ua, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

/** The token and difficulty of a managed page (403 managed with the signals field s). */
function managedForm(page, what) {
  assert.equal(page.status, 403, `${what}: ${page.status} ${page.body.slice(0, 200)}`);
  assert.equal(challengeOf(page), "managed", what);
  const token = /name="t" value="([^"]+)"/.exec(page.body)?.[1];
  const bits = Number(/data-d="(\d+)"/.exec(page.body)?.[1]);
  assert.ok(token, `${what}: no token on the managed page`);
  assert.equal(bits, POW_BITS, `${what}: difficulty`);
  assert.ok(page.body.includes('name="s" value=""'), `${what}: no signals field`);
  return { token, bits };
}

/** Opens a managed page from the host and posts its solved proof of work with the signals. */
async function solveManaged(host, path, ua, signals) {
  const page = await edge(host, path, { headers: { "user-agent": ua } });
  const { token, bits } = managedForm(page, `${host}${path} (${ua})`);
  const verified = await verify(host, ua, {
    t: token,
    a: solvePow(token, bits),
    r: path,
    s: String(signals),
  });
  return { page, token, verified };
}

/** Asserts the built-in image captcha (the interactive challenge without a provider). */
function builtinCaptcha(r, what) {
  assert.equal(r.status, 403, `${what}: ${r.status} ${r.body.slice(0, 200)}`);
  assert.equal(challengeOf(r), "captcha", what);
  assert.equal(providerOf(r), null, `${what}: a provider page`);
  assert.ok(r.body.includes('<img src="data:image/png;base64,'), `${what}: no captcha image`);
  assert.ok(r.body.includes('name="alt" value="pow"'), `${what}: no proof-of-work alternative`);
  assert.ok(!r.body.includes("challenges.cloudflare.com"), `${what}: the widget's script`);
  assert.equal(passCookie(r), null, `${what}: a pass`);
}

/** Asserts the Turnstile provider page; returns its token. */
function providerPage(r, what) {
  assert.equal(r.status, 403, `${what}: ${r.status} ${r.body.slice(0, 200)}`);
  assert.equal(challengeOf(r), "captcha", what);
  assert.equal(providerOf(r), "turnstile", what);
  const token = /name="t" value="([^"]+)"/.exec(r.body)?.[1];
  assert.ok(token, `${what}: no token on the provider page`);
  return token;
}

// Runs in client-a and asks the g20-captcha mock: stdin {path, body?}
// (POST with a JSON body, GET without), stdout the answer.
const MOCK = `
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  const { path, body } = JSON.parse(input);
  const r = await fetch("http://g20-captcha:8080" + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  process.stdout.write(await r.text());
});`;
const mock = async (path, body) =>
  JSON.parse(await nodeIn("client-a", MOCK, JSON.stringify({ path, body })));
const mockSeen = () => mock("/_seen");
const mockMode = (mode) => mock("/_mode", { mode });

// ---------------------------------------------------------------- setup
const upgrade = JSON.parse(await readFile(".e2e/m6-upgrade-state.json", "utf8"));
const admin = await actor("admin@e2e.test", "e2e-admin-password-123", "g20-e2e");
const clusterId = upgrade.clusterId;
const edgeId = upgrade.nodeId;
const peerId = upgrade.peerId;
const nodeById = (id) => admin.ok("GET", `/nodes/${id}`);
let lastNodes = [];
/** Waits until `check` holds for both nodes; returns them. */
const everyNode = (label, check, seconds = 120) =>
  waitFor(
    label,
    async () => {
      lastNodes = [await nodeById(edgeId), await nodeById(peerId)];
      return lastNodes.every(check) ? lastNodes : null;
    },
    seconds,
    1000,
    () =>
      JSON.stringify(
        lastNodes.map((n) => ({
          name: n.name,
          online: n.online,
          applied: n.appliedRevision,
          state: n.applyState,
        })),
      ),
  );
/** Waits until both nodes run the cluster's latest revision. */
async function synced(label = "nodes on the latest revision") {
  const latest = (await admin.ok("GET", `/clusters/${clusterId}`)).latestRevision.revision;
  await everyNode(
    `${label} (#${latest})`,
    (n) =>
      n.online && n.dataPlaneHealthy && n.applyState === "applied" && n.appliedRevision >= latest,
  );
  return latest;
}
const protect = (siteId, patch) => admin.ok("PATCH", `/sites/${siteId}/protection`, patch);
const setRules = (siteId, rules) => admin.ok("PUT", `/sites/${siteId}/rules`, { rules });

const findSite = async (domain) =>
  (await admin.ok("GET", `/sites?search=${encodeURIComponent(domain)}&pageSize=100`)).items.find(
    (s) => s.domains.includes(domain),
  );
/** Deletes the G20 sites (an earlier run's too); returns how many there were. */
async function cleanup() {
  let removed = 0;
  for (const domain of [HOST_MANAGED, HOST_PROVIDER]) {
    const site = await findSite(domain);
    if (site) {
      await admin.ok("DELETE", `/sites/${site.id}`);
      removed++;
    }
  }
  return removed;
}
if (process.argv.includes("--cleanup")) {
  const removed = await cleanup();
  if (removed) await synced("G20 sites removed");
  console.log(`G20 cleanup: ${removed} site(s)`);
  process.exit(0);
}

/** Creates a site in the default cluster (after deleting one left by an earlier run). */
async function createSite(name, domain, origin) {
  const old = await findSite(domain);
  if (old) await admin.ok("DELETE", `/sites/${old.id}`);
  const { site } = await admin.ok("POST", "/sites", {
    name,
    clusterId,
    domains: [domain],
    origins: [{ address: origin }],
  });
  return site;
}

await everyNode(
  "nodes online with challenge-v3",
  (n) => n.online && n.dataPlaneHealthy && n.supportedFeatures.includes("challenge-v3"),
  180,
);
const siteManaged = await createSite(SITES.managed, HOST_MANAGED, "whoami");
const siteProvider = await createSite(SITES.provider, HOST_PROVIDER, "whoami");
await synced("g20 sites published");
for (const host of [HOST_MANAGED, HOST_PROVIDER])
  await waitFor(`${host} served`, async () => (await edge(host, "/g20-ready")).status === 200, 60);
const seen = /^X-Real-Ip: (.+)$/m.exec((await edge(HOST_MANAGED, "/g20-seen")).body)?.[1]?.trim();
assert.ok(seen, "whoami did not echo X-Real-Ip");
const mockBefore = await mockSeen();
console.log(`the node sees the host as ${seen}; g20-captcha answered ${mockBefore.calls} call(s)`);

let finished = false;
try {
  // -------------------------------------------------------------- a. browser passes managed
  /** Failure bans off: the failures below come from the /24 of client-a and client-b. */
  const noFailureBan = { enabled: false, threshold: 10, banSeconds: 600 };
  const managed = await protect(siteManaged.id, {
    underAttack: true,
    underAttackChallenge: "managed",
    powDifficulty: POW_BITS,
    interactiveProvider: "builtin",
    failureBan: noFailureBan,
  });
  assert.equal(managed.underAttackChallenge, "managed");
  assert.equal(managed.interactiveProvider, "builtin");
  await synced("Under Attack managed published");

  const browser = await chromium.launch({
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-proxy-server",
      "--disable-blink-features=AutomationControlled",
      `--host-resolver-rules=MAP ${HOST_MANAGED} 127.0.0.1`,
    ],
  });
  const origin = `http://${HOST_MANAGED}:${edgePort}`;
  let browserPass;
  try {
    const context = await browser.newContext({ userAgent: BROWSER_UA, locale: "en-US" });
    const page = await context.newPage();
    const signals = await page.evaluate(SIGNALS);
    assert.equal(
      signals,
      0,
      `Chromium shows automation signals ${signals} (1 webdriver, 2 languages, 4 User-Agent, 8 screen)`,
    );
    const responses = [];
    page.on("response", (r) => {
      const url = new URL(r.url());
      responses.push({
        method: r.request().method(),
        path: url.pathname + url.search,
        status: r.status(),
        challenge: r.headers()["x-edgeweir-challenge"] ?? null,
        form: r.request().method() === "POST" ? (r.request().postData() ?? "") : null,
      });
    });
    const path = "/g20-browser?step=managed";
    const url = `${origin}${path}`;
    const final = page.waitForResponse((r) => r.url() === url && r.status() === 200, {
      timeout: 60_000,
    });
    const started = performance.now();
    const first = await page.goto(url);
    assert.equal(first.status(), 403);
    assert.equal(first.headers()["x-edgeweir-challenge"], "managed");
    await final;
    await page.locator("body", { hasText: `GET ${path} ` }).waitFor({ timeout: 30_000 });
    const text = await page.locator("body").innerText();
    assert.match(text, /^Hostname: /m, "the page did not come from whoami");
    const posted = responses.find((r) => r.method === "POST" && r.path === VERIFY);
    assert.equal(posted?.status, 303, JSON.stringify(responses));
    assert.equal(new URLSearchParams(posted.form).get("s"), "0", posted.form);
    const cookie = (await context.cookies(origin)).find((c) => c.name === "__ew_pass");
    assert.ok(cookie, "no __ew_pass after the managed challenge");
    assert.equal(cookie.httpOnly, true);
    browserPass = cookie.value;
    const fields = passFields(browserPass);
    assert.equal(fields.site, siteManaged.id);
    assert.equal(fields.level, 3);
    assert.equal(fields.prefix, `4:${prefix24(seen)}`);
    assert.equal(fields.ua, sha256(BROWSER_UA).slice(0, 16));
    const direct = await page.goto(`${origin}/g20-browser?step=again`);
    assert.equal(direct.status(), 200);
    pass(
      `Chromium without automation signals passed the managed challenge of ${HOST_MANAGED} in ${Math.round(performance.now() - started)} ms without interaction (403 managed -> POST verify s=0 303 -> 200 from whoami) and holds an HttpOnly __ew_pass of level 3; the next page is served directly`,
    );
  } finally {
    await browser.close();
  }

  await protect(siteManaged.id, { underAttack: false });
  await setRules(siteManaged.id, [
    {
      name: "g20 managed",
      phase: "waf-custom",
      enabled: true,
      expression: 'http.request.uri.path eq "/g20-rule-managed"',
      action: { kind: "managed_challenge" },
    },
    {
      name: "g20 js",
      phase: "waf-custom",
      enabled: true,
      expression: 'http.request.uri.path eq "/g20-rule-js"',
      action: { kind: "js_challenge" },
    },
  ]);
  await synced("managed_challenge and js_challenge rules published");
  const browserHeaders = { "user-agent": BROWSER_UA };
  managedForm(
    await edge(HOST_MANAGED, "/g20-rule-managed", { headers: browserHeaders }),
    "managed_challenge rule",
  );
  const jsRule = await edge(HOST_MANAGED, "/g20-rule-js", { headers: browserHeaders });
  assert.equal(jsRule.status, 403);
  assert.equal(challengeOf(jsRule), "pow");
  assert.equal(
    (await edge(HOST_MANAGED, "/g20-free", { headers: browserHeaders })).status,
    200,
    "a path without a rule was challenged",
  );
  for (const path of ["/g20-rule-managed", "/g20-rule-js"]) {
    const r = await edge(HOST_MANAGED, path, {
      headers: { ...browserHeaders, cookie: `__ew_pass=${browserPass}` },
    });
    assert.equal(r.status, 200, `${path} with the browser's pass: ${r.status}`);
  }
  await setRules(siteManaged.id, []);
  await protect(siteManaged.id, { underAttack: true });
  await synced("rules removed, Under Attack managed again");
  pass(
    "a managed_challenge rule answers 403 managed and a js_challenge rule 403 pow on their paths only (/g20-free 200); the browser's level-3 pass satisfies both",
  );

  // -------------------------------------------------------------- b. managed -> interactive
  for (const [what, headers] of [
    [CURL_UA, { "user-agent": CURL_UA }],
    [PYTHON_UA, { "user-agent": PYTHON_UA }],
    ["no User-Agent", {}],
  ])
    builtinCaptcha(await edge(HOST_MANAGED, "/g20-bot", { headers }), what);
  managedForm(
    await edge(HOST_MANAGED, "/g20-bot", { headers: browserHeaders }),
    "the browser User-Agent",
  );

  const flagged = await solveManaged(HOST_MANAGED, "/g20-signals", BROWSER_UA, 1);
  builtinCaptcha(flagged.verified, "a solved managed page posted with s=1");
  const clean = await solveManaged(HOST_MANAGED, "/g20-signals", BROWSER_UA, 0);
  assert.equal(clean.verified.status, 303, clean.verified.body.slice(0, 200));
  assert.equal(clean.verified.headers.location, `http://${HOST_MANAGED}/g20-signals`);
  const cleanPass = passCookie(clean.verified);
  assert.ok(cleanPass, "no pass for s=0");
  assert.equal(passFields(cleanPass).level, 3);

  // The pass above reset the network's managed pages: MANAGED_LOOP more, then interactive.
  for (let i = 1; i <= MANAGED_LOOP; i++)
    managedForm(
      await edge(HOST_MANAGED, `/g20-loop-${i}`, { headers: browserHeaders }),
      `managed page ${i} without a pass`,
    );
  builtinCaptcha(
    await edge(HOST_MANAGED, `/g20-loop-${MANAGED_LOOP + 1}`, { headers: browserHeaders }),
    `page ${MANAGED_LOOP + 1} after ${MANAGED_LOOP} managed pages without a pass`,
  );
  pass(
    `managed -> interactive: ${CURL_UA}, ${PYTHON_UA} and no User-Agent get the built-in captcha (403 X-Edgeweir-Challenge: captcha, image, no provider) while the browser User-Agent gets the managed page; a solved managed page posted with s=1 gets the captcha instead of a pass, with s=0 a level-3 pass; after ${MANAGED_LOOP} managed pages without a pass the next one is the captcha`,
  );

  // -------------------------------------------------------------- c. Turnstile against the mock
  const saved = await protect(siteProvider.id, {
    underAttack: true,
    underAttackChallenge: "managed",
    powDifficulty: POW_BITS,
    interactiveProvider: "site",
    provider: { kind: "turnstile", siteKey: SITE_KEY, secret: { secret: SECRET } },
    failureBan: noFailureBan,
  });
  assert.equal(saved.interactiveProvider, "site");
  assert.equal(saved.provider.kind, "turnstile");
  assert.equal(saved.provider.siteKey, SITE_KEY);
  assert.equal(saved.provider.secretSet, true);
  const read = await admin.raw("GET", `/sites/${siteProvider.id}/protection`);
  assert.ok(!read.text.includes(SECRET), "the provider secret in the API answer");
  const audit = await admin.raw("GET", "/audit-logs?action=site.protection_update");
  assert.equal(audit.status, 200, audit.text);
  assert.ok(!audit.text.includes(SECRET), "the provider secret in the audit log");
  await synced("the Turnstile provider published");

  // A failed answer from the host's /24 makes the site's managed challenge interactive for it.
  const before = await edge(HOST_PROVIDER, "/g20-failed", { headers: browserHeaders });
  const { token: failToken, bits } = managedForm(before, "provider site before a failure");
  const wrong = await verify(HOST_PROVIDER, BROWSER_UA, {
    t: failToken,
    a: wrongPow(failToken, bits),
    r: "/g20-failed",
    s: "0",
  });
  managedForm(wrong, "a wrong managed answer");
  assert.ok(wrong.body.includes('role="alert"'), "a wrong managed answer without an error");
  providerPage(
    await edge(HOST_PROVIDER, "/g20-failed", { headers: browserHeaders }),
    "the browser User-Agent after a failure",
  );

  const curl = { "user-agent": CURL_UA };
  const first = await edge(HOST_PROVIDER, "/g20-provider", { headers: curl });
  providerPage(first, "curl on the provider site");
  assert.match(first.headers["content-security-policy"], /https:\/\/challenges\.cloudflare\.com/);
  assert.ok(first.body.includes("challenges.cloudflare.com/turnstile/v0/api.js"), "no widget");
  assert.ok(first.body.includes(JSON.stringify(SITE_KEY)), "the site key is not on the page");
  assert.ok(first.body.includes('name="alt" value="builtin"'), "no built-in form");
  assert.ok(!first.body.includes(SECRET), "the secret on the page");

  /** Posts a widget answer to a fresh provider page. */
  async function answer(pToken, path = "/g20-provider") {
    const token = providerPage(
      await edge(HOST_PROVIDER, path, { headers: curl }),
      `provider page for ${pToken}`,
    );
    return verify(HOST_PROVIDER, CURL_UA, { t: token, r: path, p_token: pToken });
  }
  for (const pToken of ["bad", "other-host"]) {
    const r = await answer(pToken);
    providerPage(r, `p_token=${pToken}`);
    assert.ok(r.body.includes('role="alert"'), `p_token=${pToken} without the error`);
    assert.equal(passCookie(r), null, `p_token=${pToken} bought a pass`);
  }
  const callsBefore = (await mockSeen()).calls;
  const good = await answer("good");
  assert.equal(good.status, 303, good.body.slice(0, 200));
  assert.equal(good.headers.location, `http://${HOST_PROVIDER}/g20-provider`);
  const goodPass = passCookie(good);
  assert.ok(goodPass, "no pass for p_token=good");
  const goodFields = passFields(goodPass);
  assert.equal(goodFields.site, siteProvider.id);
  assert.equal(goodFields.level, 4);
  assert.equal(goodFields.ua, sha256(CURL_UA).slice(0, 16));
  const asked = await mockSeen();
  assert.equal(asked.calls, callsBefore + 1, JSON.stringify(asked));
  assert.equal(asked.last.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(asked.last.form, { secret: SECRET, response: "good", remoteip: seen });
  const served = await edge(HOST_PROVIDER, "/g20-provider", {
    headers: { ...curl, cookie: `__ew_pass=${goodPass}` },
  });
  assert.equal(served.status, 200);
  assert.ok(served.body.includes("GET /g20-provider "), "not from whoami");

  const altToken = providerPage(
    await edge(HOST_PROVIDER, "/g20-alt", { headers: curl }),
    "provider page for alt=builtin",
  );
  builtinCaptcha(
    await verify(HOST_PROVIDER, CURL_UA, { t: altToken, r: "/g20-alt", alt: "builtin" }),
    "alt=builtin",
  );
  assert.equal((await mockSeen()).calls, asked.calls, "alt=builtin asked the provider");
  pass(
    `Turnstile on ${HOST_PROVIDER} (site key ${SITE_KEY}, fake secret, verified by the agent at g20-captcha): after a wrong managed answer the browser User-Agent gets the provider page too; curl gets it with X-Edgeweir-Challenge-Provider: turnstile, the widget script, the CSP for challenges.cloudflare.com and the built-in form; bad and other-host fail with the error on the page, good passes (303, level 4, whoami 200) and the mock saw the saved secret, the token and ${seen}; alt=builtin serves the built-in captcha without asking the mock; the secret is in no API answer, audit entry or page`,
  );

  // -------------------------------------------------------------- d. fallback to the built-in captcha
  const logsSince = new Date().toISOString();
  await mockMode("500");
  const failing = await answer("good", "/g20-fallback");
  builtinCaptcha(failing, "p_token=good while the mock answers 500");
  const failed = await mockSeen();
  assert.ok(failed.calls > asked.calls, "the agent did not ask the failing mock");
  await mockMode("ok");
  builtinCaptcha(
    await edge(HOST_PROVIDER, "/g20-fallback", { headers: curl }),
    "the next page while the provider is down",
  );
  assert.equal((await mockSeen()).calls, failed.calls, "a page asked the provider");

  await protect(siteProvider.id, {
    provider: { kind: "turnstile", siteKey: SITE_KEY, secret: { secret: WRONG_SECRET } },
  });
  await synced("a wrong provider secret published");
  const downAt = Date.now();
  await waitFor(
    `the provider page back after ${PROVIDER_DOWN} s`,
    async () => {
      const r = await edge(HOST_PROVIDER, "/g20-fallback", { headers: curl });
      return providerOf(r) === "turnstile";
    },
    PROVIDER_DOWN + 30,
    5000,
  );
  const backAfter = Math.round((Date.now() - downAt) / 1000);
  builtinCaptcha(
    await answer("good", "/g20-fallback"),
    "p_token=good with a secret the provider refuses",
  );
  const refused = await mockSeen();
  assert.equal(refused.last.form.secret, WRONG_SECRET, JSON.stringify(refused.last));
  builtinCaptcha(
    await edge(HOST_PROVIDER, "/g20-fallback", { headers: curl }),
    "the next page after invalid-input-secret",
  );
  const warnings = await waitFor(
    "the node logs the provider unavailable",
    async () => {
      const lines = (await run([...compose, "logs", "--since", logsSince, "node"]))
        .split("\n")
        .filter((l) => l.includes("challenge provider unavailable"));
      return lines.some((l) => l.includes("status 500")) &&
        lines.some((l) => l.includes("invalid-input-secret"))
        ? lines
        : null;
    },
    30,
  );
  pass(
    `fallback: the mock answering 500 serves the built-in captcha for the good token and the next page is the built-in captcha without asking the mock; the provider page is back ${backAfter} s after the change (down for ${PROVIDER_DOWN} s), and a secret the mock refuses (invalid-input-secret, the new secret version reached the agent) falls back the same way; ${warnings.length} warning(s) in the node's log`,
  );

  /** Each kind's outcomes of a site in the last hour. */
  const outcomes = async (siteId) =>
    Object.fromEntries(
      (
        await admin.ok("GET", `/analytics/dimensions?range=1h&siteId=${siteId}`)
      ).challenges.byKind.map(({ kind, ...counts }) => [kind, counts]),
    );
  /** Minimum counts each site should reach, by kind and outcome. */
  const want = {
    [siteManaged.id]: {
      managed: { issued: 8, passed: 2, escalated: 5 },
      captcha: { issued: 5 },
      pow: { issued: 1 },
    },
    [siteProvider.id]: {
      managed: { issued: 1, failed: 1, escalated: 8 },
      turnstile: { issued: 8, passed: 1, failed: 2, fallback: 4 },
      captcha: { issued: 4 },
    },
  };
  const got = {};
  await waitFor(
    "the challenge outcomes in the statistics",
    async () => {
      for (const siteId of Object.keys(want)) got[siteId] = await outcomes(siteId);
      return Object.entries(want).every(([siteId, kinds]) =>
        Object.entries(kinds).every(([kind, counts]) =>
          Object.entries(counts).every(([what, n]) => (got[siteId][kind]?.[what] ?? 0) >= n),
        ),
      );
    },
    120,
    5000,
    () => JSON.stringify(got),
  );
  const show = (siteId) =>
    Object.entries(got[siteId])
      .map(
        ([kind, c]) =>
          `${kind} ${Object.entries(c)
            .map(([k, v]) => `${k} ${v}`)
            .join("/")}`,
      )
      .join(", ");
  pass(
    `outcomes in /analytics/dimensions: ${SITES.managed}: ${show(siteManaged.id)}; ${SITES.provider}: ${show(siteProvider.id)}`,
  );

  // -------------------------------------------------------------- cleanup
  await admin.ok("DELETE", `/sites/${siteManaged.id}`);
  await admin.ok("DELETE", `/sites/${siteProvider.id}`);
  await synced("g20 sites deleted");
  for (const host of [HOST_MANAGED, HOST_PROVIDER])
    assert.equal((await edge(host, "/", { headers: curl })).status, 404, `${host} still served`);
  for (const siteId of [siteManaged.id, siteProvider.id])
    assert.equal((await admin.ok("GET", `/bans?siteId=${siteId}`)).total, 0, "a failure ban");
  pass(`cleaned up: ${SITES.managed} and ${SITES.provider} deleted (with the provider), no bans`);
  finished = true;
} finally {
  if (!finished) {
    await mockMode("ok").catch((e) => console.error(`cleanup: ${e.message}`));
    await cleanup().catch((e) => console.error(`cleanup: ${e.message}`));
  }
}
console.log("G20 E2E OK");
