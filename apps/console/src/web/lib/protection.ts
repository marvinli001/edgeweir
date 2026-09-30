import type {
  CcLevel,
  ChallengeType,
  FeatureAvailability,
  SecurityEventKind,
  WafMode,
} from "@edgeweir/contract";
import { m } from "@/lib/i18n";

/** Challenge types, which are also the CC levels above normal. */
export const challengeLabel = (type: ChallengeType) =>
  ({
    cookie302: m.challenge_cookie302,
    js: m.challenge_js,
    pow: m.challenge_pow,
    captcha: m.challenge_captcha,
  })[type]();

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
    }) as Record<string, (() => string) | undefined>
  )[metric]?.() ?? metric;

export const wafModeLabel = (mode: WafMode) =>
  ({ off: m.waf_mode_off, detect: m.waf_mode_detect, block: m.waf_mode_block })[mode]();

/** One line on why a feature cannot be turned on for a site now. */
export const unavailableReason = (availability: FeatureAvailability) =>
  availability.reason === "platform"
    ? m.feature_unavailable_platform()
    : m.feature_unavailable_nodes();
