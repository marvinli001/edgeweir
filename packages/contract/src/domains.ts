import { oc } from "@orpc/contract";
import * as z from "zod";
import { uuid } from "./schemas";

const ownership = z.object({
  domain: z.string(),
  verified: z.boolean(),
  method: z.enum(["dns", "admin"]),
  txtName: z.string(),
  txtValue: z.string().nullable(),
  verifiedAt: z.string().nullable(),
});
export const domainOwnershipContract = {
  approve: oc
    .route({ method: "POST", path: "/sites/{siteId}/ownership/approve", tags: ["domains"] })
    .input(z.object({ siteId: uuid, domain: z.string().min(1).max(253) }))
    .output(z.array(ownership)),
  get: oc
    .route({ method: "GET", path: "/sites/{siteId}/ownership", tags: ["domains"] })
    .input(z.object({ siteId: uuid }))
    .output(z.array(ownership)),
  prepare: oc
    .route({ method: "POST", path: "/sites/{siteId}/ownership", tags: ["domains"] })
    .input(z.object({ siteId: uuid }))
    .output(z.array(ownership)),
  verify: oc
    .route({ method: "POST", path: "/sites/{siteId}/ownership/verify", tags: ["domains"] })
    .input(z.object({ siteId: uuid, domain: z.string().min(1).max(253) }))
    .output(ownership),
  revoke: oc
    .route({ method: "DELETE", path: "/sites/{siteId}/ownership/{domain}", tags: ["domains"] })
    .input(z.object({ siteId: uuid, domain: z.string().min(1).max(253) }))
    .output(z.object({ ok: z.literal(true) })),
};
export type DomainOwnership = z.infer<typeof ownership>;
