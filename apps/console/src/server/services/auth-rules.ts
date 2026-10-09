import { randomBytes, randomUUID } from "node:crypto";
import { ACCESS_AUTH_FEATURE } from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  type AuthFailures,
  type AuthKind,
  type AuthRule,
  type AuthRuleInput,
  forbiddenOriginRange,
  formatSiteDomain,
  forwardUrlHost,
  hostMatcher,
  isUrlAuthKind,
  matchHost,
  nodeSupportsFeature,
  type SignedUrl,
  type SignUrlInput,
  type SiteAuthRules,
  type SiteAuthRulesInput,
  siteDomainKind,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { signUri } from "@edgeweir/rule-engine";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type AuthSecret,
  hashBasicPassword,
  openAuthSecret,
  sealAuthSecret,
} from "../lib/access-auth-secrets";
import { type AuthRuleRow, toAuthRuleDto } from "../lib/auth-rule-dto";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { assertUpdatedAt } from "../lib/updated-at";
import { rangeWindow, sourceFor } from "./analytics";
import { type Actor, recordAudit } from "./audit";
import { loadOriginAllowList } from "./config-input";
import { type Executor, publishRevision } from "./revisions";
import { findSite } from "./sites";

type RuleRow = AuthRuleRow;
type BasicSettings = {
  realm: string;
  keepAuthorization: boolean;
  userHeader: boolean;
  users: string[];
};
type UrlSettings = {
  validitySeconds: number;
  skewSeconds: number;
  signParam: string;
  timeParam: string;
  backupKey: boolean;
};

async function loadRules(db: Executor, siteId: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(schema.siteAuthRule)
    .where(eq(schema.siteAuthRule.siteId, siteId))
    .orderBy(asc(schema.siteAuthRule.position));
}

/** The site's domains in their written form (`a.com`, `*.a.com`, `.a.com`, `~p`). */
export async function formattedSiteDomains(db: Executor, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, siteId));
  return rows.map((d) => formatSiteDomain({ kind: d.kind as never, name: d.name }));
}

export async function getAuthRules(db: Database, siteId: string): Promise<SiteAuthRules> {
  const site = await findSite(db, siteId);
  return {
    siteId: site.id,
    rules: (await loadRules(db, site.id)).map(toAuthRuleDto),
    updatedAt: site.authUpdatedAt?.toISOString() ?? null,
  };
}

/** Sorted copy without duplicates. */
const set = (values: readonly string[]) => [...new Set(values)].sort();

/** The secret a rule keeps or gets, and whether it changed. */
async function nextSecret(
  input: AuthRuleInput,
  previous: { kind: string; secret: AuthSecret | null } | null,
): Promise<AuthSecret | null> {
  if (input.kind === "basic" && input.basic) {
    const old = new Map<string, string>();
    if (previous?.kind === "basic" && previous.secret && "users" in previous.secret)
      for (const u of previous.secret.users) old.set(u.name, u.hash);
    const users: { name: string; hash: string }[] = [];
    for (const user of input.basic.users) {
      if (user.password !== undefined) {
        users.push({ name: user.name, hash: await hashBasicPassword(user.password) });
        continue;
      }
      const hash = old.get(user.name);
      if (!hash)
        fail("AUTH_PASSWORD_REQUIRED", `user ${user.name} needs a password`, { user: user.name });
      users.push({ name: user.name, hash });
    }
    return { users };
  }
  if (isUrlAuthKind(input.kind) && input.url) {
    const old =
      previous &&
      isUrlAuthKind(previous.kind as AuthKind) &&
      previous.secret &&
      "keys" in previous.secret
        ? previous.secret.keys
        : [];
    const primary = input.url.primaryKey ?? old[0];
    if (!primary) fail("AUTH_KEY_REQUIRED", "the rule needs a signing key");
    const backup = input.url.backupKey === null ? undefined : (input.url.backupKey ?? old[1]);
    return { keys: backup ? [primary, backup] : [primary] };
  }
  return null;
}

/** What a rule's secret looks like in audit entries: counts only. */
function secretSummary(secret: AuthSecret | null) {
  if (!secret) return {};
  return "users" in secret ? { users: secret.users.length } : { keys: secret.keys.length };
}

