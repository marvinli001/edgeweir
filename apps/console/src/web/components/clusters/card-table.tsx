import type * as React from "react";
import { markOverflow } from "@/components/data-table";
import { cn } from "@/lib/utils";

/**
 * A table that closes the card it sits in: the header's well strip runs to the card's edges and the
 * first and last cells line up with the card's padding. The card's last child, in a Card with
 * `pb-0` (infrastructure pages: DNS records and revisions, bindings, the scheduling preview).
 * `pinFirstColumn` keeps the first column in place while the table scrolls sideways (narrow
 * screens), as in DataTable: the table's first header and body cells carry `cell-pinned`.
 */
export function CardTable({
  className,
  pinFirstColumn = false,
  ...props
}: React.ComponentProps<"div"> & { pinFirstColumn?: boolean }) {
  return (
    <div
      ref={pinFirstColumn ? markOverflow : undefined}
      data-slot="card-table"
      className={cn(
        "border-t border-edge [&_td:first-child]:pl-(--card-spacing) [&_td:last-child]:pr-(--card-spacing) [&_th:first-child]:pl-(--card-spacing) [&_th:last-child]:pr-(--card-spacing)",
        // A pinned header cell is as opaque as the well strip it sits in.
        pinFirstColumn && "[&_th]:[--cell-bg:var(--well)]",
        className,
      )}
      {...props}
    />
  );
}
