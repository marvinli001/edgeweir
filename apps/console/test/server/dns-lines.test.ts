import { createHash } from "node:crypto";
import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import {
  bindingPolicy,
  compileBindingPlan,
  loadBinding,
  reconcileDns,
} from "../../src/server/services/dns";
import { latestRevision } from "../../src/server/services/revisions";
import { dnsFixture, resolve } from "./dns-fixture";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Resolution lines (ADR-0029 §4) and backup node groups (§5) of a cluster's
// DNS binding, written through the fake certd.

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

describe("DNS resolution lines and backup groups", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const zone = "l.test";
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let providerId = "";
  const groups = { main: "", tel: "", spare: "", reserve: "" };
  const nodes: Record<string, string> = {};

  const addNode = async (groupId: string, name: string, address: string, cluster = clusterId) => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId: cluster, nodeGroupId: groupId, name, lastSeenAt: new Date() })
      .returning();
    if (!node) throw new Error("node missing");
    await ctx.db.insert(schema.nodeIp).values({ nodeId: node.id, address });
    const revision = await latestRevision(ctx.db, cluster);
    if (!revision) throw new Error("revision missing");
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId: node.id,
      appliedRevision: revision.revision,
      appliedContentHash: revision.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    });
    nodes[name] = node.id;
  };
  /** Offline nodes leave DNS; back online they return. */
  const online = (names: string[], up: boolean) =>
    Promise.all(
      names.map((name) =>
        ctx.db
          .update(schema.node)
          .set({ lastSeenAt: up ? new Date() : new Date(Date.now() - 600_000) })
          .where(eq(schema.node.id, nodes[name] ?? "")),
      ),
    );
  const records = () => dnsFixture.records("token-l", zone).filter((r) => r.type !== "TXT");
  const at = (line = "") => resolve(records(), zone, `${siteId}.edge.${zone}`, 0, line);
  const allOn = (line?: string) =>
    records()
      .filter(
        (r) =>
          r.name === "all.edge" &&
          (line ? r.line === line : !r.line || r.line === "default") &&
          (r.type === "A" || r.type === "AAAA"),
      )
      .map((r) => r.data)
      .sort();
  const line = (
    name: string,
    nodeGroupId: string,
    extra: {
      resolutionLine?: "default" | "telecom" | "unicom" | "mobile" | "edu" | "overseas";
      backupNodeGroupIds?: string[];
      minHealthyIps?: number;
    } = {},
  ) => ({ name, nodeGroupId, overrides: [], ...extra });
  const save = (lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
    admin.dns.saveBinding({
      clusterId,
      binding: { mode: "auto", providerId, domain: `edge.${zone}`, ttl: 60, lines, ...extra },
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-l", { zones: [zone] });
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    groups.main = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    for (const name of ["tel", "spare", "reserve"] as const)
      groups[name] = (await admin.nodeGroups.create({ clusterId, name })).id;
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.lines.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    await addNode(groups.main, "m1", "8.8.1.1");
    await addNode(groups.main, "m2", "8.8.1.2");
    await addNode(groups.tel, "t1", "8.8.2.1");
    await addNode(groups.spare, "s1", "8.8.3.1");
    await addNode(groups.reserve, "r1", "8.8.4.1");
    await addNode(groups.reserve, "r2", "8.8.4.2");
    providerId = (
      await admin.dns.createProvider({
        name: "Lines",
        provider: "test",
        zone,
        credentials: { api_token: "token-l" },
      })
    ).id;
  });
  afterAll(() => db.close());

  it("answers each resolution line with its binding lines and keeps names and CNAMEs on the default line", async () => {
    await save([
      line("main", groups.main),
      line("tel", groups.tel, { resolutionLine: "telecom", backupNodeGroupIds: [groups.spare] }),
    ]);
    await reconcileDns(ctx);
    // The default line has the lines mapped to it; telecom resolvers get the telecom line.
    expect(allOn()).toEqual(["8.8.1.1", "8.8.1.2"]);
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
    expect(at()).toEqual(["8.8.1.1", "8.8.1.2"]);
    expect(at("telecom")).toEqual(["8.8.2.1"]);
    // Lines without records fall back to the default line.
    expect(at("unicom")).toEqual(["8.8.1.1", "8.8.1.2"]);
    // <line>.<domain> and the site CNAME exist on the default line only.
    for (const r of records().filter((r) => r.name !== "all.edge")) expect(r.line ?? "").toBe("");
    expect(resolve(records(), zone, `tel.edge.${zone}`)).toEqual(["8.8.2.1"]);
    // One dns.set call carries the name and type on every line (it replaces all lines).
    const set = dnsFixture.calls.filter((c) => c.command === "dns.set");
    const allA = set.filter((c) => c.records?.some((r) => r.name === "all.edge" && r.type === "A"));
    expect(allA).toHaveLength(1);
    expect(new Set(allA[0]?.records?.map((r) => r.line ?? "default"))).toEqual(
      new Set(["default", "telecom"]),
    );
    const state = await admin.dns.binding({ clusterId });
    expect(state.applied).toBe(true);
    expect(state.binding.lines[1]).toMatchObject({
      resolutionLine: "telecom",
      backupNodeGroupIds: [groups.spare],
      minHealthyIps: 1,
    });
    expect(state.records.filter((r) => r.line === "telecom")).toHaveLength(1);
  });

  it("puts every line on the default line when no binding line maps to it, and moves a line", async () => {
    await save([
      line("main", groups.main, { resolutionLine: "unicom" }),
      line("tel", groups.tel, { resolutionLine: "telecom" }),
    ]);
    await reconcileDns(ctx);
    expect(allOn()).toEqual(["8.8.1.1", "8.8.1.2", "8.8.2.1"]);
    expect(allOn("unicom")).toEqual(["8.8.1.1", "8.8.1.2"]);
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
    // A resolution line no binding line uses any more loses its records.
    await save([line("main", groups.main), line("tel", groups.tel, { resolutionLine: "mobile" })]);
    await reconcileDns(ctx);
    expect(allOn("telecom")).toEqual([]);
    expect(allOn("unicom")).toEqual([]);
    expect(allOn("mobile")).toEqual(["8.8.2.1"]);
    expect(allOn()).toEqual(["8.8.1.1", "8.8.1.2"]);
  });

  it("switches a line to the first backup group with enough healthy addresses, then back", async () => {
    await save([
      line("main", groups.main),
      line("tel", groups.tel, {
        resolutionLine: "telecom",
        backupNodeGroupIds: [groups.spare, groups.reserve],
        minHealthyIps: 2,
      }),
    ]);
    await reconcileDns(ctx);
    // The group has 1 healthy address, the first backup 1, the second 2.
    expect(allOn("telecom")).toEqual(["8.8.4.1", "8.8.4.2"]);
    expect(resolve(records(), zone, `tel.edge.${zone}`)).toEqual(["8.8.4.1", "8.8.4.2"]);
    // The default line is not affected.
    expect(allOn()).toEqual(["8.8.1.1", "8.8.1.2"]);
    // No backup group has enough: every still-healthy address of the line's groups.
    await online(["r2"], false);
    await reconcileDns(ctx);
    expect(allOn("telecom")).toEqual(["8.8.2.1", "8.8.3.1", "8.8.4.1"]);
    await online(["r2"], true);
    await save([
      line("main", groups.main),
      line("tel", groups.tel, {
        resolutionLine: "telecom",
        backupNodeGroupIds: [groups.spare, groups.reserve],
      }),
    ]);
    await reconcileDns(ctx);
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
    // The group fails: the first backup takes over, until the group is back.
    await online(["t1"], false);
    await reconcileDns(ctx);
    expect(allOn("telecom")).toEqual(["8.8.3.1"]);
    const reasons = (await admin.dns.bindingRevisions({ clusterId })).map((r) => r.reason);
    expect(reasons[0]).toBe("health");
    await online(["t1"], true);
    await reconcileDns(ctx);
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
  });

  it("holds the records back when a line and all of its backup groups fail", async () => {
    await online(["t1", "s1", "r1", "r2"], false);
    await reconcileDns(ctx);
    const state = await admin.dns.binding({ clusterId });
    expect(state.blocked).toMatchObject({
      status: "blocked",
      lastError: "dns_mass_removal_blocked",
    });
    // The previous records stay.
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
    const [alert] = await ctx.db
      .select()
      .from(schema.alertState)
      .where(eq(schema.alertState.key, `dns_mass_removal_blocked/platform/${clusterId}`));
    expect(alert?.active).toBe(true);
    await online(["t1", "s1", "r1", "r2"], true);
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId })).blocked).toBeNull();
    expect(allOn("telecom")).toEqual(["8.8.2.1"]);
  });

  it("switches a lone line to a smaller backup group and back: only an empty set is held back", async () => {
    dnsFixture.accounts.set("token-s", { zones: ["solo.test"] });
    const solo = (await admin.clusters.create({ name: "solo" })).id;
    const primary = (await admin.nodeGroups.list({ clusterId: solo }))[0]?.id ?? "";
    const backup = (await admin.nodeGroups.create({ clusterId: solo, name: "backup" })).id;
    for (const [name, address] of [
      ["p1", "9.9.1.1"],
      ["p2", "9.9.1.2"],
      ["p3", "9.9.1.3"],
    ] as const)
      await addNode(primary, name, address, solo);
    await addNode(backup, "b1", "9.9.2.1", solo);
    const account = await admin.dns.createProvider({
      name: "Solo",
      provider: "test",
      zone: "solo.test",
      credentials: { api_token: "token-s" },
    });
    await admin.dns.saveBinding({
      clusterId: solo,
      binding: {
        mode: "auto",
        providerId: account.id,
        domain: "edge.solo.test",
        ttl: 60,
        lines: [line("main", primary, { backupNodeGroupIds: [backup] })],
      },
    });
    const soloAll = () =>
      dnsFixture
        .records("token-s", "solo.test")
        .filter((r) => r.name === "all.edge")
        .map((r) => r.data)
        .sort();
    await reconcileDns(ctx);
    expect(soloAll()).toEqual(["9.9.1.1", "9.9.1.2", "9.9.1.3"]);
    // Every address of the line changes (6 of 6 records), on purpose.
    await online(["p1", "p2", "p3"], false);
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId: solo })).blocked).toBeNull();
    expect(soloAll()).toEqual(["9.9.2.1"]);
    await online(["p1", "p2", "p3"], true);
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId: solo })).blocked).toBeNull();
    expect(soloAll()).toEqual(["9.9.1.1", "9.9.1.2", "9.9.1.3"]);
    // Losing two of three nodes without a backup taking over is still held back by share.
    await admin.dns.saveBinding({
      clusterId: solo,
      binding: {
        mode: "auto",
        providerId: account.id,
        domain: "edge.solo.test",
        ttl: 60,
        lines: [line("main", primary)],
      },
    });
    await reconcileDns(ctx);
    await online(["p1", "p2"], false);
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId: solo })).blocked).toMatchObject({
      status: "blocked",
    });
    expect(soloAll()).toEqual(["9.9.1.1", "9.9.1.2", "9.9.1.3"]);
    await online(["p1", "p2"], true);
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId: solo })).blocked).toBeNull();
  });

  it("lets a node move to its backup address and back; removing nodes is still held back", async () => {
    dnsFixture.accounts.set("token-v", { zones: ["levels.test"] });
    const levels = (await admin.clusters.create({ name: "levels" })).id;
    const group = (await admin.nodeGroups.list({ clusterId: levels }))[0]?.id ?? "";
    await addNode(group, "v1", "9.8.0.1", levels);
    await admin.nodes.setAddresses({
      id: nodes.v1 ?? "",
      addresses: [
        { address: "9.8.1.1", level: 0 },
        { address: "9.8.1.2", level: 1 },
      ],
    });
    const account = await admin.dns.createProvider({
      name: "Levels",
      provider: "test",
      zone: "levels.test",
      credentials: { api_token: "token-v" },
    });
    await admin.dns.saveBinding({
      clusterId: levels,
      binding: {
        mode: "auto",
        providerId: account.id,
        domain: "edge.levels.test",
        ttl: 60,
        lines: [line("tel", group, { resolutionLine: "telecom" })],
      },
    });
    const set = (line = "") =>
      dnsFixture
        .records("token-v", "levels.test")
        .filter((r) => r.name === "all.edge" && (r.line ?? "") === line)
        .map((r) => r.data)
        .sort();
    const primaryDown = (down: boolean) =>
      ctx.db
        .insert(schema.nodeAddressState)
        .values({ nodeId: nodes.v1 ?? "", address: "9.8.1.1", down })
        .onConflictDoUpdate({
          target: [schema.nodeAddressState.nodeId, schema.nodeAddressState.address],
          set: { down },
        });
    const state = () => admin.dns.binding({ clusterId: levels });
    await reconcileDns(ctx);
    expect(set("telecom")).toEqual(["9.8.1.1"]);
    // The line's only address is replaced by the same node's backup address: not a removal.
    await primaryDown(true);
    await reconcileDns(ctx);
    expect((await state()).blocked).toBeNull();
    expect((await state()).revision).toMatchObject({ reason: "health", status: "applied" });
    expect(set("telecom")).toEqual(["9.8.1.2"]);
    expect(set()).toEqual(["9.8.1.2"]);
    expect(
      resolve(dnsFixture.records("token-v", "levels.test"), "levels.test", "tel.edge.levels.test"),
    ).toEqual(["9.8.1.2"]);
    // And back.
    await primaryDown(false);
    await reconcileDns(ctx);
    expect((await state()).blocked).toBeNull();
    expect(set("telecom")).toEqual(["9.8.1.1"]);
    // The node itself leaving empties the line: held back.
    await online(["v1"], false);
    await reconcileDns(ctx);
    expect((await state()).blocked).toMatchObject({ status: "blocked" });
    expect(set("telecom")).toEqual(["9.8.1.1"]);
    await online(["v1"], true);
    await reconcileDns(ctx);
    expect((await state()).blocked).toBeNull();
    // Two of three nodes leaving is over the share, also while the third changes its level.
    await addNode(group, "v2", "9.8.2.1", levels);
    await addNode(group, "v3", "9.8.3.1", levels);
    await reconcileDns(ctx);
    expect(set("telecom")).toEqual(["9.8.1.1", "9.8.2.1", "9.8.3.1"]);
    await primaryDown(true);
    await online(["v2", "v3"], false);
    await reconcileDns(ctx);
    expect((await state()).blocked).toMatchObject({
      status: "blocked",
      removedRecords: 6,
      previousRecords: 9,
    });
    expect(set("telecom")).toEqual(["9.8.1.1", "9.8.2.1", "9.8.3.1"]);
    // One of three leaving (with the level change) passes.
    await online(["v3"], true);
    await reconcileDns(ctx);
    expect((await state()).blocked).toBeNull();
    expect(set("telecom")).toEqual(["9.8.1.2", "9.8.3.1"]);
  });

  it("refuses lines the provider does not implement and backups outside the cluster", async () => {
    const cloudflare = await admin.dns.createProvider({
      name: "CF",
      provider: "cloudflare",
      zone,
      credentials: { api_token: "cf_token_0123456789abcdef" },
    });
    const error = await rpcError(
      admin.dns.saveBinding({
        clusterId,
        binding: {
          mode: "auto",
          providerId: cloudflare.id,
          domain: `edge.${zone}`,
          lines: [line("main", groups.main, { resolutionLine: "telecom" })],
        },
      }),
    );
    expect(error.code).toBe("DNS_LINE_UNSUPPORTED");
    expect(error.status).toBe(400);
    expect(error.data).toMatchObject({ line: "telecom" });
    // Default-line bindings stay fine with such providers.
    const other = await admin.clusters.create({ name: "other-lines" });
    const otherGroup = (await admin.nodeGroups.list({ clusterId: other.id }))[0]?.id ?? "";
    expect(
      (await rpcError(save([line("main", groups.main, { backupNodeGroupIds: [otherGroup] })])))
        .code,
    ).toBe("NODE_GROUP_NOT_FOUND");
    // A line cannot back itself up, nor name a backup twice.
    for (const backups of [[groups.main], [groups.spare, groups.spare]])
      expect(
        (await rpcError(save([line("main", groups.main, { backupNodeGroupIds: backups })]))).status,
      ).toBe(400);
    expect(
      (
        await rpcError(
          save([
            line("main", groups.main, {
              backupNodeGroupIds: [
                groups.tel,
                groups.spare,
                groups.reserve,
                otherGroup,
                groups.tel,
              ],
            }),
          ]),
        )
      ).status,
    ).toBe(400);
    // Manual bindings without an account can list every line (created by hand).
    await admin.dns.saveBinding({
      clusterId: other.id,
      binding: {
        mode: "manual",
        domain: "edge.manual.test",
        lines: [line("main", otherGroup, { resolutionLine: "overseas" })],
      },
    });
    await admin.dns.saveBinding({ clusterId: other.id, binding: { mode: "off" } });
    await admin.clusters.delete({ id: other.id });
  });

  it("exports manual records with their lines; the zone file keeps the default line", async () => {
    await admin.dns.saveBinding({
      clusterId,
      binding: { mode: "off" },
    });
    await reconcileDns(ctx);
    await admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "manual",
        domain: "edge.manual.test",
        ttl: 300,
        lines: [line("main", groups.main), line("tel", groups.tel, { resolutionLine: "telecom" })],
      },
    });
    const exported = await admin.dns.exportBinding({ clusterId });
    expect(exported.records.filter((r) => r.line === "telecom")).toEqual([
      {
        name: "all.edge.manual.test",
        type: "A",
        data: "8.8.2.1",
        ttl: 300,
        line: "telecom",
      },
    ]);
    const lines = exported.zoneFile.split("\n");
    expect(lines).toContain("; line telecom");
    expect(lines.some((l) => /^all\s+300 IN A\s+8\.8\.1\.1$/.test(l))).toBe(true);
    expect(lines.some((l) => /^; all\s+300 IN A\s+8\.8\.2\.1$/.test(l))).toBe(true);
    expect(lines.some((l) => /^all\s+300 IN A\s+8\.8\.2\.1$/.test(l))).toBe(false);
    await admin.dns.saveBinding({ clusterId, binding: { mode: "off" } });
  });

  it("publishes exactly the former records and content hash for lines saved before resolution lines", async () => {
    const oldLines = [
      { name: "main", nodeGroupId: groups.main, overrides: [] },
      { name: "tel", nodeGroupId: groups.tel, overrides: [] },
    ];
    await ctx.db
      .update(schema.dnsBinding)
      .set({ mode: "auto", providerId, domain: `edge.${zone}`, ttl: 60, lines: oldLines })
      .where(eq(schema.dnsBinding.clusterId, clusterId));
    await reconcileDns(ctx);
    const [revision] = await ctx.db
      .select()
      .from(schema.dnsRevision)
      .where(
        and(eq(schema.dnsRevision.clusterId, clusterId), eq(schema.dnsRevision.status, "applied")),
      )
      .orderBy(desc(schema.dnsRevision.revision))
      .limit(1);
    const rec = (name: string, type: "A" | "CNAME", data: string) => ({
      name,
      type,
      data,
      ttl: 60,
    });
    // The plan before resolution lines: the union on all.<domain>, the
    // lines' own names, a CNAME per site, sorted by name, type, data, TTL.
    const key = (r: { name: string; type: string; data: string; ttl: number }) =>
      `${r.name}|${r.type}|${r.data}|${r.ttl}`;
    expect(revision?.records).toEqual(
      [
        rec(`${siteId}.edge`, "CNAME", `all.edge.${zone}`),
        rec("all.edge", "A", "8.8.1.1"),
        rec("all.edge", "A", "8.8.1.2"),
        rec("all.edge", "A", "8.8.2.1"),
        rec("main.edge", "A", "8.8.1.1"),
        rec("main.edge", "A", "8.8.1.2"),
        rec("tel.edge", "A", "8.8.2.1"),
      ].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)),
    );
    // The stored lines are hashed as stored (no fields added).
    const policy = {
      mode: "auto",
      providerId,
      domain: `edge.${zone}`,
      ttl: 60,
      lines: oldLines,
      lineAliases: false,
      allLabel: "all",
    };
    expect(revision?.policy).toEqual(policy);
    const stored = bindingPolicy(await loadBinding(ctx.db, clusterId));
    expect(stored.lines.every((l) => Object.keys(l).length === 3)).toBe(true);
    const plan = await compileBindingPlan(ctx.db, clusterId, stored);
    expect(plan.records).toEqual(revision?.records);
    expect(revision?.contentHash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            policy: stored,
            records: plan.records,
            managedNames: plan.managedNames,
          }),
        )
        .digest("hex"),
    );
    // The API shows them with the defaults filled in.
    const state = await admin.dns.binding({ clusterId });
    expect(state.binding.lines).toEqual(
      oldLines.map((l) => ({
        ...l,
        resolutionLine: "default",
        backupNodeGroupIds: [],
        minHealthyIps: 1,
      })),
    );
    // The next run publishes no revision.
    await reconcileDns(ctx);
    expect((await admin.dns.binding({ clusterId })).revision?.revision).toBe(revision?.revision);
  });
});