/** Settings stored with a rule (no secrets). */
function settingsOf(input: AuthRuleInput, secret: AuthSecret | null): Record<string, unknown> {
  if (input.kind === "basic" && input.basic) {
    const s: BasicSettings = {
      realm: input.basic.realm,
      keepAuthorization: input.basic.keepAuthorization,
      userHeader: input.basic.userHeader,
      users: input.basic.users.map((u) => u.name),
    };
    return s;
  }
  if (input.kind === "forward" && input.forward)
    return {
      ...input.forward,
      requestHeaders: set(input.forward.requestHeaders),
      responseHeaders: set(input.forward.responseHeaders),
    };
  if (input.url) {
    const s: UrlSettings = {
      validitySeconds: input.url.validitySeconds,
      skewSeconds: input.url.skewSeconds,
      signParam: input.url.signParam,
      timeParam: input.url.timeParam,
      backupKey: !!secret && "keys" in secret && secret.keys.length > 1,
    };
    return s;
  }
  return {};
}

/**
 * Replaces a site's access authentication rules, keeping the passwords and
 * keys the input leaves out (by rule id), publishes its cluster (a hot
 * update; access-auth-v1 while a rule is enabled) and audits the change
 * without any secret. Secrets are sealed with the master key, bound to their
 * rule; a changed secret gets the next version, so that nodes fetch it again.
 */
export async function updateAuthRules(
  db: Database,
  masterKey: MasterKey,
  input: SiteAuthRulesInput,
  ctx: { actor: Actor },
): Promise<SiteAuthRules> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    if (input.expectedUpdatedAt !== undefined) {
      if (!site.authUpdatedAt)
        fail(
          "UPDATED_AT_MISMATCH",
          "the access authentication rules changed since they were read",
          {
            updatedAt: "",
          },
        );
      assertUpdatedAt(site.authUpdatedAt, input.expectedUpdatedAt);
    }
    const domains = new Set(await formattedSiteDomains(tx, site.id));
    const allowed = await loadOriginAllowList(tx);
    const existing = await loadRules(tx, site.id);
    const byId = new Map(existing.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const next: (typeof schema.siteAuthRule.$inferInsert)[] = [];
    const audit: Record<string, unknown>[] = [];
    for (const [position, rule] of input.rules.entries()) {
      for (const domain of rule.scope.domains)
        if (!domains.has(domain))
          fail("AUTH_DOMAIN_UNKNOWN", `${domain} is not a domain of the site`, { domain });
      if (rule.forward) {
        const host = forwardUrlHost(rule.forward.url);
        const range = forbiddenOriginRange(host, allowed);
        if (range)
          fail(
            "ORIGIN_ADDRESS_FORBIDDEN",
            `authentication service address ${host} is in the special-purpose range ${range}, which the platform does not allow`,
            { address: host, range },
          );
      }
      const old = rule.id ? byId.get(rule.id) : undefined;
      if (rule.id && (!old || seen.has(rule.id)))
        fail("AUTH_RULE_NOT_FOUND", "access authentication rule not found");
      const id = old?.id ?? randomUUID();
      seen.add(id);
      const previous = old
        ? { kind: old.kind, secret: openAuthSecret(masterKey, old.id, old.secretEnvelope) }
        : null;
      const secret = await nextSecret(rule, previous);
      const unchanged =
        !!old &&
        old.kind === rule.kind &&
        JSON.stringify(secret) === JSON.stringify(previous?.secret ?? null);
      const secretVersion = secret
        ? unchanged
          ? old.secretVersion
          : (old?.secretVersion ?? 0) + 1
        : 0;
      next.push({
        id,
        siteId: site.id,
        position,
        kind: rule.kind,
        enabled: rule.enabled,
        scope: {
          domains: set(rule.scope.domains),
          pathPrefixes: set(rule.scope.pathPrefixes),
          extensions: set(rule.scope.extensions),
          excludePathPrefixes: set(rule.scope.excludePathPrefixes),
        },
        settings: settingsOf(rule, secret),
        secretEnvelope: secret
          ? unchanged
            ? old.secretEnvelope
            : sealAuthSecret(masterKey, id, secret)
          : null,
        secretVersion,
        ...(old ? { createdAt: old.createdAt } : {}),
      });
      audit.push({
        id,
        kind: rule.kind,
        enabled: rule.enabled,
        ...secretSummary(secret),
        ...(secret ? { secretChanged: !unchanged } : {}),
      });
    }
    // Positions are unique per site: the rules are written anew.
    await tx.delete(schema.siteAuthRule).where(eq(schema.siteAuthRule.siteId, site.id));
    if (next.length) await tx.insert(schema.siteAuthRule).values(next);
    const updatedAt = new Date(Math.max(Date.now(), (site.authUpdatedAt?.getTime() ?? 0) + 1));
    const [updated] = await tx
      .update(schema.site)
      .set({ authUpdatedAt: updatedAt })
      .where(eq(schema.site.id, site.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_auth_updated", params: { site: site.name } },
      actor: ctx.actor,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.auth_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: {
        from: existing.map((row) => ({ id: row.id, kind: row.kind, enabled: row.enabled })),
        to: audit,
        revision: revision.revision,
      },
    });
    return {
      siteId: site.id,
      rules: (await loadRules(tx, site.id)).map(toAuthRuleDto),
      updatedAt: updatedAt.toISOString(),
    };
  });
}

