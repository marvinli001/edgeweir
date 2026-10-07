import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A table that closes the card it sits in: the header's well strip runs to the card's edges and the
 * first and last cells line up with the card's padding. The card's last child, in a Card with
 * `pb-0` (infrastructure pages: DNS records and revisions, bindings, the scheduling preview).
 */
export function CardTable({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-table"
      className={cn(
        "border-t border-edge [&_td:first-child]:pl-(--card-spacing) [&_td:last-child]:pr-(--card-spacing) [&_th:first-child]:pl-(--card-spacing) [&_th:last-child]:pr-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}
