import { oc } from "@orpc/contract";
import * as z from "zod";

const key = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scope: z.enum(["read", "write"]),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export const accessKeysContract = {
  list: oc
    .route({ method: "GET", path: "/access-keys", tags: ["access-keys"] })
    .output(z.array(key)),
  create: oc
    .route({ method: "POST", path: "/access-keys", tags: ["access-keys"] })
    .input(
      z.object({
        name: z.string().trim().min(1).max(64),
        scope: z.enum(["read", "write"]).default("write"),
      }),
    )
    .output(key.extend({ key: z.string() })),
  revoke: oc
    .route({ method: "DELETE", path: "/access-keys/{id}", tags: ["access-keys"] })
    .input(z.object({ id: z.string().min(1).max(128) }))
    .output(z.object({ ok: z.literal(true) })),
};
