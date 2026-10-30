import { CHALLENGE_PROVIDER_KINDS, type StatsDimensions } from "@edgeweir/contract";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { formatNumber, formatPercent, m } from "@/lib/i18n";
import { outcomeKindLabel } from "@/lib/protection";

type ChallengeKindRow = StatsDimensions["challenges"]["byKind"][number];

/** Kinds whose fallback count means something: the third-party widgets (to the built-in image). */
const PROVIDER_OUTCOME_KINDS: ReadonlySet<string> = new Set(
  CHALLENGE_PROVIDER_KINDS.filter((kind) => kind !== "builtin"),
);

/**
 * Each challenge kind's outcomes: escalations only the managed challenge has (to the interactive
 * one), fallbacks only providers (to the built-in image).
 */
export function ChallengeKindsTable({ rows }: { rows: readonly ChallengeKindRow[] }) {
  const count = (value: number, shown: boolean) => (shown ? formatNumber(value) : "—");
  return (
    <div
      className="overflow-hidden rounded-md faint-well [--cell-bg:var(--well)]"
      data-testid="challenges-by-kind"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="cell-pinned">{m.challenges_kind()}</TableHead>
            <TableHead className="text-right">{m.challenges_issued()}</TableHead>
            <TableHead className="text-right">{m.challenges_passed()}</TableHead>
            <TableHead className="text-right">{m.challenges_failed()}</TableHead>
            <TableHead className="text-right">{m.challenges_rate()}</TableHead>
            <TableHead className="text-right">{m.challenges_escalated()}</TableHead>
            <TableHead className="text-right">{m.challenges_fallback()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.kind} data-testid="challenges-kind-row" data-kind={row.kind}>
              <TableCell className="cell-pinned">{outcomeKindLabel(row.kind)}</TableCell>
              <TableCell className="text-right">{formatNumber(row.issued)}</TableCell>
              <TableCell className="text-right">{formatNumber(row.passed)}</TableCell>
              <TableCell className="text-right">{formatNumber(row.failed)}</TableCell>
              <TableCell className="text-right">
                {row.issued > 0
                  ? formatPercent(Math.min(100, (row.passed / row.issued) * 100))
                  : "—"}
              </TableCell>
              <TableCell className="text-right">
                {count(row.escalated, row.kind === "managed")}
              </TableCell>
              <TableCell className="text-right">
                {count(row.fallback, PROVIDER_OUTCOME_KINDS.has(row.kind))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
