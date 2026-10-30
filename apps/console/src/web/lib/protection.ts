import {
  type CcLevel,
  type CHALLENGE_OUTCOME_KINDS,
  CHALLENGE_PROVIDER_KINDS,
  type ChallengeKind,
  type ChallengeProviderKind,
  type ChallengeType,
  type SecurityEventKind,
  type WafMode,
} from "@edgeweir/contract";
import { m } from "@/lib/i18n";

/** Challenge kinds: the types (also the CC levels above normal) and the managed challenge. */
export const challengeLabel = (type: ChallengeKind) =>
  ({
    cookie302: m.challenge_cookie302,
    js: m.challenge_js,
    pow: m.challenge_pow,
    captcha: m.challenge_captcha,
    managed: m.challenge_managed,
  })[type]();

/** The order selects offer challenge kinds in: the current ones first, then the legacy ones. */
const CHALLENGE_KIND_ORDER = [
  "managed",
  "pow",
  "captcha",
  "js",
  "cookie302",
] as const satisfies readonly ChallengeKind[];

/** Challenge kind options in select order; `managed` only with `managed` true. */
export const challengeKindOptions = (managed: boolean) =>
  CHALLENGE_KIND_ORDER.filter((kind) => managed || kind !== "managed").map((kind) => ({
    value: kind,
    label: challengeLabel(kind),
  }));

/** Widgets of the interactive challenge. */
export const providerKindLabel = (kind: ChallengeProviderKind) =>
  ({
    builtin: m.challenge_provider_builtin,
    turnstile: m.challenge_provider_turnstile,
    recaptcha_v2: m.challenge_provider_recaptcha_v2,
    recaptcha_v3: m.challenge_provider_recaptcha_v3,
    recaptcha_enterprise: m.challenge_provider_recaptcha_enterprise,
    tencent: m.challenge_provider_tencent,
    aliyun: m.challenge_provider_aliyun,
    geetest: m.challenge_provider_geetest,
  })[kind]();

/** A kind of the challenge outcome stats: `captcha` there is the built-in image. */
export const outcomeKindLabel = (kind: (typeof CHALLENGE_OUTCOME_KINDS)[number]) =>
  kind === "captcha"
    ? m.challenge_provider_builtin()
    : (CHALLENGE_PROVIDER_KINDS as readonly string[]).includes(kind)
      ? providerKindLabel(kind as ChallengeProviderKind)
      : challengeLabel(kind as ChallengeKind);

export const levelLabel = (level: CcLevel | string) =>
  level === "normal" || !level
    ? m.level_normal()
    : ["cookie302", "js", "pow", "captcha"].includes(level)
      ? challengeLabel(level as ChallengeType)
      : level;

export const eventKindLabel = (kind: SecurityEventKind) =>
  ({
    site_level: m.security_event_site_level,
    path_level: m.security_event_path_level,
    ip_banned: m.security_event_ip_banned,
  })[kind]();

/** The trigger of a CC decision; unknown metrics show as sent. */
export const metricLabel = (metric: string) =>
  (
    ({
      site_qps: m.metric_site_qps,
      url_qps: m.metric_url_qps,
      ip_qps: m.metric_ip_qps,
      origin_error_rate: m.metric_origin_error_rate,
      cooldown: m.metric_cooldown,
      unknown_host_requests: m.metric_unknown_host_requests,
      // waf-v2 and challenge-v2 bans.
      rate_limit: m.metric_rate_limit,
      challenge_failures: m.metric_challenge_failures,
    }) as Record<string, (() => string) | undefined>
  )[metric]?.() ?? metric;

export const wafModeLabel = (mode: WafMode) =>
  ({ off: m.waf_mode_off, detect: m.waf_mode_detect, block: m.waf_mode_block })[mode]();
