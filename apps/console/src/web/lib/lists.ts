import { validHostHeader } from "@edgeweir/rule-engine";
import { m } from "@/lib/i18n";

/** "a, b c" → ["a", "b", "c"]. */
export const splitList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * "Check “<label>”" for a validation issue's field when it has a label, else the generic bad
 * request text.
 */
export function checkFieldText(
  field: PropertyKey | undefined,
  labels: Partial<Record<PropertyKey, () => string>>,
): string {
  const label = field === undefined ? undefined : labels[field];
  return label ? m.common_check_field({ field: label() }) : m.error_bad_request();
}

/** A Host header nodes refuse (they skip the origin or drop the rule); empty keeps the default. */
export const invalidHostHeader = (value: string) => {
  const host = value.trim();
  return host !== "" && !validHostHeader(host);
};
