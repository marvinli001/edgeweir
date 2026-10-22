import { clone, create } from "@bufbuild/protobuf";
import {
  type EdgeRule,
  EdgeRuleSchema,
  type NodeConfig,
  QueryParamSchema,
  type RuleAction,
  RuleActionSchema,
  type RuleExpression,
} from "@edgeweir/proto";
import { type Expression, type Phase, parseValueExpression, phases } from "@edgeweir/rule-engine";
import type { RuleModel } from "./models";
import { byString, sortedSet } from "./sort";

/** Whether a kind keeps the request's query string by default (rewrites do, redirects not). */
const queryDefault = (kind: string) => kind === "rewrite";

/**
 * A rule action as nodes receive it: only the fields its kind carries.
 * preserve_query is set only where it differs from the kind's default
 * (redirects drop the query, rewrites keep it), set_query is sorted by name
 * and remove_query sorted without duplicates, so that rules without the
 * rules-v2 fields encode as before.
 */
function compileAction(phase: string, a: RuleModel["action"]): RuleAction {
  const redirectOrRewrite = a.kind === "redirect" || a.kind === "rewrite";
  const header = (a.kind === "request_header" || a.kind === "response_header") && !a.remove;
  const value = (source: string | undefined) =>
    source ? parseValueExpression(source, phase as Phase) : undefined;
  return create(RuleActionSchema, {
    kind: a.kind,
    value: a.value,
    header: a.header,
    statusCode: a.statusCode,
    limit: a.limit,
    windowSeconds: a.windowSeconds,
    key: a.key,
    cacheBypass: a.cacheBypass,
    forceHttps: a.forceHttps,
    gzip: a.gzip,
    remove: a.remove,
    challenge: a.kind === "challenge" ? (a.type ?? "") : "",
    brotli: a.brotli,
    zstd: a.zstd,
    websocket: a.websocket,
    underAttack: a.underAttack,
    ccEnabled: a.ccEnabled,
    ccMaxLevel: a.ccMaxLevel ?? "",
    originConnectTimeoutMs: a.originConnectTimeoutMs ?? 0,
    originSendTimeoutMs: a.originSendTimeoutMs ?? 0,
    originReadTimeoutMs: a.originReadTimeoutMs ?? 0,
    logSampleRate: a.logSampleRate,
    target: redirectOrRewrite ? value(a.target) : header ? value(a.expression) : undefined,
    preserveQuery:
      redirectOrRewrite && a.preserveQuery !== undefined && a.preserveQuery !== queryDefault(a.kind)
        ? a.preserveQuery
        : undefined,
    setQuery: [...(a.setQuery ?? [])].sort(byString((param) => param.name)).map((param) =>
      create(QueryParamSchema, {
        name: param.name,
        value: param.value,
        expression: value(param.expression),
      }),
    ),
    removeQuery: sortedSet(a.removeQuery),
    originGroup: a.originGroup ?? "",
    hostHeader: a.hostHeader ?? "",
    sni: a.sni ?? "",
    port: a.port ?? 0,
    compression: a.kind === "compression" ? [...(a.algorithms ?? [])] : [],
    append: a.kind === "response_header" && header && a.append === true,
    requestBodyLimit:
      a.kind === "config" && a.requestBodyLimit !== undefined
        ? BigInt(a.requestBodyLimit)
        : undefined,
    // waf-v2: only the kind's own fields, defaults as zero values.
    banSeconds: a.kind === "ban" || a.kind === "rate_limit" ? (a.banSeconds ?? 0) : 0,
    banScope: a.kind === "ban" && a.banScope === "platform" ? "platform" : "",
    banPrefixV4: a.kind === "ban" && a.banPrefixV4 && a.banPrefixV4 !== 32 ? a.banPrefixV4 : 0,
    banPrefixV6: a.kind === "ban" && a.banPrefixV6 && a.banPrefixV6 !== 64 ? a.banPrefixV6 : 0,
    contentType: a.kind === "respond" && !a.errorPage ? (a.contentType ?? "") : "",
    body: a.kind === "respond" && !a.errorPage ? (a.body ?? "") : "",
    errorPage: a.kind === "respond" && a.errorPage === true,
    skip: a.kind === "skip" ? sortedSet(a.skip) : [],
    accessLog: a.kind === "log" && a.accessLog === true,
    crs: a.kind === "config" ? (a.crs ?? "") : "",
  });
}

export function compileRules(rules: RuleModel[] = []): EdgeRule[] {
  return [...rules]
    .sort(
      (a, b) =>
        phases.indexOf(a.phase as (typeof phases)[number]) -
        phases.indexOf(b.phase as (typeof phases)[number]),
    )
    .map((rule) =>
      rule.compiled
        ? clone(EdgeRuleSchema, rule.compiled)
        : create(EdgeRuleSchema, {
            id: rule.id,
            phase: rule.phase,
            expression: rule.expression,
            action: compileAction(rule.phase, rule.action),
          }),
    );
}

/** A compiled expression as the rule engine's Expression (empty when unset). */
export function expressionOf(e: RuleExpression | undefined): Expression {
  return {
    op: e?.op ?? "",
    field: e?.field ?? "",
    valueType: e?.valueType ?? "",
    value: e?.value ?? "",
    values: [...(e?.values ?? [])],
    children: (e?.children ?? []).map(expressionOf),
  };
}

/**
 * The model of a compiled rule, which compileRules keeps as it is: a stored
 * rule the current validator refuses keeps its last compiled form. The
 * action carries what usesChallenges reads.
 */
export function ruleModelOf(rule: EdgeRule): RuleModel {
  return {
    id: rule.id,
    phase: rule.phase,
    expression: expressionOf(rule.expression),
    action: {
      kind: rule.action?.kind ?? "",
      type: rule.action?.challenge,
      underAttack: rule.action?.underAttack,
    },
    compiled: rule,
  };
}

/**
 * Every expression of a compiled configuration: rule conditions, redirect
 * and rewrite targets and cache rule conditions, platform rules first.
 */
export function configExpressions(
  config: Pick<NodeConfig, "platformRules" | "sites">,
): RuleExpression[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  return [
    ...rules.flatMap((rule) => [
      rule.expression,
      rule.action?.target,
      ...(rule.action?.setQuery ?? []).map((param) => param.expression),
    ]),
    ...config.sites.flatMap((site) => site.cacheRules.map((rule) => rule.match?.condition)),
  ].filter((expression): expression is RuleExpression => !!expression);
}
