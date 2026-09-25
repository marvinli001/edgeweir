import { m } from "@/paraglide/messages.js";
import { getLocale, type Locale, locales, setLocale } from "@/paraglide/runtime.js";

export { getLocale, type Locale, locales, m, setLocale };

export const localeLabels: Record<Locale, () => string> = {
  "zh-CN": m.language_zh_cn,
  en: m.language_en,
};

/** Human-readable relative time ("3 分钟前" / "3m ago"). */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return m.common_never();
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return m.common_just_now();
  if (seconds < 60) return m.common_seconds_ago({ count: seconds });
  if (seconds < 3600) return m.common_minutes_ago({ count: Math.floor(seconds / 60) });
  if (seconds < 86400) return m.common_hours_ago({ count: Math.floor(seconds / 3600) });
  return m.common_days_ago({ count: Math.floor(seconds / 86400) });
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "medium" }).format(
    new Date(iso),
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

/** 0–100 → "87.5%" in the current locale. */
export function formatPercent(value: number): string {
  return new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 }).format(
    value / 100,
  );
}
