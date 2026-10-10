/**
 * Fixture answers by procedure (define.ts): the platform core here, the pages' own data in one
 * file per area. Procedures without a handler answer emptyOutput(); the lab's empty state
 * answers from empty-state.ts.
 */
import type { Site, SiteCopyChange, SiteCopyPart } from "@edgeweir/contract";
import { accessFixtures } from "./access";
import { accessControlFixtures } from "./access-control";
import { type Fixtures, mergeFixtures, notFound, ok } from "./define";
import { infraFixtures } from "./infra";
import { siteDetailFixtures } from "./sites-detail";
import { systemFixtures } from "./system";
import {
  breakdownOf,
  dimensionsOf,
  topNodesOf,
  topRequestsOf,
  topSitesOf,
  trafficOf,
} from "./traffic";
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
  tagSeeds,
} from "./world";

export type { Fixtures } from "./define";

/** The page the lab shows now (hash history). */
const currentPath = () => window.location.hash.replace(/^#/, "").split("?")[0] || "/";

/** A list input that a query string may also give as one value. */
const asList = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

function siteById(id: string): Site {
  const site = sites.find((s) => s.id === id);
  if (!site) throw notFound();
  return site;
}

const core: Fixtures = {
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
    dimensions: (input) => dimensionsOf(input.range ?? "24h", input.siteId),
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
  siteTags: {
    list: () =>
      tagSeeds.map((tag) => ({
        ...tag,
        sites: sites.filter((site) => site.tags.some((t) => t.id === tag.id)).length,
      })),
    rename: ({ id, name }) => {
      const tag = tagSeeds.find((t) => t.id === id);
      if (!tag) throw notFound();
      tag.name = name;
      for (const site of sites) for (const t of site.tags) if (t.id === id) t.name = name;
      return { ...tag, sites: sites.filter((site) => site.tags.some((t) => t.id === id)).length };
    },
    delete: ({ id }) => {
      tagSeeds.splice(
        tagSeeds.findIndex((t) => t.id === id),
        1,
      );
      for (const site of sites) site.tags = site.tags.filter((t) => t.id !== id);
      return ok;
    },
  },
  sites: {
    list: (input) => {
      const search = input.search?.toLowerCase() ?? "";
      const tagIds = (input.tagIds ?? []) as string[];
      const tagged = (s: Site) =>
        !tagIds.length ||
        (input.tagMatch === "all"
          ? tagIds.every((id) => s.tags.some((t) => t.id === id))
          : tagIds.some((id) => s.tags.some((t) => t.id === id)));
      const matching = sites.filter(
        (s) =>
          (!input.clusterId || s.clusterId === input.clusterId) &&
          tagged(s) &&
          (!search ||
            s.name.toLowerCase().includes(search) ||
            s.domains.some((d) => d.includes(search)) ||
            s.tags.some((t) => t.name.toLowerCase().includes(search))),
      );
      const ordered = [...matching].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const page = Number(input.page ?? 1);
      const size = Number(input.pageSize ?? 20);
      return { items: ordered.slice((page - 1) * size, page * size), total: matching.length };
    },
    get: ({ id }) => siteById(id),
    setTags: ({ id, tags }) => {
      const site = siteById(id);
      site.tags = tags.map((name) => {
        let tag = tagSeeds.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (!tag) {
          tag = { id: crypto.randomUUID(), name };
          tagSeeds.push(tag);
        }
        return { id: tag.id, name: tag.name };
      });
      return { tags: site.tags };
    },
    batchSetEnabled: ({ ids, enabled }) => {
      const changed = sites.filter((s) => ids.includes(s.id) && s.enabled !== enabled);
      for (const site of changed) site.enabled = enabled;
      return { changed: changed.map((s) => ({ id: s.id, name: s.name })), revisions: [] };
    },
    batchTags: ({ ids }) => ({
      changed: sites.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
      revisions: [],
    }),
    batchDelete: ({ ids }) => ({
      changed: sites.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
      revisions: [],
    }),
    copySettingsPreview: ({ id, targetIds, parts }) => ({
      source: { id, name: siteById(id).name },
      targets: asList(targetIds).map((targetId, i) => ({
        id: targetId,
        name: siteById(targetId).name,
        // The second target lacks the source's origin group.
        error:
          i === 1 && asList(parts).includes("rules")
            ? { code: "ORIGIN_GROUP_UNKNOWN", message: "", data: { group: "eu", rule: "media" } }
            : null,
        changes: asList(parts).map(
          (part: SiteCopyPart, j): SiteCopyChange =>
            part === "cacheRules" || part === "rules"
              ? { part, changed: true, before: j, after: j + 2, fields: null }
              : {
                  part,
                  changed: j % 3 !== 2,
                  before: null,
                  after: null,
                  fields: j % 3 === 2 ? 0 : 2,
                },
        ),
      })),
    }),
    copySettings: ({ targetIds, parts }) => ({
      targets: targetIds.map((targetId, i) => ({
        id: targetId,
        name: siteById(targetId).name,
        ok: i !== 1,
        changed: i === 1 ? [] : parts,
        revision: null,
        error:
          i === 1
            ? { code: "ORIGIN_GROUP_UNKNOWN", message: "", data: { group: "eu", rule: "media" } }
            : null,
      })),
    }),
    clone: ({ id, name, domains }) => {
      const source = siteById(id);
      return {
        site: { ...source, id: crypto.randomUUID(), name: name ?? domains[0] ?? "", domains },
        revision: revisionsOf(source.clusterId, 1)[0] as never,
      };
    },
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
    features: ({ id }) => {
      const on = { available: true, reason: null };
      // download.example.com's cluster has a node of an older release (traffic.ts PARTIAL_SITES).
      const older =
        sites.find((s) => s.id === id)?.name === "download.example.com"
          ? { available: false, reason: "nodes" as const }
          : on;
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
        rulesV3: on,
        edgePorts: on,
        clientIp: on,
        siteContent: on,
        domainsV2: on,
        multiCertificate: on,
        clientCertificate: on,
        accessAuth: on,
        accessControl: on,
        wafV2: on,
        rulesBody: on,
        challengeV2: on,
        accessLogsV2: older,
      };
    },
  },
};

export const fixtures: Fixtures = mergeFixtures(
  core,
  siteDetailFixtures,
  accessFixtures,
  accessControlFixtures,
  infraFixtures,
  systemFixtures,
);
