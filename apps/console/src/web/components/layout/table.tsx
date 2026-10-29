import type * as React from "react";
import { activateRow } from "@/lib/row-link";
import { cn } from "@/lib/utils";

/*
 * Dense tables (tokens.md): the header row on the faint fill with secondary 13px labels, 44px rows
 * with hairline dividers, a hover tint, the brand tint when selected; cells 13px with tabular
 * figures (index.css). The panel around it carries the border; rows never lift.
 */

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-dense", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-well [&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

/**
 * A row whose cells hold a row link (`rowLink` from lib/row-link) opens it on a click anywhere in
 * the row (the pointer, and the tint while its link has keyboard focus, say so); other rows ignore
 * the handlers.
 */
function TableRow({ className, onClick, onAuxClick, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors duration-100 hover:bg-wash has-aria-expanded:bg-wash data-[state=selected]:bg-tint-primary has-[[data-row-link]]:cursor-pointer has-[[data-row-link]:focus-visible]:bg-wash",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        activateRow(event);
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        activateRow(event);
      }}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-4 text-left align-middle text-dense font-normal whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-11 px-4 py-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
