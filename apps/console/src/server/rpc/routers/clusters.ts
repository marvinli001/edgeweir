import { schema } from "@edgeweir/db";
import { desc, eq } from "drizzle-orm";
import {
  createCluster,
  deleteCluster,
  getCluster,
  listClusters,
  previewRollback,
  rollbackCluster,
  updateCluster,
} from "../../services/clusters";
import { createEnrollmentToken, getEnrollmentToken } from "../../services/enrollment";
import { getPortPools, setPortPools } from "../../services/l4";
import {
  createNodeGroup,
  deleteNodeGroup,
  listNodeGroups,
  updateNodeGroup,
} from "../../services/node-groups";
import {
  deleteNode,
  getNode,
  listNodes,
  setNodeAddresses,
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
export const clustersRouter = {
  probes: {
    list: authed.probes.list.handler(({ context }) => listProbes(context.app.db)),
    createToken: authed.probes.createToken.handler(({ input, context }) =>
      createProbeToken(context.app.db, input, {
        actor: context.actor,
        serverUrl: context.app.env.nodeApiUrl,
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
    createEnrollmentToken: authed.clusters.createEnrollmentToken.handler(({ input, context }) =>
      createEnrollmentToken(context.app.db, input, {
        actor: context.actor,
        consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: context.app.env.nodeApiUrl,
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
    setProbe: authed.nodes.setProbe.handler(({ input, context }) =>
      setNodeProbe(context.app.db, input, context.actor),
    ),
    setAddresses: authed.nodes.setAddresses.handler(({ input, context }) =>
      setNodeAddresses(context.app.db, input, context.actor),
    ),
  },
};
