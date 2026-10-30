import type { ChallengeProviderModelInput } from "@edgeweir/config-compiler";
import {
  CHALLENGE_PROVIDER_DEFAULTS,
  CHALLENGE_PROVIDER_SECRETS,
  type ChallengeProvider,
  type ChallengeProviderInput,
  type ChallengeProviderKind,
  challengeProviderInput,
  type InteractiveProviderChoice,
  MIN_SCORE_DEFAULT,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import type { Executor } from "./revisions";

type ProviderRow = typeof schema.challengeProvider.$inferSelect;

/** Envelope binding of a provider's secret fields: the column and the row (AAD). */
export const challengeProviderBinding = (id: string) => ({
  purpose: "challenge_provider.secret_envelope",
  recordId: id,
});

/** A provider as read: public settings, whether every secret field is saved. */
export function providerView(row: ProviderRow | undefined): ChallengeProvider {
  if (!row) return { ...CHALLENGE_PROVIDER_DEFAULTS };
  return {
    kind: row.kind as ChallengeProviderKind,
    siteKey: row.siteKey,
    minScore: row.minScore,
    projectId: row.projectId,
    region: row.region === "sgp" ? "sgp" : "cn",
    prefix: row.prefix,
    secretSet: row.kind !== "builtin" && row.secretEnvelope !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The provider row of a site, or the global default (siteId null). */
export async function providerRow(
  db: Executor,
  siteId: string | null,
  lock = false,
): Promise<ProviderRow | undefined> {
  const query = db
    .select()
    .from(schema.challengeProvider)
    .where(
      siteId === null
        ? isNull(schema.challengeProvider.siteId)
        : eq(schema.challengeProvider.siteId, siteId),
    );
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

/** The fields an audit entry may show: never secrets. */
export const auditedProvider = ({ updatedAt: _u, ...rest }: ChallengeProvider) => rest;

/**
 * Saves the provider of a site or the global default. The secret fields given replace the
 * saved ones; a provider whose kind changes, or that has no secret yet, needs all of its kind's
 * fields (CHALLENGE_PROVIDER_SECRET_REQUIRED). Raises the secret version whenever the secret or
 * the kind changes, so that nodes fetch it again.
 */
export async function saveProvider(
  db: Executor,
  masterKey: MasterKey | undefined,
  siteId: string | null,
  raw: ChallengeProviderInput,
): Promise<ChallengeProvider> {
  const input = challengeProviderInput.parse(raw);
  const current = await providerRow(db, siteId, true);
  const fields: readonly string[] = CHALLENGE_PROVIDER_SECRETS[input.kind];
  const given = input.secret ?? {};
  const sameKind = current?.kind === input.kind;
  const keep = sameKind && !!current?.secretEnvelope && Object.keys(given).length === 0;
  const changed = !sameKind || Object.keys(given).length > 0;
  let secret: Record<string, string> | null = null;
  if (fields.length && !keep) {
    if (!masterKey) throw new Error("saveProvider: a master key is required to seal the secret");
    const saved =
      sameKind && current?.secretEnvelope
        ? (JSON.parse(
            masterKey
              .open(JSON.parse(current.secretEnvelope), challengeProviderBinding(current.id))
              .toString("utf8"),
          ) as Record<string, string>)
        : {};
    const merged: Record<string, string> = { ...saved, ...given };
    const missing = fields.filter((field) => !merged[field]);
    if (missing.length)
      fail("CHALLENGE_PROVIDER_SECRET_REQUIRED", `missing secret fields: ${missing.join(", ")}`, {
        fields: missing.join(", "),
      });
    secret = Object.fromEntries(fields.map((field) => [field, merged[field] as string]));
  }
  const values = {
    kind: input.kind,
    siteKey: input.kind === "builtin" ? "" : input.siteKey,
    minScore:
      input.kind === "recaptcha_v3" || input.kind === "recaptcha_enterprise"
        ? (input.minScore ?? MIN_SCORE_DEFAULT)
        : MIN_SCORE_DEFAULT,
    projectId: input.kind === "recaptcha_enterprise" ? input.projectId : "",
    region: input.kind === "aliyun" ? (input.region ?? "cn") : "cn",
    prefix: input.kind === "aliyun" ? input.prefix : "",
  };
  // Saved again as it is (a form sent whole): no write, no new revision.
  if (
    current &&
    !changed &&
    (keep || !fields.length) &&
    (Object.keys(values) as (keyof typeof values)[]).every((key) => current[key] === values[key])
  )
    return providerView(current);
  const id = current?.id ?? crypto.randomUUID();
  const envelope = keep
    ? (current?.secretEnvelope ?? null)
    : secret === null
      ? null
      : JSON.stringify(
          (masterKey as MasterKey).seal(JSON.stringify(secret), challengeProviderBinding(id)),
        );
  const [row] = await db
    .insert(schema.challengeProvider)
    .values({ id, siteId, ...values, secretEnvelope: envelope })
    .onConflictDoUpdate({
      target: schema.challengeProvider.siteId,
      set: {
        ...values,
        secretEnvelope: envelope,
        secretVersion: changed ? (current?.secretVersion ?? 0) + 1 : (current?.secretVersion ?? 1),
        updatedAt: new Date(),
      },
    })
    .returning();
  return providerView(row);
}

/** The compiler's view of a provider row: null for builtin or without a secret. */
function providerModel(row: ProviderRow | undefined): ChallengeProviderModelInput | null {
  if (!row || row.kind === "builtin" || !row.secretEnvelope) return null;
  return {
    kind: row.kind,
    siteKey: row.siteKey,
    credentialId: row.id,
    credentialVersion: row.secretVersion,
    minScore: row.minScore,
    projectId: row.projectId,
    region: row.region,
    prefix: row.prefix,
  };
}

/**
 * The interactive provider each site uses: its own with "site", none with "builtin", the global
 * default otherwise. Null: the built-in image captcha.
 */
export async function loadInteractiveProviders(
  db: Executor,
  choices: Map<string, InteractiveProviderChoice>,
): Promise<Map<string, ChallengeProviderModelInput | null>> {
  const own = [...choices].filter(([, c]) => c === "site").map(([id]) => id);
  const anyGlobal = [...choices.values()].some((c) => c === "global");
  const rows =
    own.length || anyGlobal
      ? await db
          .select()
          .from(schema.challengeProvider)
          .where(
            or(
              anyGlobal ? isNull(schema.challengeProvider.siteId) : undefined,
              own.length ? inArray(schema.challengeProvider.siteId, own) : undefined,
            ),
          )
      : [];
  const global = providerModel(rows.find((row) => row.siteId === null));
  return new Map(
    [...choices].map(([siteId, choice]) => [
      siteId,
      choice === "builtin"
        ? null
        : choice === "site"
          ? providerModel(rows.find((row) => row.siteId === siteId))
          : global,
    ]),
  );
}

/**
 * Provider secrets for a node (GetOriginCredentials): rows the node asks for that a site of its
 * cluster uses, as JSON documents. A site uses its own row with "site" and the global default
 * with "global" (or without a protection row).
 */
export async function nodeProviderSecrets(
  db: Executor,
  masterKey: MasterKey,
  clusterId: string,
  ids: string[],
  log: (message: string, data: Record<string, unknown>) => void,
): Promise<{ id: string; version: bigint; accessKeyId: string; secretAccessKey: string }[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(schema.challengeProvider)
    .where(
      and(
        inArray(schema.challengeProvider.id, ids),
        isNotNull(schema.challengeProvider.secretEnvelope),
      ),
    );
  if (!rows.length) return [];
  const sites = await db
    .select({ id: schema.site.id, choice: schema.siteProtection.interactiveProvider })
    .from(schema.site)
    .leftJoin(schema.siteProtection, eq(schema.siteProtection.siteId, schema.site.id))
    .where(eq(schema.site.clusterId, clusterId));
  const usesGlobal = sites.some((s) => (s.choice ?? "global") === "global");
  const own = new Set(sites.filter((s) => s.choice === "site").map((s) => s.id));
  return rows.flatMap((row) => {
    if (row.siteId === null ? !usesGlobal : !own.has(row.siteId)) return [];
    try {
      const value = masterKey.open(
        JSON.parse(row.secretEnvelope as string),
        challengeProviderBinding(row.id),
      );
      return [
        {
          id: row.id,
          version: BigInt(row.secretVersion),
          accessKeyId: "",
          secretAccessKey: value.toString("utf8"),
        },
      ];
    } catch (error) {
      log("cannot open challenge provider secret", { providerId: row.id, error });
      return [];
    }
  });
}
