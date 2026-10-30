import { oc } from "@orpc/contract";
import * as z from "zod";
import { probeMode } from "./probes";
import { isoDateTime, uuid } from "./schemas";

/**
 * External probe sources (ADR-0069): monitoring services the operator
 * already uses, whose results about the nodes count like probe results
 * under the probe mode. Display names and field labels are Paraglide
 * messages (`probe_source_provider_<id>`, `probe_source_field_<key>`).
 */
export const PROBE_SOURCE_PROVIDERS = [
  "generic_webhook",
  "uptimerobot",
  "betterstack",
  "pingdom",
  "checkly",
  "datadog",
  "aliyun_site_monitor",
  "tencent_cat",
] as const;
export const probeSourceProvider = z.enum(PROBE_SOURCE_PROVIDERS);
export type ProbeSourceProvider = z.infer<typeof probeSourceProvider>;

export interface ProbeSourceField {
  /** Field key (snake_case). */
  readonly key: string;
  /** Sealed and never returned; otherwise an option the API returns. */
  readonly secret: boolean;
  readonly required: boolean;
  readonly maxLength: number;
  /** Anchored; JavaScript regular expression. */
  readonly pattern?: string;
  readonly options?: readonly string[];
  readonly default?: string;
  readonly placeholder?: string;
}

export interface ProbeSourceEntry {
  readonly id: ProbeSourceProvider;
  /** English name for API clients. */
  readonly name: string;
  readonly fields: readonly ProbeSourceField[];
  /** The console polls the provider's API (listing monitors, latest results). */
  readonly pull: boolean;
  /**
   * The provider can push results to the source's webhook URL: "generated"
   * (the console makes the secret, shown once) or "entered" (the provider
   * makes it and the operator pastes it); null: no webhook.
   */
  readonly webhook: "generated" | "entered" | null;
  /** The body the provider's webhook must send, where it is templated. */
  readonly webhookTemplate?: string;
  /** Shortest poll interval the provider's rate limits allow, in seconds. */
  readonly minPollSeconds: number;
}

/** A secret: printable ASCII without spaces (it goes into a header or a signature). */
const secret = (key: string, maxLength = 256): ProbeSourceField => ({
  key,
  secret: true,
  required: true,
  maxLength,
  pattern: "^[\\x21-\\x7E]+$",
});
const option = (
  key: string,
  options: readonly string[],
  defaultValue: string,
): ProbeSourceField => ({
  key,
  secret: false,
  required: true,
  maxLength: 64,
  options,
  default: defaultValue,
});

