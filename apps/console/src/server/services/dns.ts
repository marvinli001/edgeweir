import { createHash } from "node:crypto";
import {
  type DnsBinding,
  type DnsBindingInput,
  type DnsLine,
  type DnsProtection,
  type DnsRecord,
  type DnsResolutionLine,
  type DnsRevision,
  type DnsRevisionReason,
  dnsBindingInput,
  dnsProtection,
  forbiddenOriginRange,
  formatIp,
  parseIp,
  providerLines,
  withLineDefaults,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, gt, inArray, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { isOnline } from "../lib/node-online";
import { type Actor, recordAudit, systemActor } from "./audit";
import { withLease } from "./dns-lease";
import {
  certdDns,
  errorCode,
  findProvider,
  openProvider,
  type ProviderRecord,
} from "./dns-providers";
import {
  downAddresses,
  effectiveAddresses,
  nodeIpRows,
  schedulingAddressesOf,
} from "./node-addresses";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import {
  type Executor,
  type RolloutTargets,
  rolloutTargets,
  type Tx,
  targetFor,
} from "./revisions";
import { findSite } from "./sites";

export {
  createDnsProvider,
  deleteDnsProvider,
  listDnsProviders,
  listProviderZones,
  testProvider,
  updateDnsProvider,
} from "./dns-providers";

type Provider = typeof schema.platformDnsProvider.$inferSelect;
type Revision = typeof schema.dnsRevision.$inferSelect;
type BindingRow = typeof schema.dnsBinding.$inferSelect;
type ManagedName = { name: string; type: string };
/**
 * What a revision stores and a plan is compiled from. Lines may lack the
 * fields added with resolution lines (stored before them).
 */
export type BindingPolicy = Omit<DnsBindingInput, "lines"> & {
  allLabel: string;
  lines: schema.DnsLineData[];
};
type Plan = { records: DnsRecord[]; managedNames: ManagedName[] };

const privateNetworks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
const MAX_RECORDS = 10000;
const revisionDto = (r: Revision): DnsRevision => ({
  revision: r.revision,
  status: r.status as DnsRevision["status"],
  reason: r.reason,
  reasonParams: r.reasonParams ?? {},
  recordCount: r.records.length,
  createdAt: r.createdAt.toISOString(),
  appliedAt: r.appliedAt?.toISOString() ?? null,
  lastError: r.lastError,
});
const nameKey = (r: ManagedName) => `${r.name}|${r.type}`;
/** The resolution line of a record ("" for the default line). */
const lineOf = (r: { line?: string }) => (r.line && r.line !== "default" ? r.line : "");
/** Plan order; default-line records sort exactly as before resolution lines. */
const recordKey = (r: { name: string; type: string; data: string; ttl: number; line?: string }) =>
  `${nameKey(r)}|${r.data}|${r.ttl}${lineOf(r) ? `|${lineOf(r)}` : ""}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A name relative to the zone ("@" for the apex); DNS_ZONE_MISMATCH outside it. */
export function relative(name: string, zone: string) {
  if (name === zone) return "@";
  if (!name.endsWith(`.${zone}`)) fail("DNS_ZONE_MISMATCH", "DNS name is outside the zone");
  return name.slice(0, -zone.length - 1);
}
const absolute = (name: string, zone: string) => (name === "@" ? zone : `${name}.${zone}`);

const defaultRow = (clusterId: string): BindingRow => ({
  clusterId,
  mode: "off",
  providerId: null,
  domain: "",
  ttl: 600,
  lines: [],
  allLabel: "all",
  lineAliases: false,
  desiredRevision: null,
  appliedRevision: null,
  updatedAt: new Date(0),
});
async function assertCluster(db: Executor, clusterId: string) {
  const [cluster] = await db.select().from(schema.cluster).where(eq(schema.cluster.id, clusterId));
  if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return cluster;
}
/** The binding row, or an unsaved "off" binding. */
export async function loadBinding(db: Executor, clusterId: string): Promise<BindingRow> {
  const [row] = await db
    .select()
    .from(schema.dnsBinding)
    .where(eq(schema.dnsBinding.clusterId, clusterId));
  return row ?? defaultRow(clusterId);
}
/** Creates the row when missing and locks it (all publications of a binding are serialized). */
async function lockBinding(tx: Tx, clusterId: string): Promise<BindingRow> {
  await tx.insert(schema.dnsBinding).values({ clusterId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(schema.dnsBinding)
    .where(eq(schema.dnsBinding.clusterId, clusterId))
    .for("update");
  if (!row) throw new Error("DNS binding missing");
  return row;
}
/**
 * The binding as stored. Lines saved before resolution lines keep their
 * stored form (without the newer fields), so their plan and content hash
 * stay what they were; compileBindingPlan fills in the defaults.
 */
export function bindingPolicy(row: BindingRow): BindingPolicy {
  return {
    mode: row.mode as BindingPolicy["mode"],
    providerId: row.providerId,
    domain: row.domain,
    ttl: row.ttl,
    lines: row.lines,
    lineAliases: row.lineAliases,
    allLabel: row.allLabel,
  };
}
function parsePolicy(value: Record<string, unknown>, allLabel: string): BindingPolicy | null {
  const parsed = dnsBindingInput.safeParse(value);
  if (!parsed.success) return null;
  const label = typeof value.allLabel === "string" ? value.allLabel : allLabel;
  return { ...parsed.data, allLabel: label };
}
async function bindingDto(db: Executor, row: BindingRow): Promise<DnsBinding> {
  const provider = row.providerId ? await findProvider(db, row.providerId) : null;
  return {
    clusterId: row.clusterId,
    mode: row.mode as DnsBinding["mode"],
    providerId: row.providerId,
    zone: provider?.zone ?? "",
    domain: row.domain,
    ttl: row.ttl,
    lines: row.lines.map(withLineDefaults),
    lineAliases: row.lineAliases,
    allLabel: row.allLabel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The zone of a binding: the account's, or the domain itself (manual mode without an account). */
function zoneOf(policy: BindingPolicy, provider: Provider | null) {
  return provider?.zone ?? policy.domain;
}
/** The fixed names of a binding (all-lines record and lines), relative to its domain. */
const fixedLabels = (policy: BindingPolicy) => [
  policy.allLabel,
  ...policy.lines.map((l) => l.name),
];

async function validateBinding(db: Executor, clusterId: string, policy: BindingPolicy) {
  if (policy.mode === "off") return;
  const provider = policy.providerId ? await findProvider(db, policy.providerId) : null;
  relative(policy.domain, zoneOf(policy, provider));
  const groups = await db
    .select()
    .from(schema.nodeGroup)
    .where(eq(schema.nodeGroup.clusterId, clusterId));
  const nodes = await db.select().from(schema.node).where(eq(schema.node.clusterId, clusterId));
  const supported = provider ? providerLines(provider.provider) : null;
  for (const line of policy.lines.map(withLineDefaults)) {
    if (line.name === policy.allLabel)
      fail("DNS_POLICY_INVALID", "a line cannot use the all-lines record name");
    if (!groups.some((g) => g.id === line.nodeGroupId))
      fail("NODE_GROUP_NOT_FOUND", "DNS line references a node group outside this cluster");
    if (line.backupNodeGroupIds.some((id) => !groups.some((g) => g.id === id)))
      fail("NODE_GROUP_NOT_FOUND", "DNS line backup is a node group outside this cluster");
    // Without an account (manual records) every line can be created by hand.
    if (supported && !supported.includes(line.resolutionLine))
      fail("DNS_LINE_UNSUPPORTED", "the DNS provider has no such resolution line", {
        line: line.resolutionLine,
      });
    if (new Set(line.overrides.map((o) => o.nodeId)).size !== line.overrides.length)
      fail("DNS_POLICY_INVALID", "duplicate node address override");
    for (const override of line.overrides) {
      if (!nodes.some((n) => n.id === override.nodeId && n.nodeGroupId === line.nodeGroupId))
        fail("DNS_POLICY_INVALID", "node is outside this DNS line");
      if (override.addresses.some((ip) => forbiddenOriginRange(ip, privateNetworks) !== null))
        fail("DNS_POLICY_INVALID", "DNS target must be a unicast address");
    }
  }
  if (!provider) return;
  // Bindings of other clusters in the same zone and domain may not plan the same names.
  const others = await db
    .select({ binding: schema.dnsBinding, zone: schema.platformDnsProvider.zone })
    .from(schema.dnsBinding)
    .innerJoin(
      schema.platformDnsProvider,
      eq(schema.platformDnsProvider.id, schema.dnsBinding.providerId),
    )
    .where(
      and(
        ne(schema.dnsBinding.clusterId, clusterId),
        ne(schema.dnsBinding.mode, "off"),
        eq(schema.dnsBinding.domain, policy.domain),
      ),
    );
  const mine = new Set(fixedLabels(policy));
  for (const other of others)
    if (
      other.zone === provider.zone &&
      fixedLabels(bindingPolicy(other.binding)).some((label) => mine.has(label))
    )
      fail("DNS_BINDING_CONFLICT", "another cluster uses the same record names");
}

/** How long a node may lag a new target (applying it, or not told yet) and keep its records. */
export const DNS_APPLY_GRACE_MS = 2 * 60_000;
type Receipt = typeof schema.nodeConfigStatus.$inferSelect;
type TargetRevision = { revision: number; contentHash: string; createdAt: Date };
/**
 * Whether a node serves its target, by content (a rollback copy has a higher
 * number but the same hash). A node that served before keeps its records
 * while it applies a target published less than DNS_APPLY_GRACE_MS ago, if
 * it had reached `settled` (the newest revision older than that, when nodes
 * of the cluster share one line): otherwise every publication would take
 * nodes out of DNS until they report it, and all of them at once trips the
 * mass removal protection. A failed apply, a longer one, or a node already
 * behind loses them.
 */
function servesTarget(
  receipt: Receipt,
  target: TargetRevision,
  settled: Omit<TargetRevision, "createdAt"> | undefined,
  now: number,
) {
  if (receipt.state === "applied" && receipt.appliedContentHash === target.contentHash) return true;
  return (
    receipt.state !== "failed" &&
    receipt.appliedContentHash !== "" &&
    now - target.createdAt.getTime() < DNS_APPLY_GRACE_MS &&
    (!settled ||
      receipt.appliedRevision >= settled.revision ||
      receipt.appliedContentHash === settled.contentHash)
  );
}

/**
 * What active scheduling rules (state active or recovering) do to a
 * cluster's plan: nodes removed from a line ("*": every line), nodes forced
 * to their next address level, lines switched to their backup groups.
 */
export async function schedulingEffects(db: Executor, clusterId: string) {
  const rows = await db
    .select({
      nodeId: schema.schedulingState.nodeId,
      action: schema.schedulingRule.action,
      lineName: schema.schedulingRule.lineName,
    })
    .from(schema.schedulingState)
    .innerJoin(schema.schedulingRule, eq(schema.schedulingRule.id, schema.schedulingState.ruleId))
    .where(
      and(
        eq(schema.schedulingRule.clusterId, clusterId),
        eq(schema.schedulingRule.enabled, true),
        inArray(schema.schedulingState.state, ["active", "recovering"]),
      ),
    );
  const removed = new Map<string, Set<string>>();
  const backupIp = new Map<string, Set<string>>();
  const backupGroupLines = new Set<string>();
  for (const row of rows) {
    const line = row.lineName ?? "*";
    if (row.action === "remove_node")
      removed.set(row.nodeId, (removed.get(row.nodeId) ?? new Set()).add(line));
    else if (row.action === "backup_ip")
      backupIp.set(row.nodeId, (backupIp.get(row.nodeId) ?? new Set()).add(line));
    else if (row.action === "backup_group" && row.lineName) backupGroupLines.add(row.lineName);
  }
  return { removed, backupIp, backupGroupLines };
}
/** Resolution lines the binding's lines map to ("default" always answers). */
const resolutionLinesOf = (policy: Pick<BindingPolicy, "lines">) =>
  new Set<string>(["default", ...policy.lines.map((l) => withLineDefaults(l).resolutionLine)]);
const appliesTo = (lines: Set<string> | undefined, line: string) =>
  !!lines && (lines.has("*") || lines.has(line));

/**
 * The cluster's records. auto: addresses of nodes that are active, online,
 * healthy and run their target revision or are applying a new one
 * (servesTarget; current routing rights: DNS history never restores a dead
 * node), minus nodes a scheduling rule removed; each node answers with its
 * effective scheduling addresses (its lowest level the probes can reach, at
 * least the next one under a backup_ip action, none when every address is
 * down: see effectiveAddresses). A line whose group has fewer than
 * minHealthyIps healthy addresses (or under a backup_group action) answers
 * with its first backup group that has enough, else with every healthy
 * address of its groups. manual: every active node's primary addresses
 * (hand-made records do not follow health). `<line>.<domain>` and the site
 * CNAMEs are default-line records; `<all>.<domain>` has records per
 * resolution line: the union of the binding lines mapped to it, and on the
 * default line the union of the lines mapped to default, or of every line
 * when none is (or they have no address). `failover`: what the mass
 * removal protection does not count by share (only emptying a set counts):
 * record sets a backup group answers now ("name|line") and backup group
 * addresses in the sets of their line ("name|line|address").
 */
export async function compileBindingPlan(
  db: Executor,
  clusterId: string,
  policy: BindingPolicy,
  now = Date.now(),
): Promise<Plan & { failover: string[] }> {
  if (policy.mode === "off" || !policy.domain)
    return { records: [], managedNames: [], failover: [] };
  const provider = policy.providerId ? await findProvider(db, policy.providerId) : null;
  if (policy.mode === "auto" && !provider) return { records: [], managedNames: [], failover: [] };
  const zone = zoneOf(policy, provider);
  relative(policy.domain, zone);
  const manual = policy.mode === "manual";
  const sites = await db
    .selectDistinct({ id: schema.site.id })
    .from(schema.site)
    .innerJoin(schema.siteDomain, eq(schema.siteDomain.siteId, schema.site.id))
    // Disabled sites keep their records; nodes answer them with the disabled page.
    .where(eq(schema.site.clusterId, clusterId))
    .orderBy(schema.site.id);
  const nodes = await db.select().from(schema.node).where(eq(schema.node.clusterId, clusterId));
  const nodeIds = nodes.map((n) => n.id);
  const receipts = nodeIds.length
    ? await db
        .select()
        .from(schema.nodeConfigStatus)
        .where(inArray(schema.nodeConfigStatus.nodeId, nodeIds))
    : [];
  const addresses = await nodeIpRows(db, nodeIds);
  const down = manual ? new Map<string, Set<string>>() : await downAddresses(db, nodeIds);
  const effects = manual ? null : await schedulingEffects(db, clusterId);
  const groups = await db
    .select()
    .from(schema.nodeGroup)
    .where(eq(schema.nodeGroup.clusterId, clusterId));
  // Each node is compared with its own target: during a canary window the
  // non-canary nodes run the stable revision and stay in the plan.
  const targets: RolloutTargets | undefined = manual
    ? undefined
    : await rolloutTargets(db, clusterId);
  // During a canary window nodes follow two lines; only their target's age counts.
  const [settled] =
    manual || targets?.candidate
      ? []
      : await db
          .select({
            revision: schema.configRevision.revision,
            contentHash: schema.configRevision.contentHash,
          })
          .from(schema.configRevision)
          .where(
            and(
              eq(schema.configRevision.clusterId, clusterId),
              lte(schema.configRevision.createdAt, new Date(now - DNS_APPLY_GRACE_MS)),
            ),
          )
          .orderBy(desc(schema.configRevision.revision))
          .limit(1);
  // A provider whose catalog lost a line since the binding was saved gets none of its records.
  const writable: readonly DnsResolutionLine[] = provider
    ? providerLines(provider.provider)
    : ["default", "telecom", "unicom", "mobile", "edu", "overseas"];
  const records: DnsRecord[] = [];
  const names = new Map<string, ManagedName>();
  const declare = (name: string, type: DnsRecord["type"]) => {
    const row = { name: relative(name, zone), type };
    names.set(nameKey(row), row);
    return row.name;
  };
  const add = (
    name: string,
    type: DnsRecord["type"],
    data: string,
    line: DnsResolutionLine = "default",
  ) =>
    records.push({
      name: declare(name, type),
      type,
      data,
      ttl: policy.ttl,
      ...(line === "default" ? {} : { line }),
    });
  const addAddresses = (name: string, ips: Iterable<string>, line?: DnsResolutionLine) => {
    for (const ip of ips) add(name, ip.includes(":") ? "AAAA" : "A", ip, line);
  };
  const healthy = (node: (typeof nodes)[number]) => {
    if (node.status !== "active") return false;
    if (manual) return true;
    const receipt = receipts.find((r) => r.nodeId === node.id),
      target = targets ? targetFor(node, targets) : undefined;
    return (
      isOnline(node.lastSeenAt, now) &&
      !!receipt?.dataPlaneHealthy &&
      !!target &&
      servesTarget(receipt, target, settled, now)
    );
  };
  /** Healthy addresses of a group's nodes as `line` publishes them. */
  const groupAddresses = (line: DnsLine, groupId: string) => {
    const ips = new Set<string>();
    for (const node of nodes.filter((n) => n.nodeGroupId === groupId)) {
      if (!healthy(node) || appliesTo(effects?.removed.get(node.id), line.name)) continue;
      const override = line.overrides.find((o) => o.nodeId === node.id);
      let candidates: string[];
      if (override) {
        candidates = override.addresses.filter(
          (address) => forbiddenOriginRange(address, privateNetworks) === null,
        );
      } else {
        const own = schedulingAddressesOf(addresses.get(node.id) ?? []);
        candidates = manual
          ? own.filter((a) => a.level === own[0]?.level).map((a) => a.address)
          : effectiveAddresses(
              own,
              down.get(node.id) ?? new Set(),
              appliesTo(effects?.backupIp.get(node.id), line.name) ? 1 : 0,
            ).addresses;
      }
      for (const address of candidates) {
        const parsed = parseIp(address);
        if (parsed) ips.add(formatIp(parsed));
      }
    }
    return ips;
  };
  const allName = `${policy.allLabel}.${policy.domain}`;
  declare(allName, "A");
  declare(allName, "AAAA");
  const byResolution = new Map<DnsResolutionLine, Set<string>>();
  const all = new Set<string>();
  const lines: { name: string; target: string }[] = [];
  /**
   * Backup groups change a line's addresses on purpose. Exempt from the share
   * of the mass removal protection (not from emptying a set): sets a backup
   * group answers now ("name|line"), and the addresses of backup group nodes
   * in the sets their line feeds ("name|line|address", switching back).
   */
  const failover: string[] = [];
  const fed: { line: DnsLine; target: string; switched: boolean; backup: Set<string> }[] = [];
  const setKey = (name: string, line: DnsResolutionLine) =>
    `${relative(name, zone)}|${line === "default" ? "" : line}`;
  for (const line of policy.lines.map(withLineDefaults)) {
    if (!groups.some((g) => g.id === line.nodeGroupId)) continue;
    const lineTarget = `${line.name}.${policy.domain}`;
    lines.push({ name: line.name, target: lineTarget });
    declare(lineTarget, "A");
    declare(lineTarget, "AAAA");
    let ips = groupAddresses(line, line.nodeGroupId);
    let switched = false;
    const backupGroups = line.backupNodeGroupIds.filter((id) => groups.some((g) => g.id === id));
    if (!manual && (effects?.backupGroupLines.has(line.name) || ips.size < line.minHealthyIps)) {
      const backups = backupGroups.map((id) => groupAddresses(line, id));
      const enough = backups.find((b) => b.size >= line.minHealthyIps);
      // None has enough: every still-healthy address of the line's groups.
      const next = enough ?? new Set([...ips, ...backups.flatMap((b) => [...b])]);
      switched = [...next].some((ip) => !ips.has(ip));
      ips = next;
    }
    fed.push({
      line,
      target: lineTarget,
      switched,
      backup: new Set(
        nodes
          .filter((n) => n.nodeGroupId && backupGroups.includes(n.nodeGroupId))
          .flatMap((n) => schedulingAddressesOf(addresses.get(n.id) ?? []).map((a) => a.address)),
      ),
    });
    addAddresses(lineTarget, ips);
    for (const ip of ips) all.add(ip);
    const resolution = byResolution.get(line.resolutionLine) ?? new Set<string>();
    for (const ip of ips) resolution.add(ip);
    byResolution.set(line.resolutionLine, resolution);
  }
  // DNSPod needs a default-line record, and other providers answer unmatched
  // resolvers with it: every line's addresses when the default lines have none.
  const defaultIps = byResolution.get("default");
  const defaultFeeds = (line: DnsLine) =>
    defaultIps?.size ? line.resolutionLine === "default" : true;
  addAddresses(allName, defaultIps?.size ? defaultIps : all);
  for (const [line, ips] of byResolution)
    if (line !== "default" && writable.includes(line)) addAddresses(allName, ips, line);
  for (const { line, target, switched, backup } of fed) {
    const sets = [
      setKey(target, "default"),
      setKey(allName, line.resolutionLine),
      ...(defaultFeeds(line) && line.resolutionLine !== "default"
        ? [setKey(allName, "default")]
        : []),
    ];
    for (const set of sets) {
      if (switched) failover.push(set);
      for (const address of backup) failover.push(`${set}|${address}`);
    }
  }
  for (const site of sites) {
    add(`${site.id}.${policy.domain}`, "CNAME", allName);
    if (policy.lineAliases)
      for (const line of lines)
        add(`${line.name}.${site.id}.${policy.domain}`, "CNAME", line.target);
  }
  if (names.size > MAX_RECORDS || records.length > MAX_RECORDS)
    fail("DNS_POLICY_INVALID", "DNS managed record limit exceeded");
  return {
    records: records.sort((a, b) => compare(recordKey(a), recordKey(b))),
    managedNames: [...names.values()].sort((a, b) => compare(nameKey(a), nameKey(b))),
    failover,
  };
}

const PROTECTION_KEY = "dns_protection";
const DEFAULT_PROTECTION: DnsProtection = { massRemovalRatio: 0.5 };
const addressRecord = (r: { type: string }) => r.type === "A" || r.type === "AAAA";
/** An address record on its resolution line. */
const addressKey = (r: DnsRecord) => `${r.name}|${r.type}|${lineOf(r)}|${r.data}`;

export async function getDnsProtection(db: Executor): Promise<DnsProtection> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, PROTECTION_KEY));
  const parsed = dnsProtection.safeParse({ ...DEFAULT_PROTECTION, ...(row?.value ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_PROTECTION;
}

export async function setDnsProtection(app: AppContext, input: DnsProtection, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const before = await getDnsProtection(tx);
    await tx
      .insert(schema.systemSetting)
      .values({ key: PROTECTION_KEY, value: input })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value: input } });
    await recordAudit(tx, actor, {
      action: "dns.protection_update",
      targetType: "system_setting",
      targetId: PROTECTION_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
}

/**
 * What a plan would remove from the previous address records: record sets
 * (names still managed, per resolution line: "name" on the default line,
 * "name@line" on another) that would become empty, and how many address
 * records (name, type, line, address) would go. Names the plan no longer
 * manages (deleted sites, removed lines) and resolution lines no binding
 * line maps to any more (`lines`, when given) are not counted. An address
 * whose node (`owners`: address → node) still answers in the same set with
 * another address (a node moving between its own address levels, either
 * way) is replaced, not removed: it does not count as removed.
 */
export function massRemoval(
  previous: DnsRecord[],
  next: Plan,
  opts: {
    lines?: ReadonlySet<string>;
    failover?: readonly string[];
    owners?: ReadonlyMap<string, string>;
  } = {},
) {
  const managed = new Set(next.managedNames.map(nameKey));
  const before = previous.filter(
    (r) =>
      addressRecord(r) &&
      managed.has(nameKey(r)) &&
      (!opts.lines || !lineOf(r) || opts.lines.has(lineOf(r))),
  );
  const after = new Set(next.records.filter(addressRecord).map(addressKey));
  const setOf = (r: DnsRecord) => `${r.name}|${lineOf(r)}`;
  // Nodes that still answer in each record set of the plan.
  const answering = new Set(
    next.records.filter(addressRecord).flatMap((r) => {
      const node = opts.owners?.get(r.data);
      return node ? [`${setOf(r)}|${node}`] : [];
    }),
  );
  const replaced = (r: DnsRecord) => {
    const node = opts.owners?.get(r.data);
    return !!node && answering.has(`${setOf(r)}|${node}`);
  };
  // Backup groups change sets on purpose: only emptying them counts.
  const failover = new Set(opts.failover ?? []);
  const counted = before.filter(
    (r) => !failover.has(setOf(r)) && !failover.has(`${setOf(r)}|${r.data}`),
  );
  const removed = counted.filter((r) => !after.has(addressKey(r)) && !replaced(r)).length;
  const names = (records: DnsRecord[]) =>
    new Set(
      records.filter(addressRecord).map((r) => (lineOf(r) ? `${r.name}@${lineOf(r)}` : r.name)),
    );
  const remaining = names(next.records);
  const cleared = [...names(before)].filter((name) => !remaining.has(name));
  return { removed, previous: counted.length, cleared };
}

/**
 * Which node each address of the cluster belongs to: the addresses the
 * nodes report or have configured, and the binding lines' overrides.
 */
async function addressOwners(
  db: Executor,
  clusterId: string,
  policy: Pick<BindingPolicy, "lines">,
) {
  const rows = await db
    .select({ nodeId: schema.nodeIp.nodeId, address: schema.nodeIp.address })
    .from(schema.nodeIp)
    .innerJoin(schema.node, eq(schema.node.id, schema.nodeIp.nodeId))
    .where(eq(schema.node.clusterId, clusterId));
  const owners = new Map<string, string>();
  const own = (address: string, nodeId: string) => {
    const ip = parseIp(address);
    if (ip) owners.set(formatIp(ip), nodeId);
  };
  for (const row of rows) own(row.address, row.nodeId);
  for (const line of policy.lines)
    for (const override of line.overrides)
      for (const address of override.addresses) own(address, override.nodeId);
  return owners;
}

/**
 * Publishes a binding's plan unless the mass removal protection holds it
 * back: a plan that would empty a non-empty record set (all-lines or a line)
 * or remove more than the configured share of address records keeps the
 * previous revision, is stored as a blocked revision and raises the
 * dns_mass_removal_blocked alert of the cluster, until a plan passes or the
 * operator forces it. Covers the console losing its nodes (all of them
 * look offline). Manual bindings are "applied" as soon as they are saved:
 * the console does not write them.
 */
async function publishBinding(
  tx: Tx,
  clusterId: string,
  policy: BindingPolicy,
  reason: DnsRevisionReason,
  opts: { force?: boolean; save?: boolean; params?: Record<string, string | number> } = {},
) {
  const reasonParams = opts.params ?? {};
  const row = await lockBinding(tx, clusterId);
  const cluster = await assertCluster(tx, clusterId);
  if (opts.save)
    await tx
      .update(schema.dnsBinding)
      .set({
        mode: policy.mode,
        providerId: policy.providerId,
        domain: policy.domain,
        ttl: policy.ttl,
        lines: policy.lines,
        lineAliases: policy.lineAliases,
        updatedAt: new Date(),
      })
      .where(eq(schema.dnsBinding.clusterId, clusterId));
  const { failover, ...plan } = await compileBindingPlan(tx, clusterId, policy);
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ policy, ...plan }))
    .digest("hex");
  const [previous] = row.desiredRevision
    ? await tx
        .select()
        .from(schema.dnsRevision)
        .where(eq(schema.dnsRevision.revision, row.desiredRevision))
    : [];
  const previousPolicy = previous ? parsePolicy(previous.policy, row.allLabel) : null;
  let hold = false;
  if (
    !opts.force &&
    previous &&
    (previousPolicy?.mode === "auto" || previousPolicy?.mode === "manual") &&
    policy.mode === "auto" &&
    previousPolicy.providerId === policy.providerId &&
    previousPolicy.domain === policy.domain &&
    previousPolicy.allLabel === policy.allLabel &&
    previous.contentHash !== contentHash
  ) {
    const check = massRemoval(previous.records, plan, {
      lines: resolutionLinesOf(policy),
      failover,
      owners: await addressOwners(tx, clusterId, policy),
    });
    const { massRemovalRatio } = await getDnsProtection(tx);
    hold =
      check.cleared.length > 0 ||
      (check.previous > 0 && check.removed / check.previous > massRemovalRatio);
  } else if (!opts.force && !previous && policy.mode === "auto") {
    // No revision to compare with, but records already written for this
    // cluster (a binding converted from the former global policy): sites
    // pointed at an empty all-lines set would all stop resolving, e.g. when
    // the first run after an upgrade finds every node offline.
    const [owned] = await tx
      .select({ name: schema.dnsManagedName.name })
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.clusterId, clusterId))
      .limit(1);
    hold =
      !!owned && plan.records.some((r) => r.type === "CNAME") && !plan.records.some(addressRecord);
  }
  if (hold) {
    const [held] = await tx
      .select()
      .from(schema.dnsRevision)
      .where(
        and(
          eq(schema.dnsRevision.clusterId, clusterId),
          eq(schema.dnsRevision.status, "blocked"),
          eq(schema.dnsRevision.contentHash, contentHash),
        ),
      );
    let blocked = held;
    if (!held) {
      await supersede(tx, clusterId, "blocked");
      [blocked] = await tx
        .insert(schema.dnsRevision)
        .values({
          clusterId,
          providerId: policy.providerId,
          policy,
          ...plan,
          contentHash,
          reason,
          reasonParams,
          status: "blocked",
          lastError: "dns_mass_removal_blocked",
        })
        .returning();
    }
    await raisePlatformAlert(tx, "dns_mass_removal_blocked", clusterId, cluster.name);
    // The previous revision stays in effect; without one nothing is written.
    const kept = previous ?? blocked;
    if (!kept) throw new Error("DNS revision insert failed");
    return kept;
  }
  // A plan that passes (or is forced) ends any hold.
  await supersede(tx, clusterId, "blocked");
  await resolvePlatformAlert(tx, "dns_mass_removal_blocked", clusterId, cluster.name);
  if (previous?.contentHash === contentHash) return previous;
  const manual = policy.mode === "manual";
  const [inserted] = await tx
    .insert(schema.dnsRevision)
    .values({
      clusterId,
      providerId: policy.providerId,
      policy,
      ...plan,
      contentHash,
      reason,
      reasonParams,
      ...(manual ? { status: "applied", appliedAt: new Date() } : {}),
    })
    .returning();
  if (!inserted) throw new Error("DNS revision insert failed");
  await tx
    .update(schema.dnsRevision)
    .set({ status: "superseded" })
    .where(
      and(
        eq(schema.dnsRevision.clusterId, clusterId),
        eq(schema.dnsRevision.status, "pending"),
        ne(schema.dnsRevision.revision, inserted.revision),
      ),
    );
  await tx
    .update(schema.dnsBinding)
    .set({
      desiredRevision: inserted.revision,
      ...(manual ? { appliedRevision: inserted.revision } : {}),
    })
    .where(eq(schema.dnsBinding.clusterId, clusterId));
  return inserted;
}
/**
 * Publishes an automatic binding's plan now, in the caller's transaction
 * (scheduling actions and probe-driven address changes do not wait for the
 * reconciliation every minute). Returns the new revision, or null when the
 * binding is not automatic, the plan did not change or the mass removal
 * protection held it back.
 */
export async function publishClusterDns(
  tx: Tx,
  clusterId: string,
  reason: DnsRevisionReason,
  params: Record<string, string | number> = {},
) {
  const [row] = await tx
    .select()
    .from(schema.dnsBinding)
    .where(eq(schema.dnsBinding.clusterId, clusterId))
    .for("update");
  if (!row || row.mode !== "auto") return null;
  const revision = await publishBinding(tx, clusterId, bindingPolicy(row), reason, { params });
  return revision.revision === row.desiredRevision || revision.status === "blocked"
    ? null
    : revision;
}
async function supersede(tx: Tx, clusterId: string, status: "blocked" | "pending") {
  await tx
    .update(schema.dnsRevision)
    .set({ status: "superseded" })
    .where(and(eq(schema.dnsRevision.clusterId, clusterId), eq(schema.dnsRevision.status, status)));
}

async function revisionRow(db: Executor, clusterId: string, revision: number | null) {
  if (!revision) return undefined;
  const [row] = await db
    .select()
    .from(schema.dnsRevision)
    .where(
      and(eq(schema.dnsRevision.revision, revision), eq(schema.dnsRevision.clusterId, clusterId)),
    );
  return row;
}
export async function getBinding(app: AppContext, clusterId: string) {
  await assertCluster(app.db, clusterId);
  const row = await loadBinding(app.db, clusterId);
  const revision = await revisionRow(app.db, clusterId, row.desiredRevision);
  const [blocked] = await app.db
    .select()
    .from(schema.dnsRevision)
    .where(
      and(eq(schema.dnsRevision.clusterId, clusterId), eq(schema.dnsRevision.status, "blocked")),
    )
    .orderBy(desc(schema.dnsRevision.revision))
    .limit(1);
  const check = blocked
    ? massRemoval(revision?.records ?? [], blocked, {
        lines: resolutionLinesOf(parsePolicy(blocked.policy, row.allLabel) ?? bindingPolicy(row)),
        owners: await addressOwners(app.db, clusterId, bindingPolicy(row)),
      })
    : { removed: 0, previous: 0 };
  return {
    binding: await bindingDto(app.db, row),
    revision: revision ? revisionDto(revision) : null,
    applied:
      !!revision && row.appliedRevision === row.desiredRevision && revision.status === "applied",
    records: revision?.records ?? [],
    blocked: blocked
      ? { ...revisionDto(blocked), removedRecords: check.removed, previousRecords: check.previous }
      : null,
  };
}
export async function listBindings(app: AppContext) {
  const clusters = await app.db.select().from(schema.cluster).orderBy(schema.cluster.name);
  const rows = await app.db.select().from(schema.dnsBinding);
  const providers = await app.db.select().from(schema.platformDnsProvider);
  const desired = rows.map((r) => r.desiredRevision).filter((r): r is number => !!r);
  const revisions = desired.length
    ? await app.db
        .select()
        .from(schema.dnsRevision)
        .where(inArray(schema.dnsRevision.revision, desired))
    : [];
  const blocked = await app.db
    .select({ clusterId: schema.dnsRevision.clusterId })
    .from(schema.dnsRevision)
    .where(eq(schema.dnsRevision.status, "blocked"));
  return clusters.map((cluster) => {
    const row = rows.find((r) => r.clusterId === cluster.id) ?? defaultRow(cluster.id);
    const revision = revisions.find((r) => r.revision === row.desiredRevision);
    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      mode: row.mode as DnsBinding["mode"],
      providerId: row.providerId,
      zone: providers.find((p) => p.id === row.providerId)?.zone ?? "",
      domain: row.domain,
      revision: revision ? revisionDto(revision) : null,
      applied:
        !!revision && row.appliedRevision === row.desiredRevision && revision.status === "applied",
      blocked: blocked.some((b) => b.clusterId === cluster.id),
    };
  });
}

/** Saves a binding and publishes its plan as a new DNS revision (no node revision). */
export async function saveBinding(
  app: AppContext,
  clusterId: string,
  input: Omit<BindingPolicy, "allLabel">,
  actor: Actor,
) {
  await assertCluster(app.db, clusterId);
  const current = await loadBinding(app.db, clusterId);
  const policy: BindingPolicy = { ...input, allLabel: current.allLabel };
  await validateBinding(app.db, clusterId, policy);
  return app.db.transaction(async (tx) => {
    const revision = await publishBinding(tx, clusterId, policy, "manual", { save: true });
    await recordAudit(tx, actor, {
      action: "dns.binding_update",
      targetType: "cluster",
      targetId: clusterId,
      metadata: {
        mode: policy.mode,
        providerId: policy.providerId,
        domain: policy.domain,
        lines: policy.lines.length,
        revision: revision?.revision ?? null,
        recordCount: revision?.records.length ?? 0,
      },
    });
    return revision ? revisionDto(revision) : null;
  });
}
/** DNS revisions kept per binding (as many as its history lists). */
export const DNS_REVISION_RETENTION = 200;
/**
 * Deletes DNS revisions beyond the newest `keep` of each binding. The
 * desired and applied revisions and a held-back one stay.
 */
export async function pruneDnsRevisions(db: Executor, keep = DNS_REVISION_RETENTION) {
  const ranked = db
    .select({
      revision: schema.dnsRevision.revision,
      rank: sql<number>`row_number() over (partition by ${schema.dnsRevision.clusterId} order by ${schema.dnsRevision.revision} desc)`.as(
        "rank",
      ),
    })
    .from(schema.dnsRevision)
    .as("ranked");
  const inUse = (
    column: typeof schema.dnsBinding.desiredRevision | typeof schema.dnsBinding.appliedRevision,
  ) => db.select({ revision: column }).from(schema.dnsBinding).where(isNotNull(column));
  const deleted = await db
    .delete(schema.dnsRevision)
    .where(
      and(
        inArray(
          schema.dnsRevision.revision,
          db.select({ revision: ranked.revision }).from(ranked).where(gt(ranked.rank, keep)),
        ),
        ne(schema.dnsRevision.status, "blocked"),
        notInArray(schema.dnsRevision.revision, inUse(schema.dnsBinding.desiredRevision)),
        notInArray(schema.dnsRevision.revision, inUse(schema.dnsBinding.appliedRevision)),
      ),
    )
    .returning({ revision: schema.dnsRevision.revision });
  return deleted.length;
}

export async function listBindingRevisions(app: AppContext, clusterId: string) {
  await assertCluster(app.db, clusterId);
  return (
    await app.db
      .select()
      .from(schema.dnsRevision)
      .where(eq(schema.dnsRevision.clusterId, clusterId))
      .orderBy(desc(schema.dnsRevision.revision))
      .limit(DNS_REVISION_RETENTION)
  ).map(revisionDto);
}
/** Restores the binding settings of a revision; addresses follow current health. */
export async function rollbackBinding(
  app: AppContext,
  clusterId: string,
  revision: number,
  actor: Actor,
) {
  const row = await revisionRow(app.db, clusterId, revision);
  if (!row) fail("DNS_REVISION_NOT_FOUND", "DNS revision not found");
  const current = await loadBinding(app.db, clusterId);
  const policy = parsePolicy(row.policy, current.allLabel);
  if (!policy) fail("DNS_REVISION_NOT_FOUND", "DNS revision cannot be restored");
  policy.allLabel = current.allLabel;
  await validateBinding(app.db, clusterId, policy);
  return app.db.transaction(async (tx) => {
    const result = await publishBinding(tx, clusterId, policy, "rollback", { save: true });
    await recordAudit(tx, actor, {
      action: "dns.rollback",
      targetType: "cluster",
      targetId: clusterId,
      metadata: { fromRevision: revision, revision: result.revision },
    });
    return revisionDto(result);
  });
}
/** Publishes the current plan although the protection held one back (audited). */
export async function forceBindingPublish(
  app: AppContext,
  clusterId: string,
  blockedRevision: number,
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    const held = await revisionRow(tx, clusterId, blockedRevision);
    if (held?.status !== "blocked") fail("DNS_NOT_BLOCKED", "this DNS revision is not held back");
    const row = await lockBinding(tx, clusterId);
    const revision = await publishBinding(tx, clusterId, bindingPolicy(row), "force", {
      force: true,
    });
    await recordAudit(tx, actor, {
      action: "dns.force_publish",
      targetType: "cluster",
      targetId: clusterId,
      metadata: {
        blockedRevision,
        revision: revision.revision,
        recordCount: revision.records.length,
      },
    });
    return revisionDto(revision);
  });
}

/** The binding's records as absolute names plus a BIND zone file. */
export async function exportBinding(app: AppContext, clusterId: string) {
  await assertCluster(app.db, clusterId);
  const row = await loadBinding(app.db, clusterId);
  const policy = bindingPolicy(row);
  const provider = row.providerId ? await findProvider(app.db, row.providerId) : null;
  const zone = zoneOf(policy, provider);
  let records: DnsRecord[] = [];
  if (policy.mode === "manual")
    records = (await compileBindingPlan(app.db, clusterId, policy)).records;
  else if (policy.mode === "auto")
    records = (await revisionRow(app.db, clusterId, row.desiredRevision))?.records ?? [];
  const absoluteRecords = records.map((r) => ({
    ...r,
    name: absolute(r.name, zone),
  }));
  const width = Math.max(1, ...records.map((r) => r.name.length));
  const entry = (r: DnsRecord) =>
    `${r.name.padEnd(width)} ${r.ttl} IN ${r.type.padEnd(5)} ${r.type === "CNAME" ? `${r.data}.` : r.data}`;
  // BIND has no resolution lines: the zone file holds the default line; the
  // records of other lines follow as comments, to be created on those lines.
  const otherLines = [...new Set(records.map(lineOf).filter(Boolean))].sort();
  const zoneFile = zone
    ? [
        `$ORIGIN ${zone}.`,
        `$TTL ${policy.ttl}`,
        ...records.filter((r) => !lineOf(r)).map(entry),
        ...otherLines.flatMap((line) => [
          `; line ${line}`,
          ...records.filter((r) => lineOf(r) === line).map((r) => `; ${entry(r)}`),
        ]),
        "",
      ].join("\n")
    : "";
  return { origin: zone, records: absoluteRecords, zoneFile };
}

class Superseded extends Error {}
async function assertCurrent(app: AppContext, clusterId: string, revision: number) {
  if ((await loadBinding(app.db, clusterId)).desiredRevision !== revision) throw new Superseded();
}
function normalizeRecord(record: ProviderRecord): ProviderRecord {
  const type = record.type.toUpperCase(),
    ip = type === "A" || type === "AAAA" ? parseIp(record.data) : null;
  const { line, ...rest } = record;
  return {
    ...rest,
    type,
    name: record.name.replace(/\.$/, "").toLowerCase(),
    data: ip
      ? formatIp(ip)
      : type === "CNAME"
        ? record.data.replace(/\.$/, "").toLowerCase()
        : record.data,
    // The default line comes back as "" or "default"; other provider lines as "other:<id>".
    ...(lineOf({ line }) ? { line } : {}),
  };
}
const BATCH = 100;
/** Groups RRsets into batches of at most 100 records without splitting a set. */
function batches<T>(sets: T[][]) {
  const out: T[][] = [];
  let current: T[] = [];
  for (const set of sets) {
    if (current.length && current.length + set.length > BATCH) {
      out.push(current);
      current = [];
    }
    current.push(...set);
  }
  if (current.length) out.push(current);
  return out;
}
/** Data equality on the record's line; TTL counts only when `ttl` (providers round or raise TTLs). */
const sameAs =
  (ttl: boolean) => (r: { name: string; type: string; data: string; ttl: number; line?: string }) =>
    `${nameKey(r)}|${lineOf(r)}|${r.data}${ttl ? `|${r.ttl}` : ""}`;
/**
 * Brings one provider zone in line with the binding's plan: claims the
 * planned names (and checks that the claim holds), replaces changed RRsets
 * (a name and type on every resolution line: dns.set replaces the set on
 * all lines with the records given, which carry their line) in batches of
 * 100 (address sets before CNAMEs), deletes managed records
 * the plan no longer has, reads back, then releases retired names. New
 * records are written before the records they replace are deleted, so a
 * name does not resolve empty in between (an A set replaced by AAAA, a
 * run stopped by a newer revision or a provider error), except where DNS
 * requires otherwise: a name changing to or from a CNAME loses its old
 * records first, for one call. Only names this cluster claimed are ever
 * changed. TTLs count only when the binding's TTL changed since the
 * applied revision.
 */
async function reconcileProvider(
  app: AppContext,
  clusterId: string,
  p: Provider,
  revision: Revision,
  desired: DnsRecord[],
  desiredNames: ManagedName[],
  compareTtl: boolean,
) {
  const credentials = openProvider(app, p);
  const call = (command: "dns.list" | "dns.set" | "dns.cleanup", records?: ProviderRecord[]) =>
    certdDns<ProviderRecord[]>(app, command, {
      provider: p.provider,
      zone: p.zone,
      credentials,
      records,
    });
  const actual = (await call("dns.list")).map(normalizeRecord);
  const stored = await app.db
    .select()
    .from(schema.dnsManagedName)
    .where(eq(schema.dnsManagedName.providerId, p.id));
  const own = stored.filter((r) => r.clusterId === clusterId);
  const ownNames = new Set(own.map((r) => r.name));
  const otherNames = new Set(stored.filter((r) => r.clusterId !== clusterId).map((r) => r.name));
  for (const name of desiredNames) {
    if (otherNames.has(name.name))
      fail("DNS_BINDING_CONFLICT", "another cluster manages this DNS name");
    if (!ownNames.has(name.name) && actual.some((r) => r.name === name.name))
      fail("DNS_RECORD_CONFLICT", "DNS name contains an unmanaged record");
  }
  await assertCurrent(app, clusterId, revision.revision);
  if (desiredNames.length) {
    await app.db
      .insert(schema.dnsManagedName)
      .values(desiredNames.map((r) => ({ ...r, providerId: p.id, clusterId })))
      .onConflictDoNothing();
    // Another cluster may have claimed a name between the check and the insert.
    const wantedNames = new Set(desiredNames.map(nameKey));
    const claimed = await app.db
      .select()
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.providerId, p.id));
    if (claimed.some((r) => wantedNames.has(nameKey(r)) && r.clusterId !== clusterId))
      fail("DNS_BINDING_CONFLICT", "another cluster manages this DNS name");
  }
  const key = sameAs(compareTtl);
  const managed = new Set([...own, ...desiredNames].map(nameKey));
  const desiredSets = new Map<string, DnsRecord[]>();
  for (const r of desired) desiredSets.set(nameKey(r), [...(desiredSets.get(nameKey(r)) ?? []), r]);
  const actualManaged = actual.filter((r) => managed.has(nameKey(r)));
  const actualSets = new Map<string, ProviderRecord[]>();
  for (const r of actualManaged)
    actualSets.set(nameKey(r), [...(actualSets.get(nameKey(r)) ?? []), r]);
  const changed = [...desiredSets.entries()]
    .filter(([name, set]) => {
      const current = actualSets.get(name) ?? [];
      const wanted = new Set(set.map(key));
      return current.length !== set.length || current.some((r) => !wanted.has(key(r)));
    })
    .map(([, set]) => set);
  const stale = actualManaged.filter((r) => !desiredSets.has(nameKey(r)));
  const deleted = new Set<ProviderRecord>();
  const send = async (command: "dns.set" | "dns.cleanup", records: ProviderRecord[]) => {
    for (const chunk of batches(records.map((r) => [r]))) {
      await assertCurrent(app, clusterId, revision.revision);
      await call(command, chunk);
    }
  };
  for (const group of [
    changed.filter((set) => set[0]?.type !== "CNAME"),
    changed.filter((set) => set[0]?.type === "CNAME"),
  ])
    for (const batch of batches(group)) {
      const names = new Set(batch.map((r) => r.name));
      const cnames = new Set(batch.filter((r) => r.type === "CNAME").map((r) => r.name));
      const conflicts = stale.filter(
        (r) => names.has(r.name) && !deleted.has(r) && (r.type === "CNAME" || cnames.has(r.name)),
      );
      for (const r of conflicts) deleted.add(r);
      await send("dns.cleanup", conflicts);
      await assertCurrent(app, clusterId, revision.revision);
      await call("dns.set", batch);
    }
  await send(
    "dns.cleanup",
    stale.filter((r) => !deleted.has(r)),
  );
  const wanted = new Set(desired.map(sameAs(false)));
  const after = (await call("dns.list"))
    .map(normalizeRecord)
    .filter((r) => managed.has(nameKey(r)));
  if (after.length !== desired.length || after.some((r) => !wanted.has(sameAs(false)(r))))
    throw new Error("DNS readback mismatch");
  const keep = new Set(desiredNames.map(nameKey));
  const retired = own.filter((name) => !keep.has(nameKey(name))).map(nameKey);
  if (retired.length)
    await app.db.execute(
      sql`delete from dns_managed_name where provider_id=${p.id}::uuid and cluster_id=${clusterId}::uuid and (name || '|' || type) in (select jsonb_array_elements_text(${JSON.stringify(retired)}::jsonb))`,
    );
}

/**
 * Publishes (health) and writes one binding's records. One run per binding
 * at a time (a lease, so no connection waits on a provider); other bindings
 * are not affected by this one's provider. The active account is written
 * first; a failing account the cluster used before is cleaned later and only
 * marks the revision failed.
 */
export async function reconcileBinding(
  app: AppContext,
  clusterId: string,
  actor: Actor = systemActor,
) {
  await withLease(app.db, `binding:${clusterId}`, 15 * 60, async () => {
    const row = await loadBinding(app.db, clusterId);
    const owned = await app.db
      .select({ providerId: schema.dnsManagedName.providerId })
      .from(schema.dnsManagedName)
      .where(eq(schema.dnsManagedName.clusterId, clusterId));
    // Manual bindings are not written; off bindings only while they still own records.
    if (row.mode === "manual" || (row.mode === "off" && !owned.length && !row.desiredRevision))
      return;
    const revision = await app.db.transaction(async (tx) => {
      const current = await lockBinding(tx, clusterId);
      return publishBinding(tx, clusterId, bindingPolicy(current), "health");
    });
    const policy = parsePolicy(revision.policy, row.allLabel);
    // Switched to manual meanwhile (hands off), or held back with nothing to keep.
    if (!policy || policy.mode === "manual" || revision.status === "blocked") return;
    const applied = await revisionRow(app.db, clusterId, row.appliedRevision);
    const compareTtl = parsePolicy(applied?.policy ?? {}, row.allLabel)?.ttl !== policy.ttl;
    try {
      const active = policy.mode === "auto" ? revision.providerId : null;
      const retired = [...new Set(owned.map((o) => o.providerId))]
        .filter((id) => id !== active)
        .sort();
      if (active)
        await reconcileProvider(
          app,
          clusterId,
          await findProvider(app.db, active),
          revision,
          revision.records,
          revision.managedNames,
          compareTtl,
        );
      let retiredError: unknown;
      for (const providerId of retired) {
        try {
          const p = await findProvider(app.db, providerId);
          await reconcileProvider(app, clusterId, p, revision, [], [], compareTtl);
        } catch (error) {
          if (error instanceof Superseded) throw error;
          retiredError ??= error;
        }
      }
      if (retiredError) throw retiredError;
      await assertCurrent(app, clusterId, revision.revision);
      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.dnsRevision)
          .set({ status: "applied", lastError: "", appliedAt: new Date() })
          .where(eq(schema.dnsRevision.revision, revision.revision));
        await tx
          .update(schema.dnsBinding)
          .set({ appliedRevision: revision.revision })
          .where(
            and(
              eq(schema.dnsBinding.clusterId, clusterId),
              eq(schema.dnsBinding.desiredRevision, revision.revision),
            ),
          );
        if (revision.status !== "applied")
          await recordAudit(tx, actor, {
            action: "dns.applied",
            targetType: "cluster",
            targetId: clusterId,
            metadata: { revision: revision.revision, records: revision.records.length },
          });
      });
    } catch (error) {
      if (error instanceof Superseded) {
        await app.db
          .update(schema.dnsRevision)
          .set({ status: "superseded" })
          .where(eq(schema.dnsRevision.revision, revision.revision));
        return;
      }
      await app.db
        .update(schema.dnsRevision)
        .set({ status: "failed", lastError: errorCode(error) })
        .where(eq(schema.dnsRevision.revision, revision.revision));
      app.log.warn("DNS reconciliation failed", {
        clusterId,
        revision: revision.revision,
        code: errorCode(error),
      });
      throw error;
    }
  });
}

/**
 * Reconciles every binding that is automatic or still owns records, four at
 * a time; a failing provider only fails its own clusters. With a cluster id,
 * reconciles that binding and reports its error.
 */
export async function reconcileDns(
  app: AppContext,
  actor: Actor = systemActor,
  clusterId?: string,
) {
  if (clusterId) {
    await assertCluster(app.db, clusterId);
    await reconcileBinding(app, clusterId, actor);
    return { ok: true as const };
  }
  const bindings = await app.db
    .select({ clusterId: schema.dnsBinding.clusterId })
    .from(schema.dnsBinding)
    .where(ne(schema.dnsBinding.mode, "manual"));
  const owners = await app.db
    .selectDistinct({ clusterId: schema.dnsManagedName.clusterId })
    .from(schema.dnsManagedName);
  const queue = [...new Set([...bindings, ...owners].map((b) => b.clusterId))].sort();
  const failures: string[] = [];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await reconcileBinding(app, id, actor);
      } catch {
        failures.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { ok: true as const, failures };
}

/** Refused while the cluster's binding still owns records at a provider. */
export async function assertBindingReleased(db: Executor, clusterId: string) {
  const [owned] = await db
    .select({ name: schema.dnsManagedName.name })
    .from(schema.dnsManagedName)
    .where(eq(schema.dnsManagedName.clusterId, clusterId))
    .limit(1);
  const row = await loadBinding(db, clusterId);
  if (owned || row.mode === "auto")
    fail("DNS_BINDING_IN_USE", "turn the cluster's DNS off and wait for its records to be removed");
}

export async function siteDnsTarget(app: AppContext, siteId: string) {
  const site = await findSite(app.db, siteId);
  const row = await loadBinding(app.db, site.clusterId);
  if (row.mode === "off" || !row.domain)
    return { target: null, mode: "off" as const, published: false, healthy: false, lines: [] };
  const target = `${site.id}.${row.domain}`;
  const groups = await app.db
    .select()
    .from(schema.nodeGroup)
    .where(eq(schema.nodeGroup.clusterId, site.clusterId));
  const lines = row.lines
    .filter((l) => groups.some((g) => g.id === l.nodeGroupId))
    .map((l) => ({
      name: l.name,
      target: row.lineAliases ? `${l.name}.${target}` : `${l.name}.${row.domain}`,
    }));
  if (row.mode === "manual")
    return { target, mode: "manual" as const, published: false, healthy: false, lines };
  const provider = row.providerId ? await findProvider(app.db, row.providerId) : null;
  const revision = await revisionRow(app.db, site.clusterId, row.desiredRevision);
  const allName = provider ? relative(`${row.allLabel}.${row.domain}`, provider.zone) : "";
  return {
    target,
    mode: "auto" as const,
    published: row.appliedRevision === row.desiredRevision && revision?.status === "applied",
    healthy: !!revision?.records.some((r) => r.name === allName && addressRecord(r)),
    lines,
  };
}
