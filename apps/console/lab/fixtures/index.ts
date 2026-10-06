/**
 * Fixture answers by procedure, typed by the contract's client: a handler takes the procedure's
 * input and returns its output. Procedures without a handler answer emptyOutput().
 */
import type { Contract, Site } from "@edgeweir/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { breakdownOf, topNodesOf, topRequestsOf, topSitesOf, trafficOf } from "./traffic";
import {
  ago,
  attention,
  clusters,
  DAY,
  MINUTE,
  nodeGroups,
  nodes,
  originHealthOf,
  regions,
  revisionsOf,
  sites,
  starredIds,
} from "./world";

type Handler<T extends (...args: never[]) => unknown> = (
  input: Parameters<T>[0],
) => Awaited<ReturnType<T>> | Promise<Awaited<ReturnType<T>>>;

type Fixture<T> = T extends (...args: never[]) => unknown
  ? Handler<T>
  : { [K in keyof T]?: Fixture<T[K]> };

export type Fixtures = Fixture<ContractRouterClient<Contract>>;

/** The page the lab shows now (hash history). */
const currentPath = () => window.location.hash.replace(/^#/, "").split("?")[0] || "/";

const notFound = () => Object.assign(new Error("Not found"), { status: 404, code: "NOT_FOUND" });

function siteById(id: string): Site {
  const site = sites.find((s) => s.id === id);
  if (!site) throw notFound();
  return site;
}

const ok = { ok: true } as const;

export const fixtures: Fixtures = {
  system: {
    // /setup only renders before the console is initialized.
    status: () => ({ initialized: currentPath() !== "/setup", version: "20261006-afad833" }),
    setup: () => ({ userId: "lab-operator" }),
  },
  account: {
    me: () => ({
      user: {
        id: "lab-operator",
        name: "Operator",
        email: "ops@example.com",
        twoFactorEnabled: true,
      },
      serviceAccount: null,
    }),
  },
  overview: {
    get: () => ({
      clusters: clusters.length,
      nodes: nodes.length,
      onlineNodes: nodes.filter((n) => n.online).length,
      sites: sites.length,
      revisions: clusters
        .flatMap((c) => revisionsOf(c.id, 4))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6),
      attention,
    }),
  },
  analytics: {
    traffic: (input) => trafficOf(input.range ?? "24h", input.siteId),
    topSites: (input) => topSitesOf(input.range ?? "24h", Number(input.limit ?? 5)),
    topNodes: (input) => topNodesOf(input.range ?? "24h", Number(input.limit ?? 5)),
    breakdown: (input) =>
      breakdownOf({
        ...input,
        range: input.range ?? "24h",
        metric: input.metric ?? "requests",
        limit: Number(input.limit ?? 10),
        statusClass: input.statusClass === undefined ? undefined : Number(input.statusClass),
      }),
    topRequests: (input) =>
      topRequestsOf(input.range ?? "24h", input.by, input.limit ?? 10, input.siteId),
  },
  clusters: {
    list: () => clusters,
    get: ({ id }) => clusters.find((c) => c.id === id) ?? Promise.reject(notFound()),
    revisions: ({ id }) => revisionsOf(id),
    rollout: ({ id }) => ({
      clusterId: id,
      policy: {
        enabled: id === clusters[0]?.id,
        windowSeconds: 600,
        autoPromote: true,
        errorRatioMultiplier: 3,
        errorRatioFloor: 0.02,
        minRequests: 500,
      },
      state: "idle",
      stableRevision: clusters.find((c) => c.id === id)?.latestRevision?.revision ?? null,
      candidateRevision: null,
      lastCandidateRevision: null,
      windowStartedAt: null,
      windowEndsAt: null,
      outcome: "",
      finishedAt: null,
      canaryNodes: nodes
        .filter(
          (n) => n.clusterId === id && nodeGroups.find((g) => g.id === n.nodeGroupId)?.isCanary,
        )
        .map((n) => ({
          id: n.id,
          name: n.name,
          online: n.online,
          appliedRevision: n.appliedRevision,
          participating: false,
        })),
      window: null,
      candidateChanges: null,
      policyUpdatedAt: ago(30 * DAY),
      updatedAt: ago(4 * MINUTE),
    }),
  },
  nodeGroups: {
    list: (input) => nodeGroups.filter((g) => !input.clusterId || g.clusterId === input.clusterId),
  },
  regions: {
    list: () => regions,
  },
  nodes: {
    list: (input) => nodes.filter((n) => !input.clusterId || n.clusterId === input.clusterId),
    get: ({ id }) => nodes.find((n) => n.id === id) ?? Promise.reject(notFound()),
  },
  upgrades: {
    latestVersion: () => ({ version: "0.2.1" }),
    list: () => [],
  },
  sites: {
    list: (input) => {
      const search = input.search?.toLowerCase() ?? "";
      const matching = sites.filter(
        (s) =>
          (!input.clusterId || s.clusterId === input.clusterId) &&
          (!search ||
            s.name.toLowerCase().includes(search) ||
            s.domains.some((d) => d.includes(search))),
      );
      const ordered = [...matching].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const page = Number(input.page ?? 1);
      const size = Number(input.pageSize ?? 20);
      return { items: ordered.slice((page - 1) * size, page * size), total: matching.length };
    },
    get: ({ id }) => siteById(id),
    starred: () =>
      sites
        .filter((s) => starredIds.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, domains: s.domains })),
    setStarred: ({ id, starred }) => {
      if (starred) starredIds.add(id);
      else starredIds.delete(id);
      return ok;
    },
    launch: ({ id }) => {
      const site = siteById(id);
      const addresses = nodes
        .filter((n) => n.clusterId === site.clusterId && n.online)
        .flatMap((n) => n.ipAddresses);
      return {
        addresses,
        domains: site.domains.map((name) => ({ name, probe: name, pointing: "ok" as const })),
        certificate: {
          state: "covered" as const,
          id: null,
          name: site.domains[0] ?? site.name,
          uncovered: [],
          error: "",
        },
        delivery: site.delivery,
      };
    },
    originHealth: ({ id }) => originHealthOf(id),
    features: () => {
      const on = { available: true, reason: null };
      return {
        brotli: on,
        zstd: on,
        crs: on,
        activeHealthCheck: on,
        sessionAffinity: on,
        originHttp2: on,
        errorPages: on,
        purgeByTag: on,
        prefetchVariants: on,
        rulesV2: on,
      };
    },
  },
};
