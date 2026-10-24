import { oc } from "@orpc/contract";
import * as z from "zod";

/** Requests per minute a new AccessKey may make. */
export const ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE = 600;
export const ACCESS_KEY_MAX_REQUESTS_PER_MINUTE = 100_000;

/** Requests per minute; null: unlimited. Over it, `/api/v1` answers 429 API_KEY_RATE_LIMITED. */
const accessKeyRequestsPerMinute = z
  .number()
  .int()
  .min(1)
  .max(ACCESS_KEY_MAX_REQUESTS_PER_MINUTE)
  .nullable();

const keyName = z.string().trim().min(1).max(64);

const key = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scope: z.enum(["read", "write"]),
  enabled: z.boolean(),
  requestsPerMinute: accessKeyRequestsPerMinute,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export const accessKeysContract = {
  list: oc
    .route({ method: "GET", path: "/access-keys", tags: ["access-keys"] })
    .output(z.array(key)),
  create: oc
    .route({
      method: "POST",
      path: "/access-keys",
      tags: ["access-keys"],
      description:
        "Requires a signed-in console session through RPC. API keys cannot create credentials.",
    })
    .input(
      z.object({
        name: keyName,
        scope: z.enum(["read", "write"]).default("write"),
        requestsPerMinute: accessKeyRequestsPerMinute.default(
          ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
        ),
      }),
    )
    .output(key.extend({ key: z.string() })),
  update: oc
    .route({
      method: "PATCH",
      path: "/access-keys/{id}",
      tags: ["access-keys"],
      description:
        "Requires a signed-in console session through RPC. API keys cannot change credentials.",
    })
    .input(
      z.object({
        id: z.string().min(1).max(128),
        name: keyName.optional(),
        requestsPerMinute: accessKeyRequestsPerMinute.optional(),
      }),
    )
    .output(key),
  revoke: oc
    .route({ method: "DELETE", path: "/access-keys/{id}", tags: ["access-keys"] })
    .input(z.object({ id: z.string().min(1).max(128) }))
    .output(z.object({ ok: z.literal(true) })),
};

export type AccessKey = z.infer<typeof key>;
