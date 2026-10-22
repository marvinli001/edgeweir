import { expressionIssue, type FeatureAvailability, type RuleDto } from "@edgeweir/contract";
import type { compressionCodings, Phase } from "@edgeweir/rule-engine";
import * as React from "react";
import type * as z from "zod";
import { expressionReason } from "@/lib/expressions";
import { m } from "@/lib/i18n";
import type { Kind } from "@/lib/rule-actions";

export type Coding = (typeof compressionCodings)[number];

export const phaseLabel = (phase: Phase) =>
  ({
    "request-transform": m.rules_phase_request,
    redirect: m.rules_phase_redirect,
    config: m.rules_phase_config,
    "waf-custom": m.rules_phase_waf,
    ratelimit: m.rules_phase_rate,
    cache: m.rules_phase_cache,
    origin: m.rules_phase_origin,
    "response-transform": m.rules_phase_response,
    compression: m.rules_phase_compression,
  })[phase]();
/** Action kinds of each phase; the first is what a new rule of the phase starts with. */
export const kinds: Record<Phase, readonly Kind[]> = {
  "request-transform": ["rewrite", "request_header"],
  redirect: ["redirect"],
  config: ["config"],
  "waf-custom": ["block", "log", "allow", "challenge", "ban", "respond", "close", "skip"],
  ratelimit: ["rate_limit"],
  cache: ["config"],
  origin: ["request_header", "origin"],
  "response-transform": ["response_header"],
  compression: ["compression"],
};
/** Kinds only nodes with the rule engine extensions (rules-v2) run. */
export const v2Kinds: ReadonlySet<Kind> = new Set(["origin", "compression"]);
export const actionLabel = (kind: Kind) =>
  ({
    block: m.rules_block,
    log: m.rules_log,
    allow: m.rules_allow,
    challenge: m.rules_challenge,
    redirect: m.rules_redirect,
    rewrite: m.rules_rewrite,
    request_header: m.rules_request_header,
    response_header: m.rules_response_header,
    config: m.rules_config,
    rate_limit: m.rules_rate,
    origin: m.rules_origin,
    compression: m.rules_compression,
    ban: m.rules_ban,
    respond: m.rules_respond,
    close: m.rules_close,
    skip: m.rules_skip,
  })[kind]();
export const codingLabel = (coding: Coding) =>
  ({ zstd: m.compression_zstd, br: m.compression_brotli, gzip: m.cert_gzip })[coding]();
export const HEADER_KEY = "http.request.headers.";
/** Rate limit keys offered in the select; a request header is the last choice. */
export const keyChoice = (key: string) => (key.startsWith(HEADER_KEY) ? "header" : key);
/** The origin group select's value for the default group (not a valid group name). */
export const DEFAULT_GROUP = ":default";
/** Select value of an unset config override. */
export const UNCHANGED = "unchanged";

/** Labels of the action fields an issue can point at (the form's own labels). */
const actionFieldLabels: Record<string, () => string> = {
  target: m.rules_target,
  // A header's value expression (rules-v3) is its value.
  expression: m.rules_value,
  append: m.rules_append_header,
  header: m.rules_header,
  setQuery: m.rules_set_query,
  removeQuery: m.rules_remove_query,
  statusCode: m.rules_status,
  limit: m.rules_limit,
  windowSeconds: m.rules_window,
  key: m.rules_key,
  type: m.rules_challenge_type,
  originGroup: m.rules_origin_group,
  hostHeader: m.site_form_host_header,
  sni: m.site_origin_sni,
  port: m.site_form_port,
  algorithms: m.rules_compression,
  ccMaxLevel: m.rules_cc_max_level,
  originConnectTimeoutMs: m.rules_connect_timeout,
  originSendTimeoutMs: m.rules_send_timeout,
  originReadTimeoutMs: m.rules_read_timeout,
  logSampleRate: m.rules_log_sample_rate,
  requestBodyLimit: m.rules_request_body_limit,
  banScope: m.rules_ban_scope,
  banPrefixV4: m.rules_ban_prefix_v4,
  banPrefixV6: m.rules_ban_prefix_v6,
  contentType: m.rules_respond_type,
  body: m.rules_respond_body,
  errorPage: m.rules_respond_error_page,
  skip: m.rules_skip_targets,
  crs: m.rules_config_crs,
};

/** Whether the site's cluster lacks site-content-v1 (config rules' body limit). */
export const ContentLock = React.createContext(false);
/**
 * What the site's cluster lacks of G14 (waf-v2 actions and settings, rules-body-v1 body fields,
 * challenge-v2 crawler fields), and whether these are platform rules (only they ban everywhere).
 */
interface Locks {
  wafV2: boolean;
  body: boolean;
  bot: boolean;
  platform: boolean;
}
export const LocksContext = React.createContext<Locks>({
  wafV2: false,
  body: false,
  bot: false,
  platform: false,
});
/** The label of the field an issue of `row` points at. */
function issueField(row: RuleDto, path: readonly PropertyKey[]): string {
  const [head, field] = path;
  if (head === "name") return m.rules_name();
  if (head === "expression") return m.rules_expression();
  if (head !== "action" || typeof field !== "string") return m.rules_action();
  // A ban's duration, or a rate limit's ban over the limit.
  if (field === "banSeconds")
    return row.action.kind === "rate_limit" ? m.rules_rate_ban() : m.rules_ban_seconds();
  // Redirects and rewrites label their static value as the target.
  if (field === "value")
    return row.action.kind === "redirect" || row.action.kind === "rewrite"
      ? m.rules_target()
      : m.rules_value();
  return (actionFieldLabels[field] ?? m.rules_action)();
}

/** Why a rule cannot be saved: the field, and where and why an expression fails. */
export function ruleIssueText(row: RuleDto, issue: z.core.$ZodIssue | undefined): string {
  const field = issueField(row, issue?.path ?? []);
  const failure = issue ? expressionIssue(issue) : null;
  return failure
    ? m.rules_check_rule_expression({
        name: row.name,
        field,
        position: failure.position + 1,
        reason: expressionReason(failure),
      })
    : m.rules_check_rule({ name: row.name, field });
}

export type SiteFeatures = Record<
  "rulesV2" | "rulesV3" | "siteContent" | "wafV2" | "rulesBody" | "challengeV2",
  FeatureAvailability
>;
