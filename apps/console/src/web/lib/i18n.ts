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

/** Time of day, hours and minutes ("14:05"). */
export function formatClockTime(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
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

/** Short counts for stats and axes ("55.83万" / "558.28K"). */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat(getLocale(), {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function scaled(value: number, units: readonly string[]): string {
  let index = 0;
  let scaledValue = value;
  while (Math.abs(scaledValue) >= 1000 && index < units.length - 1) {
    scaledValue /= 1000;
    index++;
  }
  const number = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(
    scaledValue,
  );
  // A no-break space keeps number and unit on one line (chart ticks wrap at spaces).
  return `${number}\u00a0${units[index]}`;
}

/** Data volume in decimal units ("189.94 GB"). */
export function formatBytes(bytes: number): string {
  return scaled(bytes, ["B", "KB", "MB", "GB", "TB", "PB"]);
}

/** Bandwidth from bytes per second, in bits ("12.4 Mbps"). */
export function formatBitRate(bytesPerSecond: number): string {
  return scaled(bytesPerSecond * 8, ["bps", "Kbps", "Mbps", "Gbps", "Tbps"]);
}

/** Date and time of a chart point ("9月25日 18:25" / "Sep 25, 18:25"). */
export function formatChartTime(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Axis tick of a chart point: the time of day (the date at midnight), or the date for long ranges. */
export function formatAxisTime(iso: string, days: boolean): string {
  const date = new Date(iso);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  return new Intl.DateTimeFormat(
    getLocale(),
    days || midnight
      ? { month: "numeric", day: "numeric" }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  ).format(date);
}
