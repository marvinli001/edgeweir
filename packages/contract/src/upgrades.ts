import { oc } from "@orpc/contract";
import * as z from "zod";
export const releaseVersion = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .max(64);
const artifact = z.object({
  arch: z.enum(["amd64", "arm64"]),
  archiveUrl: z.url(),
  sha256: z.string(),
  checksumsUrl: z.url(),
  signatureUrl: z.url(),
});
const release = z.object({ version: releaseVersion, artifacts: z.array(artifact) });
const delivery = z.object({
  id: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
  phase: z.enum(["canary", "rollout"]),
  state: z.enum(["held", "pending", "running", "succeeded", "failed", "cancelled"]),
  message: z.string(),
  errorCode: z.string(),
  finishedAt: z.string().nullable(),
});
export const upgradeJob = z.object({
  id: z.string(),
  clusterId: z.string(),
  clusterName: z.string(),
  groupName: z.string(),
  version: z.string(),
  state: z.enum(["canary", "rollout", "succeeded", "failed", "cancelled"]),
  createdAt: z.string(),
  canPromote: z.boolean(),
  deliveries: z.array(delivery),
});
export type UpgradeJob = z.infer<typeof upgradeJob>;
export type UpgradeArtifact = z.infer<typeof artifact>;
export const upgradesContract = {
  release: oc
    .route({ method: "GET", path: "/node-releases/{version}", tags: ["node-upgrades"] })
    .input(z.object({ version: releaseVersion }))
    .output(release),
  list: oc
    .route({ method: "GET", path: "/node-upgrades", tags: ["node-upgrades"] })
    .input(z.object({ clusterId: z.uuid().optional() }).default({}))
    .output(z.array(upgradeJob)),
  create: oc
    .route({ method: "POST", path: "/node-upgrades", tags: ["node-upgrades"] })
    .input(z.object({ version: releaseVersion, nodeGroupId: z.uuid() }))
    .output(upgradeJob),
  promote: oc
    .route({ method: "POST", path: "/node-upgrades/{id}/promote", tags: ["node-upgrades"] })
    .input(z.object({ id: z.uuid() }))
    .output(upgradeJob),
  cancel: oc
    .route({ method: "POST", path: "/node-upgrades/{id}/cancel", tags: ["node-upgrades"] })
    .input(z.object({ id: z.uuid() }))
    .output(upgradeJob),
};