export const PROBE_SOURCE_CATALOG: readonly ProbeSourceEntry[] = [
  {
    id: "generic_webhook",
    name: "Generic webhook",
    fields: [],
    pull: false,
    webhook: "generated",
    minPollSeconds: 30,
  },
  {
    id: "uptimerobot",
    name: "UptimeRobot",
    fields: [secret("api_key", 256)],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
  {
    id: "betterstack",
    name: "Better Stack Uptime",
    fields: [secret("api_token", 256)],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
  {
    id: "pingdom",
    name: "Pingdom",
    fields: [secret("api_token", 256)],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
  {
    id: "checkly",
    name: "Checkly",
    fields: [
      secret("api_key", 256),
      {
        key: "account_id",
        secret: false,
        required: true,
        maxLength: 64,
        pattern: "^[0-9a-fA-F-]{8,64}$",
      },
    ],
    pull: true,
    webhook: "generated",
    webhookTemplate:
      '{"checkId":"{{CHECK_ID}}","alertType":"{{ALERT_TYPE}}","runLocation":"{{RUN_LOCATION}}","responseTime":"{{RESPONSE_TIME}}","startedAt":"{{STARTED_AT}}"}',
    minPollSeconds: 60,
  },
  {
    id: "datadog",
    name: "Datadog Synthetics",
    fields: [
      secret("api_key", 128),
      secret("application_key", 128),
      option(
        "site",
        [
          "datadoghq.com",
          "us3.datadoghq.com",
          "us5.datadoghq.com",
          "datadoghq.eu",
          "ap1.datadoghq.com",
          "ap2.datadoghq.com",
          "uk1.datadoghq.com",
          "ddog-gov.com",
          "us2.ddog-gov.com",
        ],
        "datadoghq.com",
      ),
    ],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
  {
    id: "aliyun_site_monitor",
    name: "Alibaba Cloud Site Monitoring",
    fields: [
      {
        key: "access_key_id",
        secret: false,
        required: true,
        maxLength: 128,
        pattern: "^[A-Za-z0-9]{1,128}$",
      },
      secret("access_key_secret", 256),
      option(
        "region",
        [
          "cn-hangzhou",
          "cn-shanghai",
          "cn-beijing",
          "cn-shenzhen",
          "cn-hongkong",
          "ap-southeast-1",
        ],
        "cn-hangzhou",
      ),
    ],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
  {
    id: "tencent_cat",
    name: "Tencent Cloud CAT",
    fields: [
      {
        key: "secret_id",
        secret: false,
        required: true,
        maxLength: 128,
        pattern: "^[A-Za-z0-9]{1,128}$",
      },
      secret("secret_key", 256),
    ],
    pull: true,
    webhook: null,
    minPollSeconds: 60,
  },
];

export function probeSourceEntry(id: string): ProbeSourceEntry | undefined {
  return PROBE_SOURCE_CATALOG.find((e) => e.id === id);
}

type FieldProblem = "unknown_field" | "missing_field" | "invalid_field";
/**
 * Checks a source's fields against the catalog. With `keep` (an update),
 * a secret field left out keeps its stored value. Returns the secret and
 * the plain fields apart.
 */
export function checkProbeSourceFields(
  provider: string,
  fields: Record<string, string>,
  opts: { keepSecrets?: boolean } = {},
):
  | { ok: true; secrets: Record<string, string>; options: Record<string, string> }
  | { ok: false; problem: FieldProblem; field?: string } {
  const entry = probeSourceEntry(provider);
  if (!entry) return { ok: false, problem: "unknown_field" };
  for (const key of Object.keys(fields))
    if (!entry.fields.some((f) => f.key === key))
      return { ok: false, problem: "unknown_field", field: key };
  const secrets: Record<string, string> = {};
  const options: Record<string, string> = {};
  for (const field of entry.fields) {
    const raw = fields[field.key];
    const value = (field.secret ? raw : raw?.trim()) ?? "";
    if (!value) {
      if (field.secret && opts.keepSecrets) continue;
      if (field.default !== undefined) {
        options[field.key] = field.default;
        continue;
      }
      if (field.required) return { ok: false, problem: "missing_field", field: field.key };
      continue;
    }
    const invalid = { ok: false as const, problem: "invalid_field" as const, field: field.key };
    if (value.length > field.maxLength) return invalid;
    if ([...value].some((c) => c < " " || c === "\u007f")) return invalid;
    if (field.pattern && !new RegExp(field.pattern).test(value)) return invalid;
    if (field.options && !field.options.includes(value)) return invalid;
    (field.secret ? secrets : options)[field.key] = value;
  }
  return { ok: true, secrets, options };
}

const fieldValues = z.record(z.string().max(64), z.string().max(4096));

/**
 * healthy: answered or delivered within staleAfterSeconds; waiting: never
 * yet; failing: the last poll failed; stale: nothing for staleAfterSeconds;
 * disabled. Only a healthy source's results count.
 */
const probeSourceStatus = z.enum(["healthy", "waiting", "failing", "stale", "disabled"]);
export type ProbeSourceStatus = z.infer<typeof probeSourceStatus>;

const probeSource = z.object({
  id: uuid,
  name: z.string(),
  provider: probeSourceProvider,
  enabled: z.boolean(),
  /** The plain fields (secret fields are never returned). */
  options: z.record(z.string(), z.string()),
  /** Secret fields that are stored. */
  secretsSet: z.array(z.string()),
  /** The webhook URL when the source takes deliveries; null otherwise. */
  webhookUrl: z.string().nullable(),
  pollIntervalSeconds: z.number().int(),
  staleAfterSeconds: z.number().int(),
  status: probeSourceStatus,
  lastSuccessAt: isoDateTime.nullable(),
  lastDeliveryAt: isoDateTime.nullable(),
  lastPollAt: isoDateTime.nullable(),
  lastErrorAt: isoDateTime.nullable(),
  /** Error code of the last failed poll (`probe_source_error_<code>`); "" after a success. */
  lastError: z.string(),
  mappings: z.number().int(),
  /** Mapped monitors whose latest results (a majority of locations) are down. */
  down: z.number().int(),
  createdAt: isoDateTime,
});

const timing = {
  /** Seconds between polls of the provider's API (not below its minimum). */
  pollIntervalSeconds: z.number().int().min(30).max(3600),
  /** Results stop counting this long after the last successful poll or delivery. */
  staleAfterSeconds: z.number().int().min(60).max(86400),
};
const webhookSecretInput = z.string().min(16).max(256);

const probeSourceInput = z.object({
  name: z.string().trim().min(1).max(64),
  provider: probeSourceProvider,
  enabled: z.boolean().default(true),
  /** The catalog's fields; secret ones are sealed. */
  fields: fieldValues.default({}),
  /** The provider's own signing secret (catalog webhook "entered"). */
  webhookSecret: webhookSecretInput.optional(),
  pollIntervalSeconds: timing.pollIntervalSeconds.default(60),
  staleAfterSeconds: timing.staleAfterSeconds.default(300),
});
const probeSourceUpdate = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  /** Replaces the fields; a secret field left empty keeps its stored value. */
  fields: fieldValues.optional(),
  webhookSecret: webhookSecretInput.optional(),
  pollIntervalSeconds: timing.pollIntervalSeconds.optional(),
  staleAfterSeconds: timing.staleAfterSeconds.optional(),
});
const createdSource = z.object({
  source: probeSource,
  /** The webhook secret the console made, shown once; null otherwise. */
  webhookSecret: z.string().nullable(),
});

const mapping = z.object({
  monitorId: z.string().trim().min(1).max(200),
  monitorName: z.string().trim().max(200).default(""),
  nodeId: uuid,
  /** One scheduling address of the node; null: each of them. */
  address: z.string().trim().max(64).nullable().default(null),
});
export const MAX_PROBE_SOURCE_MAPPINGS = 2000;
const mappingDto = z.object({
  monitorId: z.string(),
  monitorName: z.string(),
  nodeId: uuid,
  nodeName: z.string(),
  clusterId: uuid,
  address: z.string().nullable(),
});

const monitor = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string(),
  /** A node one of whose scheduling addresses (or host name) the target names. */
  suggestedNodeId: uuid.nullable(),
  suggestedAddress: z.string().nullable(),
});

const result = z.object({
  monitorId: z.string(),
  monitorName: z.string(),
  /** Null for a monitor without a mapping. */
  nodeId: uuid.nullable(),
  nodeName: z.string().nullable(),
  location: z.string(),
  up: z.boolean(),
  lossPercent: z.number(),
  rttMs: z.number().int().nullable(),
  error: z.string(),
  checkedAt: isoDateTime,
  receivedAt: isoDateTime,
  /** It counts now: mapped, the source healthy and the result fresh. */
  counted: z.boolean(),
});

const checkInput = z.union([
  z.object({ id: uuid, fields: fieldValues.optional() }),
  z.object({ provider: probeSourceProvider, fields: fieldValues }),
]);
const checkResult = z.object({
  ok: z.boolean(),
  /** Monitors the API lists (pull providers). */
  monitors: z.number().int().nullable(),
  /** Error code when not ok. */
  error: z.string(),
});

const modes = z.object({
  global: probeMode,
  clusters: z.array(
    z.object({ clusterId: uuid, clusterName: z.string(), mode: probeMode.nullable() }),
  ),
});

const idParam = z.object({ id: uuid });
const ok = z.object({ ok: z.literal(true) });

export const probeSourcesContract = {
  list: oc
    .route({ method: "GET", path: "/probe-sources", tags: ["probe-sources"] })
    .output(z.array(probeSource)),
  create: oc
    .route({ method: "POST", path: "/probe-sources", tags: ["probe-sources"], successStatus: 201 })
    .input(probeSourceInput)
    .output(createdSource),
  update: oc
    .route({ method: "PATCH", path: "/probe-sources/{id}", tags: ["probe-sources"] })
    .input(probeSourceUpdate)
    .output(probeSource),
  delete: oc
    .route({ method: "DELETE", path: "/probe-sources/{id}", tags: ["probe-sources"] })
    .input(idParam)
    .output(ok),
  /** A new webhook secret the console makes (the old one stops working), shown once. */
  rotateWebhookSecret: oc
    .route({ method: "POST", path: "/probe-sources/{id}/webhook-secret", tags: ["probe-sources"] })
    .input(idParam)
    .output(z.object({ webhookSecret: z.string() })),
  /** Calls the provider's API with the given or stored fields; writes nothing. */
  check: oc
    .route({ method: "POST", path: "/probe-sources/check", tags: ["probe-sources"] })
    .input(checkInput)
    .output(checkResult),
  /** The provider's monitors (pull) or those deliveries named, with suggested nodes. */
  monitors: oc
    .route({ method: "GET", path: "/probe-sources/{id}/monitors", tags: ["probe-sources"] })
    .input(idParam)
    .output(z.array(monitor)),
  mappings: oc
    .route({ method: "GET", path: "/probe-sources/{id}/mappings", tags: ["probe-sources"] })
    .input(idParam)
    .output(z.array(mappingDto)),
  /** Replaces the source's mappings (each monitor at most once). */
  setMappings: oc
    .route({ method: "PUT", path: "/probe-sources/{id}/mappings", tags: ["probe-sources"] })
    .input(z.object({ id: uuid, mappings: z.array(mapping).max(MAX_PROBE_SOURCE_MAPPINGS) }))
    .output(z.array(mappingDto)),
  /** Latest result per monitor and location. */
  results: oc
    .route({ method: "GET", path: "/probe-sources/{id}/results", tags: ["probe-sources"] })
    .input(idParam)
    .output(z.array(result)),
  /** The global probe mode and each cluster's own. */
  modes: oc.route({ method: "GET", path: "/probe-modes", tags: ["probe-sources"] }).output(modes),
  /** A cluster's own probe mode; null: the global one. */
  setClusterMode: oc
    .route({ method: "PUT", path: "/clusters/{clusterId}/probe-mode", tags: ["probe-sources"] })
    .input(z.object({ clusterId: uuid, mode: probeMode.nullable() }))
    .output(modes),
};

export type ProbeSource = z.infer<typeof probeSource>;
export type ProbeSourceInput = z.infer<typeof probeSourceInput>;
export type ProbeSourceUpdate = z.infer<typeof probeSourceUpdate>;
export type ProbeSourceMapping = z.infer<typeof mappingDto>;
export type ProbeSourceMappingInput = z.input<typeof mapping>;
export type ProbeSourceMonitor = z.infer<typeof monitor>;
export type ProbeSourceResult = z.infer<typeof result>;
export type ProbeSourceCheckInput = z.infer<typeof checkInput>;
export type ProbeModes = z.infer<typeof modes>;
