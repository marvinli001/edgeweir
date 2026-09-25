import { oc } from "@orpc/contract";
import * as z from "zod";
import * as s from "./schemas";

export * from "./schemas";

const idParam = z.object({ id: s.uuid });

/**
 * The single API contract of the console. The web UI calls it over `/rpc`
 * (session cookie); third parties call the same procedures through the
 * generated OpenAPI surface under `/api/v1` with an `x-api-key` header.
 */
export const contract = {
  system: {
    status: oc
      .route({ method: "GET", path: "/system/status", tags: ["system"] })
      .output(s.systemStatus),
    setup: oc
      .route({ method: "POST", path: "/system/setup", tags: ["system"] })
      .input(s.setupInput)
      .output(z.object({ userId: z.string(), organizationId: z.string() })),
  },
  overview: {
    get: oc.route({ method: "GET", path: "/overview", tags: ["overview"] }).output(s.overview),
  },
  clusters: {
    list: oc
      .route({ method: "GET", path: "/clusters", tags: ["clusters"] })
      .output(z.array(s.cluster)),
    get: oc
      .route({ method: "GET", path: "/clusters/{id}", tags: ["clusters"] })
      .input(idParam)
      .output(s.cluster),
    create: oc
      .route({ method: "POST", path: "/clusters", tags: ["clusters"] })
      .input(s.clusterCreateInput)
      .output(s.cluster),
    revisions: oc
      .route({ method: "GET", path: "/clusters/{id}/revisions", tags: ["clusters"] })
      .input(idParam)
      .output(z.array(s.revision)),
    rollback: oc
      .route({ method: "POST", path: "/clusters/{id}/rollback", tags: ["clusters"] })
      .input(idParam.extend({ revision: z.number().int().min(1) }))
      .output(s.revision),
    createEnrollmentToken: oc
      .route({ method: "POST", path: "/enrollment-tokens", tags: ["nodes"] })
      .input(s.enrollmentTokenInput)
      .output(s.enrollmentTokenResult),
  },
  nodes: {
    list: oc
      .route({ method: "GET", path: "/nodes", tags: ["nodes"] })
      .input(z.object({ clusterId: s.uuid.optional() }))
      .output(z.array(s.node)),
    get: oc
      .route({ method: "GET", path: "/nodes/{id}", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
  },
  sites: {
    list: oc.route({ method: "GET", path: "/sites", tags: ["sites"] }).output(z.array(s.site)),
    get: oc
      .route({ method: "GET", path: "/sites/{id}", tags: ["sites"] })
      .input(idParam)
      .output(s.site),
    create: oc
      .route({ method: "POST", path: "/sites", tags: ["sites"], successStatus: 201 })
      .input(s.siteCreateInput)
      .output(s.siteMutationResult),
    delete: oc
      .route({ method: "DELETE", path: "/sites/{id}", tags: ["sites"] })
      .input(idParam)
      .output(z.object({ revision: s.revision })),
    purgeAll: oc
      .route({ method: "POST", path: "/sites/{id}/purge", tags: ["sites"] })
      .input(idParam)
      .output(s.siteMutationResult),
  },
  settings: {
    get: oc.route({ method: "GET", path: "/settings", tags: ["settings"] }).output(s.settings),
  },
  auditLogs: {
    list: oc
      .route({ method: "GET", path: "/audit-logs", tags: ["audit"] })
      .input(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }))
      .output(z.array(s.auditLogEntry)),
  },
};

export type Contract = typeof contract;
