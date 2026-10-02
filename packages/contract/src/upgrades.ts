import { oc } from "@orpc/contract";
import * as z from "zod";
export const releaseVersion = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .max(64);

const VERSION_PARTS = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semantic version precedence of two versions (build metadata ignored, a
 * leading "v" allowed): negative when a is older than b, 0 when equal;
 * null when either is not a version (e.g. a development build).
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const x = VERSION_PARTS.exec(a.trim());
  const y = VERSION_PARTS.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === pb) return 0;
  // A pre-release precedes its release.
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const ca = ia[i];
    const cb = ib[i];
    if (ca === undefined) return -1;
    if (cb === undefined) return 1;
    const na = /^\d+$/.test(ca);
    const nb = /^\d+$/.test(cb);
    if (na && nb) {
      const diff = Number(ca) - Number(cb);
      if (diff !== 0) return Math.sign(diff);
    } else if (na !== nb) return na ? -1 : 1;
    else if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return 0;
}
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
  /** Pending and running deliveries fail when their node has not finished by then. */
  deadlineAt: z.string().nullable(),
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
  /** The newest release of the node release source; null when it cannot be told. */
  latestVersion: oc
    .route({ method: "GET", path: "/node-upgrades/latest-version", tags: ["node-upgrades"] })
    .output(z.object({ version: releaseVersion.nullable() })),
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
