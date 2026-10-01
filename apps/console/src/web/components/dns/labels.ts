import type { DnsBinding, DnsRevision } from "@edgeweir/contract";
import { m } from "@/lib/i18n";

/** Messages looked up by catalog data (provider ids, field keys, option values, error codes). */
const messages = m as unknown as Record<string, ((inputs?: object) => string) | undefined>;
const key = (prefix: string, value: string) => `${prefix}${value.replace(/[^a-z0-9]+/gi, "_")}`;

export const providerLabel = (id: string) => messages[key("dns_provider_", id)]?.() ?? id;
export const fieldLabel = (field: string) => messages[key("dns_field_", field)]?.() ?? field;
/** Select options are technical values ("ovh-eu", "hmac-sha256") unless a label exists. */
export const optionLabel = (value: string) =>
  messages[key("dns_option_", value.toLowerCase())]?.() ?? value;
/** A DNS revision's error code ("dns_auth_failed") in words. */
export const revisionError = (code: string) =>
  code ? (messages[key("dns_error_", code)]?.() ?? code) : "";

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
