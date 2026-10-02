import {
  type DnsBinding,
  type DnsResolutionLine,
  type DnsRevision,
  schedulingAction,
} from "@edgeweir/contract";
import { m } from "@/lib/i18n";
import { actionLabel } from "@/lib/scheduling";

const schedulingActions = schedulingAction.options;

/** Messages looked up by catalog data (provider ids, field keys, option values, error codes). */
const messages = m as unknown as Record<string, ((inputs?: object) => string) | undefined>;
const key = (prefix: string, value: string) => `${prefix}${value.replace(/[^a-z0-9]+/gi, "_")}`;

export const providerLabel = (id: string) => messages[key("dns_provider_", id)]?.() ?? id;
export const fieldLabel = (field: string) => messages[key("dns_field_", field)]?.() ?? field;
/** Select options are technical values ("ovh-eu", "hmac-sha256") unless a label exists. */
export const optionLabel = (value: string) =>
  messages[key("dns_option_", value.toLowerCase())]?.() ?? value;
/** A DNS revision's error code ("dns_auth_failed") and its parameters in words. */
export const revisionError = (code: string, params: Record<string, string> = {}) =>
  code ? (messages[key("dns_error_", code)]?.({ name: "", ...params }) ?? code) : "";

export const modeLabel = (mode: DnsBinding["mode"]) =>
  ({ off: m.dns_mode_off, manual: m.dns_mode_manual, auto: m.dns_mode_auto })[mode]();

export const statusLabel = (value: DnsRevision["status"]) =>
  ({
    pending: m.dns_pending,
    applied: m.dns_applied,
    failed: m.dns_failed,
    superseded: m.dns_superseded,
    blocked: m.dns_blocked,
  })[value]?.() ?? value;

export const resolutionLineLabel = (line: DnsResolutionLine) =>
  ({
    default: m.dns_resolution_line_default,
    telecom: m.dns_resolution_line_telecom,
    unicom: m.dns_resolution_line_unicom,
    mobile: m.dns_resolution_line_mobile,
    edu: m.dns_resolution_line_edu,
    overseas: m.dns_resolution_line_overseas,
  })[line]?.() ?? line;

const SCHEDULING_EVENTS: Record<string, () => string> = {
  activated: () => m.scheduling_event_activated(),
  recovered: () => m.scheduling_event_recovered(),
};

/**
 * Why a DNS revision was published, in the current locale; scheduling
 * revisions add the action and whether it took effect or recovered.
 * Unknown codes are shown as they are.
 */
export function dnsRevisionReason(revision: Pick<DnsRevision, "reason" | "reasonParams">): string {
  const params = Object.fromEntries(
    Object.entries(revision.reasonParams).map(([name, value]) => [name, String(value)]),
  );
  const fn = messages[`dns_revision_reason_${revision.reason}`];
  if (!fn) return revision.reason;
  const text = fn(params);
  if (revision.reason !== "scheduling") return text;
  const action = schedulingActions.find((a) => a === params.action);
  const event = params.event ? SCHEDULING_EVENTS[params.event] : undefined;
  return [text, ...(action ? [actionLabel(action)] : []), ...(event ? [event()] : [])].join(" · ");
}