/** 16 random hexadecimal digits (kind A's rand). */
const randomRand = () => randomBytes(8).toString("hex");

/**
 * Signs a URL with a URL rule's primary key (ADR-0038): valid for
 * validitySeconds (at most the rule's validity V, default V) from now, by
 * taking ts = now - (V - validitySeconds). The URL is a path or an http(s)
 * URL of one of the site's domains; nothing is stored or sent to nodes. The
 * audit entry names the rule, the path and the expiry, never the signature.
 */
export async function signAuthUrl(
  db: Database,
  masterKey: MasterKey,
  input: SignUrlInput,
  ctx: { actor: Actor },
  now = Date.now(),
): Promise<SignedUrl> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id);
    const [row] = await tx
      .select()
      .from(schema.siteAuthRule)
      .where(
        and(eq(schema.siteAuthRule.id, input.ruleId), eq(schema.siteAuthRule.siteId, site.id)),
      );
    if (!row) fail("AUTH_RULE_NOT_FOUND", "access authentication rule not found");
    const kind = row.kind as AuthKind;
    if (!isUrlAuthKind(kind)) fail("AUTH_RULE_NOT_URL", "only URL authentication rules sign URLs");
    const secret = openAuthSecret(masterKey, row.id, row.secretEnvelope);
    const key = secret && "keys" in secret ? secret.keys[0] : undefined;
    if (!key) fail("AUTH_KEY_REQUIRED", "the rule has no signing key");
    const dto = toAuthRuleDto(row);
    const settings = dto.url as NonNullable<AuthRule["url"]>;
    const validity = input.validitySeconds ?? settings.validitySeconds;
    if (validity > settings.validitySeconds)
      fail("AUTH_SIGN_VALIDITY", "the URL cannot be valid for longer than the rule allows", {
        max: settings.validitySeconds,
      });

    let origin = "";
    let target: URL;
    try {
      if (input.url.startsWith("/")) {
        if (input.url.startsWith("//")) throw new Error("scheme-relative");
        target = new URL(input.url, "http://placeholder.invalid");
      } else {
        target = new URL(input.url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
        if (target.username || target.password) throw new Error("credentials");
        const matcher = hostMatcher(
          (await formattedSiteDomains(tx, site.id)).map((formatted) => {
            const kind = siteDomainKind(formatted);
            const prefix = { exact: 0, wildcard: 2, suffix: 1, regex: 1 }[kind];
            return { kind, name: formatted.slice(prefix), value: true };
          }),
        );
        if (!matchHost(matcher, target.hostname)) throw new Error("host");
        origin = target.origin;
      }
    } catch {
      fail("AUTH_SIGN_URL_INVALID", "the URL is not a path or a URL of the site");
    }
    const ts = Math.floor(now / 1000) - (settings.validitySeconds - validity);
    const signed = signUri(kind, `${target.pathname}${target.search}${target.hash}`, {
      key,
      ts,
      rand: randomRand(),
      signParam: settings.signParam,
      timeParam: settings.timeParam,
    });
    const expiresAt = new Date((ts + settings.validitySeconds) * 1000).toISOString();
    await recordAudit(tx, ctx.actor, {
      action: "site.auth_sign_url",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { ruleId: row.id, path: target.pathname, expiresAt },
    });
    return { url: `${origin}${signed}`, expiresAt };
  });
}

/**
 * Requests access authentication refused on the site over a range
 * (MinuteStats.auth_failures); `unsupportedNodes` counts the active nodes of
 * the site's cluster that do not count them (no access-auth-v1).
 */
export async function authFailures(
  db: Database,
  query: { id: string; range: AnalyticsRange },
  now = Date.now(),
): Promise<AuthFailures> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const [row] = await db
    .select({
      requests: sql<number>`coalesce(sum(${stats.authFailures}), 0)::bigint`.mapWith(Number),
    })
    .from(stats)
    .where(
      and(
        eq(stats.siteId, site.id),
        sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
        sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
      ),
    );
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    requests: row?.requests ?? 0,
    unsupportedNodes: nodes.filter(
      (node) => !nodeSupportsFeature(node.features, ACCESS_AUTH_FEATURE),
    ).length,
  };
}
