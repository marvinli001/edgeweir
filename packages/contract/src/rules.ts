import {
  actionPhases,
  canonicalCidr,
  challengeTypes,
  isRateLimitKey,
  parseExpression,
  phases,
} from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { uuid } from "./schemas";

const text = z
  .string()
  .max(4096)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const protectedHeaders = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "cdn-loop",
]);
export const ruleHeaderName = z
  .string()
  .toLowerCase()
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/)
  .refine((s) => !protectedHeaders.has(s) && !s.startsWith("x-edgeweir-"));
export const ruleAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("block"),
    statusCode: z.union([z.literal(403), z.literal(451)]).default(403),
  }),
  z.object({ kind: z.literal("log") }),
  z.object({ kind: z.literal("allow") }),
  /** Challenges requests without a pass of this type's level or higher. */
  z.object({ kind: z.literal("challenge"), type: z.enum(challengeTypes).default("js") }),
  z.object({
    kind: z.literal("redirect"),
    value: text.refine(
      (s) =>
        !s.includes("\\") &&
        ((s.startsWith("/") && !s.startsWith("//")) ||
          (() => {
            try {
              const url = new URL(s);
              return (
                ["http:", "https:"].includes(url.protocol) &&
                !!url.hostname &&
                !url.username &&
                !url.password &&
                !/\s/.test(s)
              );
            } catch {
              return false;
            }
          })()),
    ),
    statusCode: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
      .default(301),
  }),
  z.object({
    kind: z.literal("rewrite"),
    value: text.refine((s) => s.startsWith("/") && !s.startsWith("//") && !/[?\\#]/.test(s)),
  }),
  z.object({
    kind: z.literal("request_header"),
    header: ruleHeaderName,
    value: text.default(""),
    remove: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("response_header"),
    header: ruleHeaderName,
    value: text.default(""),
    remove: z.boolean().default(false),
  }),
  z
    .object({
      kind: z.literal("config"),
      cacheBypass: z.boolean().optional(),
      forceHttps: z.boolean().optional(),
      gzip: z.literal(false).optional(),
    })
    .refine(
      (a) => a.cacheBypass !== undefined || a.forceHttps !== undefined || a.gzip !== undefined,
    ),
  z.object({
    kind: z.literal("rate_limit"),
    statusCode: z.union([z.literal(403), z.literal(429)]).default(429),
    limit: z.number().int().min(1).max(100000),
    windowSeconds: z.number().int().min(1).max(3600),
    /** ip.src, http.host, tls.ja4 or http.request.headers.<name>. */
    key: z.string().refine(isRateLimitKey).default("ip.src"),
  }),
]);
export const ruleInput = z
  .object({
    id: uuid.optional(),
    name: z.string().trim().min(1).max(100),
    phase: z.enum(phases),
    expression: z.string().min(1).max(4096),
    enabled: z.boolean().default(true),
    action: ruleAction,
  })
  .superRefine((rule, ctx) => {
    if (!actionPhases[rule.action.kind]?.includes(rule.phase))
      ctx.addIssue({
        code: "custom",
        message: "action is unavailable in this phase",
        path: ["action"],
      });
    try {
      parseExpression(rule.expression, rule.phase);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid expression",
        path: ["expression"],
      });
    }
  });
export const ruleDto = ruleInput.safeExtend({ id: uuid });
export const rulesContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/rules", tags: ["rules"] })
    .input(z.object({ id: uuid }))
    .output(z.array(ruleDto)),
  save: oc
    .route({ method: "PUT", path: "/sites/{id}/rules", tags: ["rules"] })
    .input(z.object({ id: uuid, rules: z.array(ruleInput).max(64) }))
    .output(z.array(ruleDto)),
  validate: oc
    .route({ method: "POST", path: "/rules/validate", tags: ["rules"] })
    .input(z.object({ expression: z.string().max(4096), phase: z.enum(phases) }))
    .output(z.object({ valid: z.boolean(), position: z.number().int(), message: z.string() })),
};
export const platformRulesContract = {
  get: oc
    .route({ method: "GET", path: "/platform-rules", tags: ["rules"] })
    .output(z.array(ruleDto)),
  save: oc
    .route({ method: "PUT", path: "/platform-rules", tags: ["rules"] })
    .input(z.object({ rules: z.array(ruleInput).max(32) }))
    .output(z.array(ruleDto)),
};
const entries = z
  .array(z.string().max(64))
  .max(10000)
  .transform((values, ctx) => {
    try {
      return [...new Set(values.map(canonicalCidr))].sort();
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid IP/CIDR" });
      return z.NEVER;
    }
  });
export const ipListInput = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  entries,
  kind: z.enum(["collection", "allow", "block"]).default("collection"),
});
export const ipListDto = z.object({
  id: uuid,
  name: z.string(),
  entries: z.array(z.string()),
  kind: z.enum(["collection", "allow", "block"]),
  platform: z.boolean(),
});
const listContract = (prefix: `/${string}`) => ({
  list: oc.route({ method: "GET", path: prefix, tags: ["rules"] }).output(z.array(ipListDto)),
  create: oc
    .route({ method: "POST", path: prefix, tags: ["rules"] })
    .input(ipListInput)
    .output(ipListDto),
  update: oc
    .route({ method: "PUT", path: `${prefix}/{id}`, tags: ["rules"] })
    .input(z.object({ id: uuid, entries, kind: z.enum(["collection", "allow", "block"]) }))
    .output(ipListDto),
  delete: oc
    .route({ method: "DELETE", path: `${prefix}/{id}`, tags: ["rules"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
});
export const ipListsContract = listContract("/ip-lists");
export const platformIpListsContract = listContract("/platform-ip-lists");
export type RuleInput = z.infer<typeof ruleInput>;
export type RuleDto = z.infer<typeof ruleDto>;
export type IpListInput = z.infer<typeof ipListInput>;
export type IpListDto = z.infer<typeof ipListDto>;
