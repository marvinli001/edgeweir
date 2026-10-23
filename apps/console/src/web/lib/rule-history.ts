import type { RuleVersion } from "@edgeweir/contract";

/** A rule as a version keeps it. */
export type RuleState = RuleVersion["rule"];
export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Fields of a rule in the order a comparison shows them. */
export const ruleFields = ["name", "enabled", "phase", "expression", "action"] as const;
export type RuleField = (typeof ruleFields)[number];

/** JSON with sorted object keys, indented: equal actions give equal text. */
export function actionText(action: unknown): string {
  return JSON.stringify(
    action,
    (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
    2,
  );
}

const fieldText = (rule: RuleState, field: RuleField) =>
  field === "action" ? actionText(rule.action) : String(rule[field]);

/** The fields that differ between two states of a rule. */
export function changedFields(from: RuleState, to: RuleState): RuleField[] {
  return ruleFields.filter((field) => fieldText(from, field) !== fieldText(to, field));
}

/** A line diff (longest common subsequence) from `before` to `after`. */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const rows = before.length,
    cols = after.length;
  // common[i * width + j]: the longest common subsequence of before[i..] and after[j..].
  const width = cols + 1;
  const common = new Uint32Array((rows + 1) * width);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < rows || j < cols) {
    const removed = before[i],
      added = after[j];
    if (removed !== undefined && removed === added) {
      lines.push({ kind: "same", text: removed });
      i++;
      j++;
    } else if (removed !== undefined && (added === undefined || at(i + 1, j) >= at(i, j + 1))) {
      lines.push({ kind: "removed", text: removed });
      i++;
    } else {
      lines.push({ kind: "added", text: added ?? "" });
      j++;
    }
  }
  return lines;
}
