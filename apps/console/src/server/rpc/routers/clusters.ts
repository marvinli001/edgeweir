import { schema } from "@edgeweir/db";
import { desc, eq } from "drizzle-orm";
import type { AppContext } from "../../lib/context";
import { outboundAddress } from "../../lib/outbound";
import type { Actor } from "../../services/audit";
import {
  createCluster,
  deleteCluster,
  getCluster,
  listClusters,
  previewRollback,
  rollbackCluster,
  setClusterCache,
  updateCluster,
} from "../../services/clusters";
import {
  getClientIp,
  getConnectionLimits,
  getListenPorts,
  getUnknownHosts,
  setClientIp,
  setConnectionLimits,
  setListenPorts,
  setUnknownHosts,
} from "../../services/edge";
import { createEnrollmentToken, getEnrollmentToken } from "../../services/enrollment";
import {
  checkProbeSource,
  createProbeSource,
  deleteProbeSource,
  listProbeModes,
  listProbeSourceMappings,
  listProbeSourceMonitors,
  listProbeSourceResults,
  listProbeSources,
  rotateProbeSourceSecret,
  setClusterProbeMode,
  setProbeSourceMappings,
  updateProbeSource,
} from "../../services/external-probes";
import { getPortPools, setPortPools } from "../../services/l4";
import { nodeChannelUrl } from "../../services/node-channel-url";
import { getDebugLog, listDebugLogs, pullDebugLogs } from "../../services/node-debug-logs";
import { cancelDecommission, requestDecommission } from "../../services/node-decommission";
import {
  createNodeGroup,
  deleteNodeGroup,
  listNodeGroups,
  updateNodeGroup,
} from "../../services/node-groups";
import { listNodeLogs } from "../../services/node-logs";
import {
  deleteNode,
  getNode,
  listNodes,
  setNodeAddresses,
  setNodeCache,
  setNodeProbe,
  setNodeStatus,
  updateNode,
} from "../../services/nodes";
import {
  createProbeToken,
  deleteProbe,
  listProbeResults,
  listProbes,
  updateProbe,
} from "../../services/probes";
import { createRegion, deleteRegion, listRegions, updateRegion } from "../../services/regions";
import { toRevisionDto } from "../../services/revisions";
import { abortRollout, getRollout, promoteRollout, setRolloutPolicy } from "../../services/rollout";
import {
  createSchedulingRule,
  deleteSchedulingRule,
  listSchedulingRules,
  previewScheduling,
  updateSchedulingRule,
} from "../../services/scheduling";
import type { InstallContext } from "../../services/ssh-install";
import {
  cancelUpgrade,
  createUpgrade,
  latestNodeVersion,
  listUpgrades,
  nodeRelease,
  promoteUpgrade,
} from "../../services/upgrades";
import { authed, ok } from "../base";

/** Clusters, node groups, regions, nodes, upgrades, probes and scheduling. */
/** What an SSH install run needs from the request: the caller and the install command's URLs. */
async function installContext(context: { app: AppContext; actor: Actor }): Promise<InstallContext> {
  return {
    db: context.app.db,
    log: context.app.log.child({ component: "ssh-install" }),
    actor: context.actor,
    consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
    serverUrl: await nodeChannelUrl(context.app),
    caSha256: context.app.nodeCa.fingerprintSha256,
    resolve: outboundResolver(context.app),
  };
}

/** SSH hosts are outbound targets like any other the operator names (lib/outbound.ts). */
function outboundResolver(app: AppContext) {
  return async (host: string) => (await outboundAddress(app, host)).address;
}

export const clustersRouter = {
  sshInstalls: {
    scanHostKeys: authed.sshInstalls.scanHostKeys.handler(async ({ input, context }) => ({
      hosts: await context.app.sshInstalls.scanHostKeys(input.hosts, outboundResolver(context.app)),
    })),
    start: authed.sshInstalls.start.handler(async ({ input, context }) =>
      context.app.sshInstalls.start(input, await installContext(context)),
    ),
    get: authed.sshInstalls.get.handler(({ input, context }) =>
      context.app.sshInstalls.get(input.id),
    ),
    cancel: authed.sshInstalls.cancel.handler(({ input, context }) =>
      context.app.sshInstalls.cancel(input.id, context.actor),
    ),
    retry: authed.sshInstalls.retry.handler(async ({ input, context }) =>
      context.app.sshInstalls.retry(input, await installContext(context)),
    ),
  },
  probes: {
    list: authed.probes.list.handler(({ context }) => listProbes(context.app.db)),
    createToken: authed.probes.createToken.handler(async ({ input, context }) =>
      createProbeToken(context.app.db, input, {
        actor: context.actor,
        serverUrl: await nodeChannelUrl(context.app),
        caSha256: context.app.nodeCa.fingerprintSha256,
      }),
    ),
    update: authed.probes.update.handler(({ input, context }) =>
      updateProbe(context.app.db, input, context.actor),
    ),
    delete: authed.probes.delete.handler(({ input, context }) =>
      deleteProbe(context.app.db, input.id, context.actor),
    ),
    results: authed.probes.results.handler(({ input, context }) =>
      listProbeResults(context.app.db, input),
    ),
  },
  probeSources: {
    list: authed.probeSources.list.handler(({ context }) => listProbeSources(context.app)),
    create: authed.probeSources.create.handler(({ input, context }) =>
      createProbeSource(context.app, input, context.actor),
    ),
    update: authed.probeSources.update.handler(({ input, context }) =>
      updateProbeSource(context.app, input, context.actor),
    ),
    delete: authed.probeSources.delete.handler(async ({ input, context }) => {
      await deleteProbeSource(context.app, input.id, context.actor);
      return { ok: true as const };
    }),
    rotateWebhookSecret: authed.probeSources.rotateWebhookSecret.handler(({ input, context }) =>
      rotateProbeSourceSecret(context.app, input.id, context.actor),
    ),
    check: authed.probeSources.check.handler(({ input, context }) =>
      checkProbeSource(context.app, input),
    ),
    monitors: authed.probeSources.monitors.handler(({ input, context }) =>
      listProbeSourceMonitors(context.app, input.id),
    ),
    mappings: authed.probeSources.mappings.handler(({ input, context }) =>
      listProbeSourceMappings(context.app.db, input.id),
    ),
    setMappings: authed.probeSources.setMappings.handler(
      async ({ input, context }) =>
        (await setProbeSourceMappings(context.app.db, input.id, input.mappings, context.actor))
          .mappings,
    ),
    results: authed.probeSources.results.handler(({ input, context }) =>
      listProbeSourceResults(context.app.db, input.id),
    ),
    modes: authed.probeSources.modes.handler(({ context }) => listProbeModes(context.app.db)),
    setClusterMode: authed.probeSources.setClusterMode.handler(({ input, context }) =>
      setClusterProbeMode(context.app.db, input.clusterId, input.mode, context.actor),
    ),
  },
  scheduling: {
    list: authed.scheduling.list.handler(({ input, context }) =>
      listSchedulingRules(context.app.db, input.clusterId),
    ),
    create: authed.scheduling.create.handler(({ input, context }) =>
      createSchedulingRule(context.app.db, input, context.actor),
    ),
    update: authed.scheduling.update.handler(({ input, context }) =>
      updateSchedulingRule(context.app, input, context.actor),
    ),
    delete: authed.scheduling.delete.handler(({ input, context }) =>
      deleteSchedulingRule(context.app, input.id, context.actor),
    ),
    preview: authed.scheduling.preview.handler(({ input, context }) =>
      previewScheduling(context.app.db, input.clusterId),
    ),
  },
  upgrades: {
    release: authed.upgrades.release.handler(({ input, context }) =>
      nodeRelease(context.app, input.version),
    ),
    latestVersion: authed.upgrades.latestVersion.handler(async ({ context }) => ({
      version: await latestNodeVersion(context.app),
    })),
    list: authed.upgrades.list.handler(({ input, context }) =>
      listUpgrades(context.app, input.clusterId),
    ),
    create: authed.upgrades.create.handler(({ input, context }) =>
      createUpgrade(context.app, input, context.actor),
    ),
    promote: authed.upgrades.promote.handler(({ input, context }) =>
      promoteUpgrade(context.app, input.id, context.actor),
    ),
    cancel: authed.upgrades.cancel.handler(({ input, context }) =>
      cancelUpgrade(context.app, input.id, context.actor),
    ),
  },
  clusters: {
    list: authed.clusters.list.handler(({ context }) => listClusters(context.app.db)),
    get: authed.clusters.get.handler(({ input, context }) => getCluster(context.app.db, input.id)),
    create: authed.clusters.create.handler(({ input, context }) =>
      createCluster(context.app.db, input, context.actor),
    ),
    update: authed.clusters.update.handler(({ input, context }) =>
      updateCluster(context.app.db, input, context.actor),
    ),
    delete: authed.clusters.delete.handler(async ({ input, context }) => {
      await deleteCluster(context.app.db, input.id, context.actor);
      return ok;
    }),
    revisions: authed.clusters.revisions.handler(async ({ input, context }) => {
      await getCluster(context.app.db, input.id);
      const rows = await context.app.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, input.id))
        .orderBy(desc(schema.configRevision.revision))
        .limit(100);
      return rows.map(toRevisionDto);
    }),
    rollback: authed.clusters.rollback.handler(({ input, context }) =>
      rollbackCluster(context.app.db, input, context.actor),
    ),
    rollbackPreview: authed.clusters.rollbackPreview.handler(({ input, context }) =>
      previewRollback(context.app.db, input),
    ),
    rollout: authed.clusters.rollout.handler(({ input, context }) =>
      getRollout(context.app.db, input.id),
    ),
    setRolloutPolicy: authed.clusters.setRolloutPolicy.handler(({ input, context }) =>
      setRolloutPolicy(context.app.db, input, context.actor),
    ),
    promoteRollout: authed.clusters.promoteRollout.handler(({ input, context }) =>
      promoteRollout(context.app.db, input.id, context.actor),
    ),
    abortRollout: authed.clusters.abortRollout.handler(({ input, context }) =>
      abortRollout(context.app.db, input.id, context.actor),
    ),
    portPools: authed.clusters.portPools.handler(({ input, context }) =>
      getPortPools(context.app.db, input.clusterId),
    ),
    setPortPools: authed.clusters.setPortPools.handler(({ input, context }) =>
      setPortPools(context.app.db, input, context.actor),
    ),
    listenPorts: authed.clusters.listenPorts.handler(({ input, context }) =>
      getListenPorts(context.app.db, input.clusterId),
    ),
    setListenPorts: authed.clusters.setListenPorts.handler(({ input, context }) =>
      setListenPorts(context.app.db, input, context.actor),
    ),
    clientIp: authed.clusters.clientIp.handler(({ input, context }) =>
      getClientIp(context.app.db, input.clusterId),
    ),
    setClientIp: authed.clusters.setClientIp.handler(({ input, context }) =>
      setClientIp(context.app.db, input, context.actor),
    ),
    unknownHosts: authed.clusters.unknownHosts.handler(({ input, context }) =>
      getUnknownHosts(context.app.db, input.clusterId),
    ),
    setUnknownHosts: authed.clusters.setUnknownHosts.handler(({ input, context }) =>
      setUnknownHosts(context.app.db, input, context.actor),
    ),
    connectionLimits: authed.clusters.connectionLimits.handler(({ input, context }) =>
      getConnectionLimits(context.app.db, input.clusterId),
    ),
    setConnectionLimits: authed.clusters.setConnectionLimits.handler(({ input, context }) =>
      setConnectionLimits(context.app.db, input, context.actor),
    ),
    setCache: authed.clusters.setCache.handler(({ input, context }) =>
      setClusterCache(context.app.db, input, context.actor),
    ),
    createEnrollmentToken: authed.clusters.createEnrollmentToken.handler(
      async ({ input, context }) =>
        createEnrollmentToken(context.app.db, input, {
          actor: context.actor,
          consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
          serverUrl: await nodeChannelUrl(context.app),
          caSha256: context.app.nodeCa.fingerprintSha256,
        }),
    ),
    getEnrollmentToken: authed.clusters.getEnrollmentToken.handler(({ input, context }) =>
      getEnrollmentToken(context.app.db, input.id),
    ),
  },
  nodeGroups: {
    list: authed.nodeGroups.list.handler(({ input, context }) =>
      listNodeGroups(context.app.db, input.clusterId),
    ),
    create: authed.nodeGroups.create.handler(({ input, context }) =>
      createNodeGroup(context.app.db, input, context.actor),
    ),
    update: authed.nodeGroups.update.handler(({ input, context }) =>
      updateNodeGroup(context.app.db, input, context.actor),
    ),
    delete: authed.nodeGroups.delete.handler(async ({ input, context }) => {
      await deleteNodeGroup(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  regions: {
    list: authed.regions.list.handler(({ context }) => listRegions(context.app.db)),
    create: authed.regions.create.handler(({ input, context }) =>
      createRegion(context.app.db, input, context.actor),
    ),
    update: authed.regions.update.handler(({ input, context }) =>
      updateRegion(context.app.db, input, context.actor),
    ),
    delete: authed.regions.delete.handler(async ({ input, context }) => {
      await deleteRegion(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  nodes: {
    list: authed.nodes.list.handler(({ input, context }) =>
      listNodes(context.app.db, input.clusterId),
    ),
    get: authed.nodes.get.handler(({ input, context }) => getNode(context.app.db, input.id)),
    update: authed.nodes.update.handler(({ input, context }) =>
      updateNode(context.app.db, input, context.actor),
    ),
    disable: authed.nodes.disable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "disabled", context.actor),
    ),
    enable: authed.nodes.enable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "active", context.actor),
    ),
    delete: authed.nodes.delete.handler(async ({ input, context }) => {
      await deleteNode(context.app.db, input.id, context.actor);
      return ok;
    }),
    decommission: authed.nodes.decommission.handler(({ input, context }) =>
      requestDecommission(context.app, context.actor, input.id),
    ),
    cancelDecommission: authed.nodes.cancelDecommission.handler(({ input, context }) =>
      cancelDecommission(context.app, context.actor, input.id),
    ),
    setProbe: authed.nodes.setProbe.handler(({ input, context }) =>
      setNodeProbe(context.app.db, input, context.actor),
    ),
    setAddresses: authed.nodes.setAddresses.handler(({ input, context }) =>
      setNodeAddresses(context.app.db, input, context.actor),
    ),
    setCache: authed.nodes.setCache.handler(({ input, context }) =>
      setNodeCache(context.app.db, input, context.actor),
    ),
    logs: authed.nodes.logs.handler(({ input, context }) =>
      listNodeLogs(context.app.db, input, context.demo),
    ),
    debugLogs: authed.nodes.debugLogs.handler(({ input, context }) =>
      listDebugLogs(context.app.db, input.id),
    ),
    debugLog: authed.nodes.debugLog.handler(({ input, context }) =>
      getDebugLog(context.app.db, input, context.demo),
    ),
    pullDebugLogs: authed.nodes.pullDebugLogs.handler(({ input, context }) =>
      pullDebugLogs(context.app, context.actor, input),
    ),
  },
};
